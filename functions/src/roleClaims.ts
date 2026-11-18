import * as firestore from 'firebase-admin/firestore';
import * as auth from 'firebase-admin/auth';
import * as functions from 'firebase-functions/v1';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = firestore.getFirestore();
const authClient = auth.getAuth();

/** The only job type processed by the role-claim worker. */
export const ROLE_CLAIM_JOB_TYPE = 'roleClaimPublication';

/** The only role-claim job state processed by the worker. */
export const ROLE_CLAIM_JOB_STATUS_PENDING = 'pending';

/** Reads the monotonic revision of a live role. */
export function roleRevisionOf(snapshot: firestore.DocumentSnapshot): number {
  const revision = Number(snapshot.get('roleRevision') || 0);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

/** The durable role-claim publication job for one account. */
export function roleClaimJobRef(
  uid: string,
): firestore.DocumentReference {
  return db.collection('roleClaimJobs').doc(uid);
}

/**
 * Records a role-claim publication in the same transaction as a role change.
 *
 * The job is keyed by uid, so the newest role revision replaces an older
 * pending publication. The worker always reads the live profile and can
 * never publish a stale revision from the job document.
 */
export function enqueueRoleClaimPublication(
  transaction: firestore.Transaction,
  uid: string,
  role: string,
  revision: number,
  revokeNonAdminSessions: boolean,
): void {
  transaction.set(
    roleClaimJobRef(uid),
    {
      type: ROLE_CLAIM_JOB_TYPE,
      uid,
      role,
      roleRevision: revision,
      revokeNonAdminSessions,
      status: ROLE_CLAIM_JOB_STATUS_PENDING,
      createdAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
      attempts: 0,
      // A new publication (or an explicit idempotent reconciliation) starts
      // a fresh retry window. The previous failure metadata must not keep
      // the new job asleep until an unrelated backoff expires.
      nextAttemptAt: null,
      lastError: null,
    },
    { merge: true },
  );
}

/**
 * Removes a publication job after the matching live role was published.
 *
 * A newer role revision owns a different job state. The stale publisher must
 * not delete that newer retry marker.
 */
async function clearPublishedRoleClaimJob(
  uid: string,
  role: string,
  revision: number,
): Promise<void> {
  const userRef = db.collection('users').doc(uid);
  const jobRef = roleClaimJobRef(uid);
  await db.runTransaction(async (transaction) => {
    const [userSnapshot, jobSnapshot] = await transaction.getAll(
      userRef,
      jobRef,
    );
    if (!jobSnapshot.exists) return;
    if (
      String(jobSnapshot.get('type') || '') !== ROLE_CLAIM_JOB_TYPE ||
      String(jobSnapshot.get('status') || '') !==
        ROLE_CLAIM_JOB_STATUS_PENDING
    ) {
      // Only the exact pending role-publication state may be completed.
      // A malformed or differently-typed document is never treated as a
      // successful publication marker.
      return;
    }

    if (userSnapshot.exists) {
      const liveRole = String(userSnapshot.get('role') || '').trim();
      const liveRevision = roleRevisionOf(userSnapshot);
      if (
        liveRole !== role ||
        liveRevision !== revision ||
        Number(jobSnapshot.get('roleRevision') || 0) !== revision ||
        String(jobSnapshot.get('role') || '') !== role
      ) {
        return;
      }
    }

    transaction.delete(jobRef);
  });
}

/** Options for one role-claim publication. */
export interface RoleClaimPublicationOptions {
  /**
   * Whether a non-admin role change should revoke the user's existing
   * refresh sessions.
   *
   * This is required when an administrator demotes somebody: an already
   * issued administrator token must not remain usable. It must not be used
   * during registration, because revoking the refresh token also prevents
   * the newly registered client from refreshing the ID token which carries
   * its new role claim.
   */
  revokeNonAdminSessions?: boolean;
}

/**
 * Publishes the latest live role to the Auth custom claims.
 *
 * Auth and Firestore cannot be updated atomically. Two overlapping role
 * writers could therefore publish their claims in the wrong order. The
 * revision is checked after every Auth write; a stale writer notices the
 * newer revision and republishes the current role before it returns.
 */
export async function publishLatestRoleClaims(
  uid: string,
  options: RoleClaimPublicationOptions = {},
): Promise<{ role: string; revision: number }> {
  const userRef = db.collection('users').doc(uid);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const before = await userRef.get();
    if (!before.exists) {
      await clearPublishedRoleClaimJob(uid, '', 0);
      return { role: '', revision: 0 };
    }

    const role = String(before.get('role') || '').trim();
    const revision = roleRevisionOf(before);
    await authClient.setCustomUserClaims(uid, {
      admin: role === 'admin',
      role,
      roleRevision: revision,
    });

    const after = await userRef.get();
    if (
      after.exists &&
      roleRevisionOf(after) === revision &&
      String(after.get('role') || '').trim() === role
    ) {
      // A demotion must not leave an already-issued administrator token
      // usable. New tokens receive the new claims; old refresh sessions are
      // revoked as well. Registration deliberately keeps the refresh session
      // alive so the client can fetch the new role claim.
      if (options.revokeNonAdminSessions && role !== 'admin') {
        await authClient.revokeRefreshTokens(uid);
      }
      await clearPublishedRoleClaimJob(uid, role, revision);
      return { role, revision };
    }
  }
}

/**
 * Retries durable Auth role-claim publications.
 *
 * A Firestore role transition and an Auth custom-claim update cannot be
 * atomic. The role transition therefore always leaves this job behind. A
 * transient Auth outage can no longer strand a promoted administrator or a
 * demoted owner with an unusable token.
 */
export const processRoleClaimPublicationJobs = functions.pubsub
  .schedule('every 5 minutes')
  .onRun(async () => {
    let completed = 0;
    let failed = 0;
    let cursor: firestore.QueryDocumentSnapshot | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let query = db
        .collection('roleClaimJobs')
        .where('type', '==', ROLE_CLAIM_JOB_TYPE)
        .where('status', '==', ROLE_CLAIM_JOB_STATUS_PENDING)
        .orderBy('__name__');
      if (cursor) query = query.startAfter(cursor);
      const page = await query.limit(100).get();
      if (page.empty) break;

      for (const job of page.docs) {
        const nextAttemptAt = job.get('nextAttemptAt');
        if (
          nextAttemptAt &&
          typeof nextAttemptAt.toMillis === 'function' &&
          nextAttemptAt.toMillis() > Date.now()
        ) {
          continue;
        }

        const uid = String(job.get('uid') || '').trim();
        if (!uid) {
          await job.ref.delete();
          continue;
        }

        try {
          await publishLatestRoleClaims(uid, {
            revokeNonAdminSessions:
              job.get('revokeNonAdminSessions') === true,
          });
          completed += 1;
        } catch (error) {
          failed += 1;
          const attempts = Number(job.get('attempts') || 0);
          const backoffMinutes = Math.min(60, 2 * Math.pow(2, attempts));
          try {
            await job.ref.set(
              {
                attempts: firestore.FieldValue.increment(1),
                lastError: String(error).slice(0, 300),
                nextAttemptAt: firestore.Timestamp.fromMillis(
                  Date.now() + backoffMinutes * 60 * 1000,
                ),
                updatedAt: firestore.FieldValue.serverTimestamp(),
              },
              { merge: true },
            );
          } catch (updateError) {
            console.error(
              'Could not record the role-claim publication retry state:',
              updateError,
            );
          }
          console.error(
            `Could not publish the role claims for account ${uid}:`,
            error,
          );
        }
      }

      cursor = page.docs[page.docs.length - 1];
      if (page.size < 100) break;
    }

    if (failed > 0) {
      throw new Error(`${failed} role-claim publication job(s) failed`);
    }
    console.log(
      `Role-claim publication jobs completed: ${completed}`,
    );
    return null;
  });
