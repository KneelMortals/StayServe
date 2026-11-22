import * as functions from 'firebase-functions/v1';
import { callableHttps } from './appCheck';
import * as firestore from 'firebase-admin/firestore';
import * as authSdk from 'firebase-admin/auth';

// Creates the default Firebase app **before** any other module is loaded —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  assertLiveAdmin,
  canActAsAdmin,
  readUserProfilesInPathOrder,
} from './accounts';
import {
  accountDeletionIsPending,
  accountDeletionJobId,
  enqueueAccountDeletion,
  isAccountDeletionBlockedError,
  nextAccountAuthStateRevision,
  processAccountDeletionJob,
} from './admin';
import {
  BatchWriteGuard,
  deleteWhere,
  deleteWhereAsync,
  updateWhere,
} from './batches';
import { roleChangeRequestEffect } from './roleChangeAccess';
import {
  enqueueRoleClaimPublication,
  publishLatestRoleClaims,
  roleRevisionOf,
} from './roleClaims';
import { notify } from './notifications';
import { areNotificationsEnabled } from './platform';

const db = firestore.getFirestore();
const auth = authSdk.getAuth();

/**
 * The current revision of an account's administrative disable state.
 *
 * Ban and forced-logout operations increment it. An unban records the
 * revision it observed before its non-atomic Auth call and refuses to finish
 * if another administrator changed the account in the meantime.
 */
function accountAdministrativeRevision(
  snapshot: firestore.DocumentSnapshot,
): number {
  const value = Number(snapshot.get('administrativeStateRevision') || 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * A transaction guard which proves that the acting administrator is still
 * live. The profile is read in the same transaction as the protected writes,
 * so a demotion or ban cannot race with a privileged batch.
 */
function liveAdminGuard(adminUid: string): BatchWriteGuard {
  return {
    ref: db.collection('users').doc(adminUid),
    assertAuthorized(snapshot: firestore.DocumentSnapshot): void {
      if (
        !canActAsAdmin({
          exists: snapshot.exists,
          registrationCompleted: snapshot.get('registrationCompleted'),
          isActive: snapshot.get('isActive'),
          role: snapshot.get('role'),
        })
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Admin access required',
        );
      }
    },
  };
}

/**
 * Reads a set of user profiles in a stable document-path order.
 *
 * The helper lives in `./accounts` so the admin callables and the
 * account-deletion state machine use exactly the same lock order.
 */

/**
 * Sends a role-change notification unless the platform disabled them.
 *
 * A failed settings read fails closed: the role change itself is already
 * committed, and a transient operational error must not turn it into an
 * unexpected push to every affected account.
 */
async function notifyRoleChange(
  userId: string,
  title: string,
  body: string,
  requestId: string,
  roomId: string,
): Promise<void> {
  if (!userId) return;
  try {
    if (!(await areNotificationsEnabled())) return;
  } catch (error) {
    console.error('Could not read the notification setting:', error);
    return;
  }
  await notify(userId, title, body, 'joinRequest', { requestId, roomId });
}

/**
 * The maximum number of booking requests one side of a role change may
 * have.
 *
 * The role decision itself is written in one transaction. The open requests
 * are cancelled afterwards in bounded pages, because a single Firestore
 * transaction may contain at most 500 writes and an account can have more
 * requests than that. A profile with more requests than this limit is
 * refused with a clear error instead of failing with an opaque Firestore
 * limit error in the middle of a role change.
 */
const MAX_ROLE_CHANGE_REQUESTS_PER_SIDE = 200;

/** One booking request which was cancelled by a role change. */
interface CancelledRoleRequest {
  requestId: string;
  studentId: string;
  ownerId: string;
  roomId: string;
  changedSide: 'student' | 'owner';
}

/** One serialized role transition. */
interface RoleChangeTransition {
  revision: number;
  previousRole: string;
  nextRole: string;
}

/**
 * Whether a request belongs to the booking side which the previous role
 * made invalid.
 *
 * A student-to-owner change invalidates the student's tenant requests. It
 * must not cancel a fresh request which somebody else made for a room which
 * the account owns after the role change. The owner side is handled in the
 * same way.
 */
function requestUsesPreviousRoleSide(
  previousRole: string,
  request: Record<string, any>,
  uid: string,
): boolean {
  const normalized = previousRole.trim().toLowerCase();
  if (normalized === 'student') {
    return String(request.studentId || '').trim() === uid;
  }
  if (normalized === 'owner') {
    return String(request.ownerId || '').trim() === uid;
  }

  // An administrator has no normal booking side. Any open request which
  // names the account is conservatively cancelled.
  return (
    String(request.studentId || '').trim() === uid ||
    String(request.ownerId || '').trim() === uid
  );
}

/**
 * Collects every request of one account in bounded pages.
 *
 * The two sides are merged by document id, so a malformed request which
 * names the same account twice is handled exactly once.
 */
async function collectRoleChangeRequests(
  uid: string,
  previousRole: string,
): Promise<Map<string, firestore.QueryDocumentSnapshot>> {
  const affected = new Map<string, firestore.QueryDocumentSnapshot>();
  const normalized = previousRole.trim().toLowerCase();
  const fields: Array<'studentId' | 'ownerId'> =
    normalized === 'student'
      ? ['studentId']
      : normalized === 'owner'
        ? ['ownerId']
        : ['studentId', 'ownerId'];

  for (const field of fields) {
    let cursor: firestore.QueryDocumentSnapshot | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let query = db
        .collection('joinRequests')
        .where(field, '==', uid)
        .orderBy(firestore.FieldPath.documentId());
      if (cursor) query = query.startAfter(cursor);

      const snapshot = await query.limit(MAX_ROLE_CHANGE_REQUESTS_PER_SIDE + 1).get();
      if (snapshot.size > MAX_ROLE_CHANGE_REQUESTS_PER_SIDE) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This account has too many booking requests to clean up its role change safely. Please contact support.',
        );
      }
      if (snapshot.empty) break;
      for (const requestDoc of snapshot.docs) {
        affected.set(requestDoc.id, requestDoc);
      }
      cursor = snapshot.docs[snapshot.docs.length - 1];
      if (snapshot.size <= MAX_ROLE_CHANGE_REQUESTS_PER_SIDE) break;
    }
  }

  return affected;
}

/**
 * Cancels the open requests which the new role makes invalid.
 *
 * The live role was already committed, so every booking transition which
 * could still change one of these requests is refused. Each page is
 * re-read in its own transaction before it is written, so a request which
 * was cancelled or rejected in the meantime is never overwritten.
 */
async function cancelRoleAffectedRequests(
  uid: string,
  transition: RoleChangeTransition,
  cancelledBy: string,
): Promise<CancelledRoleRequest[]> {
  const affected = await collectRoleChangeRequests(
    uid,
    transition.previousRole,
  );
  const requestDocs = Array.from(affected.values());
  const cancelled: CancelledRoleRequest[] = [];

  for (let index = 0; index < requestDocs.length; index += 100) {
    const chunk = requestDocs.slice(index, index + 100);
    const chunkCancelled = await db.runTransaction(async (transaction) => {
      // The target profile is read in the same transaction as the request
      // writes. A newer role change increments the revision and therefore
      // makes this stale cleanup a no-op.
      const profileSnapshot = await transaction.get(
        db.collection('users').doc(uid),
      );
      if (!profileSnapshot.exists) return [];
      if (roleRevisionOf(profileSnapshot) !== transition.revision) return [];
      if (profileSnapshot.get('role') !== transition.nextRole) return [];
      if (
        profileSnapshot.get('roleChangeCleanupPending') !== true ||
        profileSnapshot.get('roleChangedFrom') !== transition.previousRole ||
        profileSnapshot.get('roleChangeTo') !== transition.nextRole ||
        Number(profileSnapshot.get('roleChangeRevision') || 0) !==
          transition.revision
      ) {
        return [];
      }

      const snapshots = await transaction.getAll(
        ...chunk.map((requestDoc) => requestDoc.ref),
      );
      const updates: CancelledRoleRequest[] = [];

      for (const snapshot of snapshots) {
        if (!snapshot.exists) continue;
        const request = snapshot.data() as Record<string, any>;
        if (
          roleChangeRequestEffect(
            transition.previousRole,
            transition.nextRole,
            request,
          ) !== 'cancel'
        ) {
          continue;
        }
        if (
          !requestUsesPreviousRoleSide(
            transition.previousRole,
            request,
            uid,
          )
        ) {
          continue;
        }

        transaction.update(snapshot.ref, {
          status: 'cancelled',
          cancelledAt: firestore.FieldValue.serverTimestamp(),
          cancelledBy,
          cancellationReason: 'The account role changed',
          updatedAt: firestore.FieldValue.serverTimestamp(),
        });
        updates.push({
          requestId: snapshot.id,
          studentId: String(request.studentId || ''),
          ownerId: String(request.ownerId || ''),
          roomId: String(request.roomId || ''),
          changedSide:
            String(request.ownerId || '').trim() === uid ? 'owner' : 'student',
        });
      }

      return updates;
    });
    cancelled.push(...chunkCancelled);
  }

  return cancelled;
}

// OTP verification (email + mobile).
export { sendOtp, verifyOtp, registerUserRole, completeRegistration } from './otp';

// Platform-fee payments (server-authoritative payee, amount and verification).
export { createUpiPayment, submitPayment, verifyPayment } from './payments';

// Booking requests and client notifications.
//
// The join-request documents are written by the server, so the rent, the
// owner and the commission percentage cannot be forged by a modified client.
export {
  createJoinRequest,
  respondToJoinRequest,
  confirmJoinAsStudent,
  cancelJoinRequest,
  openConversation,
  notifyUser,
} from './requests';

// Participant names and personal student-owner blocks.
//
// The peer profile is private, so the server resolves the display names and
// owns the directional block documents. The client only receives the small
// amount of metadata it needs to render the interaction safely.
export {
  getConversationInteractionDetails,
  getBookingInteractionDetails,
  getRoomContactDetails,
  blockUser,
  unblockUser,
} from './interactions';

// Notification content and deletion are server-owned. Clients may only
// update the read bookkeeping of their own notification.
export { deleteNotification } from './notifications';

// The admin surface: the review of a booking request and the deletion of a
// user account (with a seven day grace period).
export {
  adminReviewRequest,
  scheduleUserDeletion,
  cancelUserDeletion,
  processScheduledDeletions,
  processAccountDeletionJobs,
  enqueueAccountDeletion,
  processAccountDeletionJob,
  deleteUserEverywhere,
} from './admin';

// Reviews of a room.
//
// A student may only review a room whose request the owner has accepted —
// the check is made on the server, so a modified client cannot review a
// room it was never accepted for.
export { submitRoomReview, deleteRoomReview } from './reviews';

// The visit details of a room.
//
// The address of a room is only handed out to the students whose request
// the owner has accepted.
export { getRoomVisitDetails } from './visits';

// Exact room locations and the staged public/private migration.
//
// The owner writes only through `setRoomPrivateLocation`; the Admin SDK
// bypasses Firestore rules and keeps the private copy and the public
// compatibility fields in one transaction.
export {
  setRoomPrivateLocation,
  migrateRoomPrivateLocations,
  verifyRoomPrivateLocations,
  finalizeRoomLocationPrivacy,
} from './privateLocations';

// Owner-controlled listing availability.
//
// The occupancy counter stays server-owned; this callable changes only the
// listing status after checking the live owner and the listing's ownership.
export {
  setRoomListingAvailability,
  deleteRoomListing,
  adminSetRoomListingStatus,
  onRoomCreated,
  onRoomUpdated,
  processRoomPhotoCleanupJobs,
} from './rooms';

// Durable Auth custom-claim publication retries.
export { processRoleClaimPublicationJobs } from './roleClaims';

// ============================================
// ADMIN: Revoke User Refresh Tokens (Force Logout)
// ============================================
export const revokeUserTokens = callableHttps.onCall(async (data, context) => {
  // Verify admin access
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  const adminUid = context.auth.uid;
  await assertLiveAdmin(adminUid);

  const uid = String(data?.uid || '').trim();
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }
  if (uid === adminUid) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'You cannot revoke your own session.',
    );
  }

  const jobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId(uid));

  try {
    // Commit the live authorization state first. Every callable checks the
    // Firestore profile, so the account is blocked even if the Auth calls
    // below fail. The reverse order left a window in which Auth still
    // considered the account usable while the live profile was not yet
    // disabled.
    await db.runTransaction(async (transaction) => {
      // The deletion job is read before the user profiles. Every
      // account-deletion transaction uses the same lock order, so a forced
      // logout and a deletion cancellation cannot deadlock.
      const jobSnapshot = await transaction.get(jobRef);
      const profiles = await readUserProfilesInPathOrder(transaction, [
        adminUid,
        uid,
      ]);
      const adminSnapshot = profiles.get(adminUid)!;
      const targetSnapshot = profiles.get(uid)!;
      if (
        !canActAsAdmin({
          exists: adminSnapshot.exists,
          registrationCompleted: adminSnapshot.get('registrationCompleted'),
          isActive: adminSnapshot.get('isActive'),
          role: adminSnapshot.get('role'),
        })
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Admin access required',
        );
      }
      if (!targetSnapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That user profile no longer exists',
        );
      }

      const targetPatch: Record<string, unknown> = {
        isActive: false,
        forcedLogoutAt: firestore.FieldValue.serverTimestamp(),
        forcedLogoutBy: adminUid,
        administrativeStateRevision:
          accountAdministrativeRevision(targetSnapshot) + 1,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      };

      // A forced logout during the deletion grace period is an explicit
      // administrative disable. It must invalidate the stale restoration
      // state; otherwise cancelling the deletion would re-activate the very
      // account which was just disabled.
      if (accountDeletionIsPending(targetSnapshot, jobSnapshot)) {
        targetPatch.deletionPreviousIsActive = false;
        const jobStatus = jobSnapshot.exists
          ? String(jobSnapshot.get('status') || '')
          : '';
        transaction.set(
          jobRef,
          {
            type: 'accountDeletion',
            uid,
            ...(jobStatus
              ? { status: jobStatus }
              : targetSnapshot.get('deletionScheduled') === true
                ? { status: 'scheduled' }
                : {}),
            previousIsActive: false,
            authEnablePending: false,
            authDisablePending: true,
            authRevokePending: true,
            authStateRevision: nextAccountAuthStateRevision(jobSnapshot),
            updatedAt: firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      transaction.update(targetSnapshot.ref, targetPatch);
    });

    await auth.revokeRefreshTokens(uid);
    // Disable the Auth account as well. Revoking refresh tokens alone does
    // not invalidate an ID token that is already on a device.
    await auth.updateUser(uid, { disabled: true });
    return { success: true, message: `Tokens revoked for user ${uid}` };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error revoking tokens:', error);
    throw new functions.https.HttpsError('internal', 'Failed to revoke tokens');
  }
});

// ============================================
// ADMIN: Set Custom Claims (Role)
// ============================================
export const setUserRole = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  const adminUid = context.auth.uid;
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  await assertLiveAdmin(context.auth.uid);

  const uid = String(data?.uid || '').trim();
  const role = String(data?.role || '').trim();
  if (!uid || !role) {
    throw new functions.https.HttpsError('invalid-argument', 'UID and role are required');
  }

  const validRoles = ['student', 'owner', 'admin'];
  if (!validRoles.includes(role)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid role');
  }
  if (uid === adminUid) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'An administrator cannot change their own role.',
    );
  }

  const cancelledRequests: CancelledRoleRequest[] = [];

  try {
    // The live role is written in one transaction. The open requests are
    // cancelled afterwards in bounded pages: every booking transition reads
    // the live role, so the role write itself already closes the race, while
    // a single transaction with one write per historical request could exceed
    // the Firestore write limit.
    const cleanupTransition = await db.runTransaction(async (transaction) => {
      // Firestore may run a transaction callback more than once, so the
      // value is rebuilt on every attempt.
      let transition: RoleChangeTransition | null = null;

      const profiles = await readUserProfilesInPathOrder(transaction, [
        adminUid,
        uid,
      ]);
      const actingAdminSnapshot = profiles.get(adminUid)!;
      const profileSnapshot = profiles.get(uid)!;

      if (
        !canActAsAdmin({
          exists: actingAdminSnapshot.exists,
          registrationCompleted: actingAdminSnapshot.get('registrationCompleted'),
          isActive: actingAdminSnapshot.get('isActive'),
          role: actingAdminSnapshot.get('role'),
        })
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Admin access required',
        );
      }

      if (!profileSnapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That user profile no longer exists',
        );
      }

      const currentRole = String(profileSnapshot.get('role') || '');
      const roleChanged = currentRole !== role;
      const currentRevision = roleRevisionOf(profileSnapshot);
      if (roleChanged) {
        transition = {
          revision: currentRevision + 1,
          previousRole: currentRole,
          nextRole: role,
        };
      } else if (profileSnapshot.get('roleChangeCleanupPending') === true) {
        // A previous role change committed, but the cancellation of its open
        // requests did not finish. The revision makes the retry safe: a
        // newer role change cannot be mistaken for this older transition.
        const markerRevision = Number(
          profileSnapshot.get('roleChangeRevision') || currentRevision,
        );
        const previousRole = String(
          profileSnapshot.get('roleChangedFrom') || '',
        );
        const nextRole = String(profileSnapshot.get('roleChangeTo') || role);
        if (
          Number.isSafeInteger(markerRevision) &&
          markerRevision >= 0 &&
          previousRole &&
          previousRole !== nextRole
        ) {
          transition = {
            revision: markerRevision,
            previousRole,
            nextRole,
          };
        }
      }

      // An administrator role cannot be assigned to a half-registered
      // account. Such a profile has no user-selectable registration path
      // for the `admin` role and would otherwise be locked in an incomplete
      // state which can never finish registration.
      if (
        role === 'admin' &&
        roleChanged &&
        profileSnapshot.get('registrationCompleted') !== true
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The user must complete registration before they can be made an administrator.',
        );
      }

      if (roleChanged) {
        // A role change affects both sides of a booking. The old query only
        // looked at requests where the user was the tenant, so an owner could
        // be demoted while owner-side requests stayed open and could still be
        // approved with the old token.
        //
        // The queries are bounded. An account with more requests than the
        // limit is refused with a controlled error instead of putting an
        // unbounded number of documents into one transaction.
        const studentRequestsSnapshot = await transaction.get(
          db
            .collection('joinRequests')
            .where('studentId', '==', uid)
            .limit(MAX_ROLE_CHANGE_REQUESTS_PER_SIDE + 1),
        );
        const ownerRequestsSnapshot = await transaction.get(
          db
            .collection('joinRequests')
            .where('ownerId', '==', uid)
            .limit(MAX_ROLE_CHANGE_REQUESTS_PER_SIDE + 1),
        );

        if (
          studentRequestsSnapshot.size > MAX_ROLE_CHANGE_REQUESTS_PER_SIDE ||
          ownerRequestsSnapshot.size > MAX_ROLE_CHANGE_REQUESTS_PER_SIDE
        ) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'This account has too many booking requests to change its role safely. Please contact support.',
          );
        }

        // A malformed request could match both queries. It must only be
        // processed once.
        const affectedRequests = new Map<
          string,
          firestore.QueryDocumentSnapshot
        >();
        for (const requestDoc of studentRequestsSnapshot.docs) {
          affectedRequests.set(requestDoc.id, requestDoc);
        }
        for (const requestDoc of ownerRequestsSnapshot.docs) {
          affectedRequests.set(requestDoc.id, requestDoc);
        }

        for (const requestDoc of affectedRequests.values()) {
          const request = requestDoc.data() as Record<string, any>;
          const effect = roleChangeRequestEffect(currentRole, role, request);

          if (effect === 'block-active') {
            throw new functions.https.HttpsError(
              'failed-precondition',
              'This user has an active booking and their role cannot be changed yet.',
            );
          }

          if (effect === 'block-payment') {
            throw new functions.https.HttpsError(
              'failed-precondition',
              'This user has a pending payment and their role cannot be changed yet.',
            );
          }
        }
      }

      // Write the live role **inside** the same transaction as the blocker
      // check. The Firestore rules and every server-side booking check read
      // this document, so a demotion takes effect immediately even if the
      // custom-claim update below is delayed or fails.
      const rolePatch: Record<string, unknown> = {
        role,
        // An administrator's role decision is final too. It must not be
        // overwritten by a later registration call on an incomplete profile.
        roleClaimed: true,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      };
      if (roleChanged && transition) {
        // The cancellation of the open requests happens after the commit.
        // The marker and revision make that cleanup durable and serializable:
        // if it fails, a later call repeats it, while an overlapping newer
        // role change makes the stale cleanup a no-op.
        rolePatch.roleRevision = transition.revision;
        rolePatch.roleChangedFrom = transition.previousRole;
        rolePatch.roleChangeTo = transition.nextRole;
        rolePatch.roleChangeRevision = transition.revision;
        rolePatch.roleChangeCleanupPending = true;
      } else if (!roleChanged && transition) {
        // Normalize a legacy cleanup marker which predates the revision
        // fields. The cleanup can then finish without guessing which role
        // change it belongs to.
        rolePatch.roleRevision = transition.revision;
        rolePatch.roleChangeTo = transition.nextRole;
        rolePatch.roleChangeRevision = transition.revision;
      }
      const publicationRevision = transition
        ? transition.revision
        : currentRevision;
      enqueueRoleClaimPublication(
        transaction,
        uid,
        role,
        publicationRevision,
        true,
      );
      transaction.update(profileSnapshot.ref, rolePatch);
      return transition;
    });

    if (cleanupTransition) {
      const transition = cleanupTransition;
      const cancelled = await cancelRoleAffectedRequests(
        uid,
        transition,
        adminUid,
      );
      cancelledRequests.push(...cancelled);
      // Clear only the marker which belongs to this cleanup. A concurrent
      // role change may already have installed a newer marker; deleting it
      // unconditionally would make that newer cleanup impossible to retry.
      await db.runTransaction(async (transaction) => {
        const profileRef = db.collection('users').doc(uid);
        const profileSnapshot = await transaction.get(profileRef);
        if (!profileSnapshot.exists) return;
        if (roleRevisionOf(profileSnapshot) !== transition.revision) {
          return;
        }
        if (profileSnapshot.get('role') !== transition.nextRole) return;
        if (
          profileSnapshot.get('roleChangedFrom') !== transition.previousRole ||
          profileSnapshot.get('roleChangeTo') !== transition.nextRole ||
          Number(profileSnapshot.get('roleChangeRevision') || 0) !==
            transition.revision
        ) {
          return;
        }
        if (profileSnapshot.get('roleChangeCleanupPending') !== true) return;

        transaction.update(profileRef, {
          roleChangeCleanupPending: firestore.FieldValue.delete(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        });
      });
    }

    const published = await publishLatestRoleClaims(uid, {
      // An administrator role change may demote an account. Revoking the
      // old refresh sessions prevents an already-issued administrator token
      // from surviving that change.
      revokeNonAdminSessions: true,
    });

    for (const request of cancelledRequests) {
      // Tell both parties. The account whose role changed must learn that
      // its own request was cancelled, and the other party must not be left
      // waiting for a booking which can no longer be approved.
      await notifyRoleChange(
        request.studentId,
        'Booking request cancelled',
        request.changedSide === 'student'
          ? 'Your account role changed, so this booking request was cancelled.'
          : 'The owner account role changed, so this booking request was cancelled.',
        request.requestId,
        request.roomId,
      );
      if (request.ownerId !== request.studentId) {
        await notifyRoleChange(
          request.ownerId,
          'Booking request cancelled',
          request.changedSide === 'owner'
            ? 'Your account role changed, so this booking request was cancelled.'
            : 'The student account role changed, so this booking request was cancelled.',
          request.requestId,
          request.roomId,
        );
      }
    }

    return {
      success: true,
      message: `Role set to ${published.role} for user ${uid}`,
      cancelledRequests: cancelledRequests.length,
    };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error setting role:', error);
    throw new functions.https.HttpsError('internal', 'Failed to set role');
  }
});

// ============================================
// ADMIN: Ban User (Disable + Revoke Tokens)
// ============================================
export const banUser = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  const adminUid = context.auth.uid;
  await assertLiveAdmin(adminUid);

  const uid = String(data?.uid || '').trim();
  const reason = data?.reason ? String(data.reason).trim() : '';
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }
  if (uid === adminUid) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'You cannot ban your own account.',
    );
  }

  try {
    // The live Firestore state is committed first. If this write succeeds,
    // all server-side authorization checks reject the account immediately,
    // even if revoking or disabling the Auth account has to be retried.
    await db.runTransaction(async (transaction) => {
      // The deletion job is read before the user profiles. Every
      // account-deletion transaction uses the same lock order, so a ban and
      // a deletion cancellation cannot deadlock on the same pair of
      // documents.
      const jobRef = db
        .collection('accountDeletionJobs')
        .doc(accountDeletionJobId(uid));
      const jobSnapshot = await transaction.get(jobRef);
      const profiles = await readUserProfilesInPathOrder(transaction, [
        adminUid,
        uid,
      ]);
      const adminSnapshot = profiles.get(adminUid)!;
      const targetSnapshot = profiles.get(uid)!;
      if (
        !canActAsAdmin({
          exists: adminSnapshot.exists,
          registrationCompleted: adminSnapshot.get('registrationCompleted'),
          isActive: adminSnapshot.get('isActive'),
          role: adminSnapshot.get('role'),
        })
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Admin access required',
        );
      }
      if (!targetSnapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That user profile no longer exists',
        );
      }

      const jobStatus = jobSnapshot.exists
        ? String(jobSnapshot.get('status') || '')
        : '';
      const deletionPending = accountDeletionIsPending(
        targetSnapshot,
        jobSnapshot,
      );

      const targetPatch: Record<string, unknown> = {
        isActive: false,
        banReason: reason || 'Banned by admin',
        bannedAt: firestore.FieldValue.serverTimestamp(),
        administrativeStateRevision:
          accountAdministrativeRevision(targetSnapshot) + 1,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      };

      // A ban during the deletion grace period must invalidate the stale
      // restoration state. Otherwise cancelling the deletion would restore
      // the account to `isActive: true` and silently undo the ban. The
      // durable disable marker also lets the scheduled worker repair a failed
      // Auth disable.
      if (deletionPending) {
        targetPatch.deletionPreviousIsActive = false;
        transaction.set(
          jobRef,
          {
            type: 'accountDeletion',
            uid,
            ...(jobStatus
              ? { status: jobStatus }
              : targetSnapshot.get('deletionScheduled') === true
                ? { status: 'scheduled' }
                : {}),
            previousIsActive: false,
            authEnablePending: false,
            authDisablePending: true,
            authRevokePending: true,
            authStateRevision: nextAccountAuthStateRevision(jobSnapshot),
            updatedAt: firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      transaction.update(targetSnapshot.ref, targetPatch);
    });

    await auth.revokeRefreshTokens(uid);
    await auth.updateUser(uid, { disabled: true });
    return { success: true, message: `User ${uid} banned` };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error banning user:', error);
    throw new functions.https.HttpsError('internal', 'Failed to ban user');
  }
});

/**
 * Refuses an operation which would re-activate an account whose deletion
 * has already started.
 *
 * The durable profile marker and the deterministic deletion job are both
 * checked. Only the cancellation flow may clear them.
 */
function assertAccountIsNotBeingDeleted(
  userSnapshot: firestore.DocumentSnapshot,
  jobSnapshot: firestore.DocumentSnapshot,
): void {
  const deletionState = String(userSnapshot.get('deletionState') || '').trim();
  const deletionScheduled = userSnapshot.get('deletionScheduled') === true;
  const jobStatus = jobSnapshot.exists
    ? String(jobSnapshot.get('status') || '').trim()
    : '';

  if (
    deletionState ||
    deletionScheduled ||
    jobStatus === 'scheduled' ||
    jobStatus === 'pending' ||
    jobStatus === 'processing' ||
    jobStatus === 'cancelled' ||
    jobStatus === 'completed'
  ) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This account is being deleted and cannot be re-activated. Cancel the deletion first.',
    );
  }
}

/**
 * Repairs an Auth enable which was not followed by a successful Firestore
 * activation.
 *
 * An unban spans two transactions because Firebase Auth cannot participate in
 * a Firestore transaction. If a deletion is scheduled between them, the
 * second transaction refuses the activation. The account must then be put
 * back into the durable disabled state; otherwise a stale Auth enable could
 * leave a deleting account usable.
 */
async function repairUnbanAuthEnable(
  uid: string,
  jobRef: firestore.DocumentReference,
): Promise<void> {
  const userRef = db.collection('users').doc(uid);
  let deletionPending = false;

  await db.runTransaction(async (transaction) => {
    // Keep the same lock order as every account-deletion transaction.
    const jobSnapshot = await transaction.get(jobRef);
    const userSnapshot = await transaction.get(userRef);
    deletionPending = accountDeletionIsPending(userSnapshot, jobSnapshot);

    if (deletionPending) {
      const jobStatus = jobSnapshot.exists
        ? String(jobSnapshot.get('status') || '')
        : '';
      transaction.set(
        jobRef,
        {
          type: 'accountDeletion',
          uid,
          ...(jobStatus
            ? { status: jobStatus }
            : userSnapshot.get('deletionScheduled') === true
              ? { status: 'scheduled' }
              : {}),
          previousIsActive: false,
          authEnablePending: firestore.FieldValue.delete(),
          authDisablePending: true,
          authRevokePending: true,
          authStateRevision: nextAccountAuthStateRevision(jobSnapshot),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (userSnapshot.exists) {
        transaction.update(userRef, {
          isActive: false,
          deletionPreviousIsActive: false,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        });
      }
    }
  });

  try {
    await auth.updateUser(uid, { disabled: true });
    await auth.revokeRefreshTokens(uid);
  } catch (error) {
    // The durable marker stays pending when a deletion owns this account, so
    // the scheduled worker retries the Auth transition. Without a deletion,
    // the failed unban already leaves the live profile inactive and the
    // administrator can retry the operation.
    console.error('Failed to repair the Auth state after an unban:', error);
  }
}

// ============================================
// ADMIN: Unban User (Enable)
// ============================================
export const unbanUser = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  const adminUid = context.auth.uid;
  await assertLiveAdmin(adminUid);

  const uid = String(data?.uid || '').trim();
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }

  const jobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId(uid));

  let authEnableAttempted = false;
  let observedAdministrativeRevision = 0;

  try {
    // The first transaction is a check only. It proves that the account is
    // not part of a deletion which is running or waiting to run, and it
    // reads the administrator profile inside the transaction.
    await db.runTransaction(async (transaction) => {
      // The deletion job is always read before the user profiles. Every
      // account-deletion transaction uses the same order, so two operations
      // cannot deadlock on the same pair of documents.
      const jobSnapshot = await transaction.get(jobRef);
      const profiles = await readUserProfilesInPathOrder(transaction, [
        adminUid,
        uid,
      ]);
      const adminSnapshot = profiles.get(adminUid)!;
      const targetSnapshot = profiles.get(uid)!;

      if (
        !canActAsAdmin({
          exists: adminSnapshot.exists,
          registrationCompleted: adminSnapshot.get('registrationCompleted'),
          isActive: adminSnapshot.get('isActive'),
          role: adminSnapshot.get('role'),
        })
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Admin access required',
        );
      }
      if (!targetSnapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That user profile no longer exists',
        );
      }
      observedAdministrativeRevision = accountAdministrativeRevision(
        targetSnapshot,
      );
      assertAccountIsNotBeingDeleted(targetSnapshot, jobSnapshot);
    });

    // Auth is enabled **before** the Firestore profile is activated. If the
    // Auth call or the second transaction fails, the profile stays inactive
    // and every server-side check keeps rejecting the account. The reverse
    // order would leave an account which the server trusts while Auth still
    // considers it disabled.
    authEnableAttempted = true;
    await auth.updateUser(uid, { disabled: false });

    await db.runTransaction(async (transaction) => {
      const jobSnapshot = await transaction.get(jobRef);
      const profiles = await readUserProfilesInPathOrder(transaction, [
        adminUid,
        uid,
      ]);
      const adminSnapshot = profiles.get(adminUid)!;
      const targetSnapshot = profiles.get(uid)!;

      if (
        !canActAsAdmin({
          exists: adminSnapshot.exists,
          registrationCompleted: adminSnapshot.get('registrationCompleted'),
          isActive: adminSnapshot.get('isActive'),
          role: adminSnapshot.get('role'),
        })
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Admin access required',
        );
      }
      if (!targetSnapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That user profile no longer exists',
        );
      }
      if (
        accountAdministrativeRevision(targetSnapshot) !==
        observedAdministrativeRevision
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The account changed while it was being re-enabled. Try again.',
        );
      }
      assertAccountIsNotBeingDeleted(targetSnapshot, jobSnapshot);

      transaction.update(targetSnapshot.ref, {
        isActive: true,
        banReason: firestore.FieldValue.delete(),
        bannedAt: firestore.FieldValue.delete(),
        forcedLogoutAt: firestore.FieldValue.delete(),
        forcedLogoutBy: firestore.FieldValue.delete(),
        administrativeStateRevision: observedAdministrativeRevision + 1,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
    });

    return { success: true, message: `User ${uid} unbanned` };
  } catch (error) {
    if (authEnableAttempted) {
      try {
        await repairUnbanAuthEnable(uid, jobRef);
      } catch (repairError) {
        // The original operation error is more useful to the administrator.
        // The durable disable marker is written before the Auth repair, so a
        // scheduling race remains retryable even when this compensation
        // itself fails.
        console.error('Failed to compensate an incomplete unban:', repairError);
      }
    }
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error unbanning user:', error);
    throw new functions.https.HttpsError('internal', 'Failed to unban user');
  }
});

// ============================================
// ADMIN: Delete User Completely
// ============================================
//
// The cleanup itself lives in `./admin` — it is shared with the scheduled
// deletion (the seven day grace period) and with the `onUserDelete`
// trigger, so there is only one implementation of "remove this account".
export const deleteUserCompletely = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  await assertLiveAdmin(context.auth.uid);

  const targetUid = String(data?.uid || '').trim();
  if (!targetUid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }
  if (targetUid === context.auth.uid) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'You cannot delete your own account',
    );
  }

  let jobRef: firestore.DocumentReference;
  try {
    // The durable job is committed before the cleanup starts. The immediate
    // attempt below removes the account now when everything is healthy; a
    // transient Firestore, Storage or Auth failure leaves the job pending
    // for the scheduled worker instead of losing the request.
    jobRef = await enqueueAccountDeletion(targetUid, {
      source: 'admin-immediate',
      requestedBy: context.auth.uid,
      authorizationUid: context.auth.uid,
    });
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Could not queue the deletion of the user:', error);
    throw new functions.https.HttpsError(
      'internal',
      'Could not queue the deletion of the user',
    );
  }

  try {
    const completed = await processAccountDeletionJob(jobRef);

    return {
      success: true,
      completed,
      queued: !completed,
      blocked: false,
      retryable: !completed,
      state: completed ? 'completed' : 'queued',
      message: completed
        ? `User ${targetUid} deleted completely`
        : `The deletion of user ${targetUid} is queued and will be retried`,
    };
  } catch (error) {
    console.error('The deletion could not finish immediately:', error);
    const blocked = isAccountDeletionBlockedError(error);
    return {
      success: true,
      completed: false,
      queued: true,
      blocked,
      retryable: !blocked,
      state: blocked ? 'blocked' : 'queued',
      message: blocked
        ? String(
            (error as Error)?.message ||
              'The account still has active booking data. The deletion is queued.',
          )
        : `The deletion of user ${targetUid} is queued and will be retried`,
    };
  }
});

// ============================================
// TRIGGER: On User Create - Set Default Claims
// ============================================
export const onUserCreate = functions.auth.user().onCreate(async (user) => {
  try {
    const userRef = db.collection('users').doc(user.uid);

    // ---------------------------------------------------------------
    // The profile is seeded with `create()`, **not** with
    // `set({...}, {merge: true})`.
    //
    // The old code first read the document and only then wrote it, which
    // left a window in which the client — which writes the role the user
    // actually picked during the sign-up — could create the profile
    // first. The seed then merged over it and replaced `role: 'owner'`
    // with `role: 'student'`.
    //
    // The result was an account that had the "owner" claim but a
    // "student" profile, so the app opened the student home for an owner.
    //
    // `create()` is atomic: it fails with ALREADY_EXISTS when the document
    // is already there, so the seed can never overwrite a profile that
    // somebody else has written.
    // ---------------------------------------------------------------
    try {
      await userRef.create({
        uid: user.uid,
        name: user.displayName || 'User',
        email: user.email || '',
        phone: user.phoneNumber || null,
        role: 'student',
        // The trigger's default role is not a user-selected role yet. The
        // first successful registration call may replace it exactly once.
        roleClaimed: false,
        isActive: true,
        // The account is not usable until the server has verified the
        // registration challenge and written the final role.
        registrationCompleted: false,
        createdAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
        savedRooms: [],
      });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      // Somebody else (the client) created the profile first — keep it.
    }

    // ---------------------------------------------------------------
    // Custom claims are deliberately **not** written by this trigger.
    //
    // Firestore and Auth are separate systems, so a claim write cannot be
    // made atomic with the registration transaction. The old trigger read
    // the profile and then wrote a student/owner claim; a registration or
    // administrator role change could commit in between, and the trigger
    // would then overwrite the newer claim with its stale value.
    //
    // The registration callables and `setUserRole` write the claims after
    // their authoritative Firestore change. Before registration completes,
    // the account is blocked by the live `registrationCompleted` check, so
    // no default claim is needed.
    // ---------------------------------------------------------------
    console.log(`User profile created for ${user.uid}`);
  } catch (error) {
    console.error('Error in onUserCreate:', error);
    // Let the background trigger retry. Swallowing this error would leave an
    // Auth account without a Firestore profile and no record that the seed
    // still has to happen.
    throw error;
  }
});

/**
 * Whether the error means "the document already exists".
 *
 * The gRPC status code for `ALREADY_EXISTS` is 6. Depending on the version
 * of the Firebase Admin SDK the error carries that number, or the string
 * `already-exists`, so both are accepted.
 */
function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code;
  return (
    code === 6 ||
    code === 'already-exists' ||
    code === 'ALREADY_EXISTS' ||
    code === 'already_exists'
  );
}

// ============================================
// TRIGGER: On User Delete - Cleanup
// ============================================
//
// The cleanup lives in `./admin` — it is shared with the admin delete and
// with the scheduled (seven day) deletion, so there is only one
// implementation of "remove this account".
export const onUserDelete = functions.auth.user().onDelete(async (user) => {
  // The job is the durable source of truth. If writing it fails, the trigger
  // fails and the platform retries the event. Once it exists, a cleanup
  // failure can be retried by the scheduled worker even if this trigger
  // invocation is no longer available.
  const jobRef = await enqueueAccountDeletion(user.uid, {
    source: 'auth-delete-trigger',
  });

  try {
    if (await processAccountDeletionJob(jobRef)) {
      console.log(`Cleanup completed for deleted user ${user.uid}`);
    }
  } catch (error) {
    console.error('Error in onUserDelete:', error);
    // The durable job remains pending, but the trigger invocation must also
    // fail so the platform retries the cleanup promptly. Swallowing the error
    // would leave the account half-deleted until the next scheduled run.
    throw error;
  }
});

// ============================================
// ADMIN: Run a maintenance task on demand
// ============================================
//
// The "Clear Old Notifications" and "Archive Inactive Rooms" buttons in
// Admin → Settings used to be empty `onPressed: () {}` handlers: they
// looked like they worked but did absolutely nothing. These callable
// functions run the very same logic as the scheduled jobs, so the button
// really does what it says.
export const runMaintenanceTask = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  const adminUid = context.auth.uid;
  await assertLiveAdmin(adminUid);

  const task = String(data?.task || '');
  // Every privileged batch re-reads the live administrator profile inside
  // its own transaction. A demoted or banned admin therefore cannot pass the
  // preflight check and still commit a maintenance write.
  const guard = liveAdminGuard(adminUid);

  try {
    if (task === 'cleanNotifications') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const timestamp = firestore.Timestamp.fromDate(thirtyDaysAgo);

      // The notifications are deleted **page by page** — a single batch
      // holds at most 500 writes, so a collection with more than 500 old
      // notifications made the whole job fail.
      const deleted = await deleteWhere(
        () =>
          db.collection('notifications')
            .where('createdAt', '<', timestamp)
            .orderBy('createdAt'),
        undefined,
        guard,
      );

      if (deleted === 0) {
        return { success: true, message: 'There was nothing to clean' };
      }

      return {
        success: true,
        message: `Deleted ${deleted} old notifications`,
      };
    }

    if (task === 'archiveRooms') {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const timestamp = firestore.Timestamp.fromDate(ninetyDaysAgo);

      // The rooms are archived **page by page** — see above.
      const archived = await updateWhere(
        () =>
          db.collection('rooms')
            .where('status', '==', 'inactive')
            .where('updatedAt', '<', timestamp)
            .orderBy('updatedAt'),
        () => ({
          status: 'inactive',
          archivedAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        }),
        guard,
      );

      if (archived === 0) {
        return { success: true, message: 'There was nothing to archive' };
      }

      return {
        success: true,
        message: `Archived ${archived} inactive rooms`,
      };
    }

    throw new functions.https.HttpsError(
      'invalid-argument',
      'Unknown maintenance task',
    );
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error running maintenance task:', error);
    throw new functions.https.HttpsError('internal', 'The task could not be run');
  }
});

// ============================================
// SCHEDULED: Archive Inactive Rooms (Daily)
// ============================================
export const archiveInactiveRooms = functions.pubsub
  .schedule('0 3 * * *') // 3 AM daily
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const timestamp = firestore.Timestamp.fromDate(ninetyDaysAgo);

      // The rooms are archived **page by page** — a single batch holds at
      // most 500 writes, so more than 500 inactive rooms made the whole job
      // fail with an `INVALID_ARGUMENT` error.
      const archived = await updateWhere(
        () =>
          db.collection('rooms')
            .where('status', '==', 'inactive')
            .where('updatedAt', '<', timestamp)
            .orderBy('updatedAt'),
        () => ({
          status: 'inactive',
          archivedAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        }),
      );

      console.log(`Archived ${archived} inactive rooms`);
      return null;
    } catch (error) {
      console.error('Error archiving rooms:', error);
      // Report the failure so Cloud Scheduler / the Functions runtime retries
      // the maintenance task instead of recording a false success.
      throw error;
    }
  });

// ============================================
// SCHEDULED: Clean Old Notifications + Expired OTPs (Daily)
// ============================================
export const cleanOldNotifications = functions.pubsub
  .schedule('0 4 * * *') // 4 AM daily
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const timestamp = firestore.Timestamp.fromDate(thirtyDaysAgo);

      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      // The notifications are deleted **page by page** — a single batch
      // holds at most 500 writes.
      const deletedNotifications = await deleteWhere(() =>
        db.collection('notifications')
          .where('createdAt', '<', timestamp)
          .orderBy('createdAt'),
      );

      if (deletedNotifications === 0) {
        console.log('No old notifications to clean');
      } else {
        console.log(`Deleted ${deletedNotifications} old notifications`);
      }

      // ---------------------------------------------------------------
      // Expired OTP records.
      //
      // Every sign-up writes two `otpCodes` documents (one per channel)
      // and nothing else ever removes them, so the collection grows
      // without bound. Two passes, both using single-field indexes so no
      // composite index is required:
      //
      //   1. anything older than an hour that was never verified is dead
      //      weight (the code itself expires after 5 minutes);
      //   2. anything older than 30 days is removed regardless — by then
      //      the registration it belonged to has long finished.
      //
      // Verified documents are deliberately kept for 30 days because
      // `completeRegistration` and `registerUserRole` re-read them to
      // prove the address was really verified.
      // ---------------------------------------------------------------
      const oneHourAgo = firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);

      const deletedUnverified = await deleteWhere(
        () =>
          db.collection('otpCodes')
            .where('createdAt', '<', oneHourAgo)
            .orderBy('createdAt'),
        // Only the documents that were **never** verified are deleted — the
        // verified ones are kept for 30 days, because they are the proof
        // that the address really was verified.
        (doc) => doc.get('verified') !== true,
      );
      console.log(`Deleted ${deletedUnverified} expired OTP records`);

      const deletedAncient = await deleteWhere(() =>
        db.collection('otpCodes')
          .where('createdAt', '<', timestamp)
          .orderBy('createdAt'),
      );
      console.log(`Deleted ${deletedAncient} ancient OTP records`);

      // ---------------------------------------------------------------
      // The locks of the transaction references.
      //
      // One document is written for every payment attempt, and it is
      // never removed — so the collection would grow without bound. The
      // lock only has to outlive the payment itself; after 90 days the
      // booking it belongs to is long finished and the reference cannot
      // be replayed any more (the request is not open any more either).
      // ---------------------------------------------------------------
      const ninetyDaysAgoTimestamp = firestore.Timestamp.fromDate(
        ninetyDaysAgo,
      );
      const deletedReferences = await deleteWhere(() =>
        db.collection('paymentReferences')
          .where('createdAt', '<', ninetyDaysAgoTimestamp)
          .orderBy('createdAt'),
      );
      console.log(
        `Deleted ${deletedReferences} old transaction reference locks`,
      );

      // ---------------------------------------------------------------
      // The quota of the OTP sources.
      //
      // The quota counts the sends of **one hour** — when the window is
      // over the counter starts at zero again, so a quota document of an
      // old window is dead weight. It is deleted as soon as the window it
      // belongs to is over (two hours are enough to be on the safe side).
      // ---------------------------------------------------------------
      const twoHoursAgo = firestore.Timestamp.fromMillis(
        Date.now() - 2 * 60 * 60 * 1000,
      );
      const deletedQuotas = await deleteWhere(() =>
        db.collection('otpSendQuota')
          .where('windowStart', '<', twoHoursAgo)
          .orderBy('windowStart'),
      );
      console.log(`Deleted ${deletedQuotas} expired OTP source quotas`);

      // ---------------------------------------------------------------
      // The locks of the booking requests.
      //
      // A lock points at the request that created it. It may only be
      // deleted when that request is **over** — a lock of a request that
      // is still open would let the student send a second request for the
      // same room, which is exactly what the lock is there to prevent.
      //
      // A request that was cancelled or declined is over, and a request
      // that no longer exists at all is over as well.
      // ---------------------------------------------------------------
      const OVER_STATUSES = ['cancelled', 'rejected'];
      const deletedLocks = await deleteWhereAsync(
        () =>
          db.collection('joinRequestLocks')
            .where('updatedAt', '<', ninetyDaysAgoTimestamp)
            .orderBy('updatedAt'),
        async (lock) => {
          const requestId = String(lock.get('requestId') || '');
          if (!requestId) return true;

          const request = await db.collection('joinRequests').doc(requestId).get();
          if (!request.exists) return true;

          return OVER_STATUSES.indexOf(String(request.get('status') || '')) >= 0;
        },
      );
      console.log(`Deleted ${deletedLocks} locks of over booking requests`);

      return null;
    } catch (error) {
      console.error('Error cleaning notifications:', error);
      // Report the failure so the scheduled invocation is retried. The
      // cleanup operations are idempotent and safe to repeat.
      throw error;
    }
  });