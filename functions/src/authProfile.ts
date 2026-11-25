import * as functions from 'firebase-functions/v1';
import * as firestore from 'firebase-admin/firestore';
import * as auth from 'firebase-admin/auth';
import * as crypto from 'crypto';

import { callableHttps } from './appCheck';
import {
  firebaseIdentityFromAuthUser,
  type FirebaseAuthIdentity,
  legacyEmailProofMatches,
  LEGACY_EMAIL_PROOF_SOURCE,
} from './authIdentity';
import {
  assertOtpChallenge,
  emailOtpDocumentId,
  REGISTRATION_ROLLBACK_OPERATIONS,
} from './otp';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = firestore.getFirestore();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 320;

/**
 * How long an authorised email-link operation may be retried.
 *
 * The operation is created only after the email OTP challenge has been
 * accepted. It lets the same request finish if Firebase Auth succeeds but a
 * later Firestore write fails. A fresh email verification is required after
 * this window so an old proof cannot be retained indefinitely.
 */
const EMAIL_LINK_OPERATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a crashed email-link invocation may block a different address.
 *
 * The durable operation keeps the proof authorisation for 24 hours, but the
 * cross-system lock only needs to cover the short Auth/Firestore write. The
 * same operation may always reacquire its own lock for a valid retry.
 */
const EMAIL_LINK_LOCK_TTL_MS = 5 * 60 * 1000;

/** The deterministic id of one account/email linking operation. */
function emailLinkOperationId(uid: string, email: string): string {
  return crypto
    .createHash('sha256')
    .update(`${uid.trim()}:${email.trim().toLowerCase()}`)
    .digest('hex');
}

/**
 * The deterministic id of the per-account email-link lock.
 *
 * Firebase Auth and Firestore cannot be committed in one transaction. Two
 * different email-link requests for the same account could therefore both
 * read the old Auth address and then update Auth in an order which does not
 * match the order in which their profile transactions commit. This lock
 * serializes those cross-system writes and is released only after the live
 * Auth state has been copied to the profile.
 */
function emailLinkLockId(uid: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(uid.trim())
    .digest('hex');
  return `lock_${digest}`;
}

/** The hash stored for a one-time email-link challenge. */
function challengeHash(challenge: string): string {
  return crypto.createHash('sha256').update(challenge).digest('hex');
}

/** Compares two challenge hashes without leaking their contents by timing. */
function challengeHashMatches(expected: unknown, challenge: string): boolean {
  if (typeof expected !== 'string' || !expected) return false;
  const actualBuffer = Buffer.from(challengeHash(challenge), 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

/** The millisecond value of a Firestore timestamp-like field. */
function timestampMillis(value: unknown): number | null {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    const millis = (value as { toMillis: () => number }).toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

/** The status codes returned by Firebase Auth for a duplicate address. */
function isEmailAlreadyInUse(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code || '').trim();
  return (
    code === 'auth/email-already-exists' ||
    code === 'auth/email-already-in-use' ||
    code === 'auth/duplicate-identifier'
  );
}

/** Whether Firestore says that a document already exists. */
function isAlreadyExists(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code || '').trim();
  const message = String((error as { message?: unknown })?.message || '');
  return (
    code === 'already-exists' ||
    code === '6' ||
    message.includes('ALREADY_EXISTS') ||
    message.includes('already exists')
  );
}

/** Whether Firebase Auth says that the account no longer exists. */
function isAuthUserNotFound(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code || '').trim();
  const message = String((error as { message?: unknown })?.message || '');
  return code === 'auth/user-not-found' || message.includes('auth/user-not-found');
}

/** The shortest delay before a failed rollback is retried. */
const ROLLBACK_RETRY_BASE_MS = 5 * 60 * 1000;

/** The longest delay before a failed rollback is retried. */
const ROLLBACK_RETRY_MAX_MS = 60 * 60 * 1000;

/** How many rollback markers one scheduled worker pass may process. */
const ROLLBACK_RETRY_BATCH_SIZE = 50;

type RegistrationRollbackResult =
  | 'deleted'
  | 'registrationCompleted'
  | 'skipped';

/**
 * Deletes the Auth account of one durably-requested registration rollback.
 *
 * The marker and the profile are checked in a transaction before the
 * non-transactional Auth call. A registration which committed first changes
 * the marker to `registrationCompleted` and the account is kept. Otherwise
 * the marker remains `rollbackRequested`, so a concurrent registration is
 * refused, and only then is the Auth account deleted.
 */
async function attemptRegistrationRollback(
  uid: string,
  operationRef: firestore.DocumentReference,
): Promise<RegistrationRollbackResult> {
  const userRef = db.collection('users').doc(uid);
  const shouldDelete = await db.runTransaction(async (transaction) => {
    const [operationSnapshot, profileSnapshot] = await Promise.all([
      transaction.get(operationRef),
      transaction.get(userRef),
    ]);

    if (
      profileSnapshot.exists &&
      profileSnapshot.get('registrationCompleted') === true
    ) {
      transaction.set(
        operationRef,
        {
          uid,
          status: 'registrationCompleted',
          observedAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return false;
    }

    if (
      !operationSnapshot.exists ||
      String(operationSnapshot.get('status') || '') !== 'rollbackRequested'
    ) {
      return false;
    }

    const attempts = Math.max(
      1,
      Number(operationSnapshot.get('attempts') || 0) + 1,
    );
    const retryDelay = Math.min(
      ROLLBACK_RETRY_MAX_MS,
      ROLLBACK_RETRY_BASE_MS * Math.pow(2, attempts - 1),
    );
    transaction.set(
      operationRef,
      {
        uid,
        status: 'rollbackRequested',
        attempts,
        lastAttemptAt: firestore.FieldValue.serverTimestamp(),
        nextAttemptAt: firestore.Timestamp.fromMillis(Date.now() + retryDelay),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return true;
  });

  if (!shouldDelete) {
    const snapshot = await operationRef.get();
    return snapshot.get('status') === 'registrationCompleted'
      ? 'registrationCompleted'
      : 'skipped';
  }

  try {
    await auth.getAuth().deleteUser(uid);
  } catch (error) {
    if (!isAuthUserNotFound(error)) {
      const message = String((error as { message?: unknown })?.message || error)
        .slice(0, 300);
      await operationRef.set(
        {
          lastError: message,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      throw error;
    }
  }

  await operationRef.set(
    {
      status: 'authDeleted',
      completedAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return 'deleted';
}

/**
 * Retries durable registration rollbacks whose Auth deletion was transiently
 * unavailable.
 *
 * The client cannot be trusted to keep retrying after it has lost its
 * network connection. A scheduled worker therefore finishes the deletion
 * without asking the client for another proof.
 */
export async function processRegistrationRollbackOperations(): Promise<{
  inspected: number;
  deleted: number;
  completed: number;
  skipped: number;
  failed: number;
}> {
  const snapshot = await db
    .collection(REGISTRATION_ROLLBACK_OPERATIONS)
    .where('status', '==', 'rollbackRequested')
    .limit(ROLLBACK_RETRY_BATCH_SIZE)
    .get();

  const summary = {
    inspected: snapshot.size,
    deleted: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
  };

  for (const operation of snapshot.docs) {
    const uid = String(operation.get('uid') || '').trim() || operation.id;
    if (!uid) {
      summary.skipped += 1;
      continue;
    }

    const nextAttemptAt = timestampMillis(operation.get('nextAttemptAt'));
    if (nextAttemptAt !== null && nextAttemptAt > Date.now()) {
      summary.skipped += 1;
      continue;
    }

    try {
      const result = await attemptRegistrationRollback(
        uid,
        operation.ref,
      );
      if (result === 'deleted') summary.deleted += 1;
      else if (result === 'registrationCompleted') summary.completed += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      console.error('Could not retry an incomplete registration rollback:', error);
    }
  }

  return summary;
}

/**
 * Rolls back a sign-up which failed before the registration was committed.
 *
 * The client calls this only for the account which it just created. The
 * server compares the live Firestore profile with a durable rollback marker
 * in the same transaction as the registration callables. Therefore exactly
 * one of the two outcomes wins:
 *
 *  - registration committed first: the account is kept and the durable role
 *    claim worker can finish publishing its Auth claim;
 *  - rollback committed first: the registration transaction is refused and
 *    the incomplete Auth account is deleted.
 *
 * A blanket client-side `deleteUser` would be unsafe because it could erase
 * an account whose Firestore registration had already committed.
 */
export const rollbackIncompleteRegistration = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in before rolling back the registration.',
      );
    }

    const expectedUid = String(data?.uid || '').trim();
    if (!expectedUid || expectedUid !== context.auth.uid) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The rollback request does not match this account.',
      );
    }

    const uid = context.auth.uid;
    const userRef = db.collection('users').doc(uid);
    const operationRef = db
      .collection(REGISTRATION_ROLLBACK_OPERATIONS)
      .doc(uid);

    const shouldDelete = await db.runTransaction(async (transaction) => {
      const [profileSnapshot, operationSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(operationRef),
      ]);

      if (
        profileSnapshot.exists &&
        profileSnapshot.get('registrationCompleted') === true
      ) {
        transaction.set(
          operationRef,
          {
            uid,
            status: 'registrationCompleted',
            observedAt: firestore.FieldValue.serverTimestamp(),
            updatedAt: firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return false;
      }

      if (
        operationSnapshot.exists &&
        String(operationSnapshot.get('status') || '') === 'rollbackRequested'
      ) {
        return true;
      }

      transaction.set(
        operationRef,
        {
          operationId: uid,
          uid,
          status: 'rollbackRequested',
          requestedAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return true;
    });

    if (!shouldDelete) {
      return {
        success: true,
        rolledBack: false,
        registrationCompleted: true,
      };
    }

    let rollbackResult: RegistrationRollbackResult;
    try {
      rollbackResult = await attemptRegistrationRollback(uid, operationRef);
    } catch (error) {
      console.error('Could not roll back the incomplete Auth account:', error);
      throw new functions.https.HttpsError(
        'internal',
        'The incomplete registration could not be rolled back yet.',
      );
    }

    if (rollbackResult === 'registrationCompleted') {
      // The registration committed after the first rollback transaction but
      // before the Auth deletion. The marker keeps that account alive and the
      // caller must be told that it was **not** rolled back.
      return {
        success: true,
        rolledBack: false,
        registrationCompleted: true,
      };
    }

    if (rollbackResult === 'skipped') {
      // Another retry may have completed the marker while this invocation was
      // running. Read the durable state instead of guessing from an
      // intermediate result.
      const marker = await operationRef.get();
      if (String(marker.get('status') || '') === 'registrationCompleted') {
        return {
          success: true,
          rolledBack: false,
          registrationCompleted: true,
        };
      }
      return {
        success: true,
        rolledBack: String(marker.get('status') || '') === 'authDeleted',
        registrationCompleted: false,
      };
    }

    return {
      success: true,
      rolledBack: true,
      registrationCompleted: false,
    };
  },
);

/**
 * Acquires the per-account email-link lock.
 *
 * The first lock is created with an explicit existence precondition. A second
 * request for a different address observes that live lock and is refused
 * before it can consume its proof or update Auth. A retry of the exact same
 * authorised operation may take the lock over, and an abandoned lock becomes
 * replaceable after its short lease expires.
 */
async function acquireEmailLinkLock(options: {
  lockRef: firestore.DocumentReference;
  uid: string;
  operationId: string;
  email: string;
  challenge: string;
  ownerToken: string;
}): Promise<void> {
  const {
    lockRef,
    uid,
    operationId,
    email,
    challenge,
    ownerToken,
  } = options;
  const lockData = {
    operationId,
    uid,
    email,
    challengeHash: challengeHash(challenge),
    ownerToken,
    status: 'active',
    acquiredAt: firestore.FieldValue.serverTimestamp(),
    expiresAt: firestore.Timestamp.fromMillis(
      Date.now() + EMAIL_LINK_LOCK_TTL_MS,
    ),
    updatedAt: firestore.FieldValue.serverTimestamp(),
  };

  try {
    await lockRef.create(lockData);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    await db.runTransaction(async (transaction) => {
      const lockSnapshot = await transaction.get(lockRef);
      if (!lockSnapshot.exists) {
        transaction.create(lockRef, lockData);
        return;
      }
      const lock = lockSnapshot.data() as Record<string, any>;
      const lockExpiresAt = timestampMillis(lock.expiresAt);
      const sameOperation =
        String(lock.operationId || '') === operationId &&
        String(lock.uid || '').trim() === uid &&
        String(lock.email || '').trim().toLowerCase() === email &&
        challengeHashMatches(lock.challengeHash, challenge);
      const expired =
        lockExpiresAt !== null && lockExpiresAt <= Date.now();
      if (!sameOperation && !expired) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Another email address is already being linked to this account.',
        );
      }
      transaction.set(lockRef, lockData, { merge: true });
    });
  }

  const acquired = await lockRef.get();
  if (String(acquired.get('ownerToken') || '') !== ownerToken) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Another email address is already being linked to this account.',
    );
  }
}

/**
 * Releases one email-link lock which belongs to the supplied operation.
 *
 * A failed attempt must not leave the account blocked until the proof window
 * expires. The lock is removed only when it still names the exact operation
 * and challenge, so a late cleanup can never release a newer request.
 */
async function releaseEmailLinkLock(
  uid: string,
  operationId: string,
  email: string,
  challenge: string,
  ownerToken: string,
): Promise<void> {
  const lockRef = db
    .collection('emailLinkOperations')
    .doc(emailLinkLockId(uid));
  try {
    await db.runTransaction(async (transaction) => {
      const lockSnapshot = await transaction.get(lockRef);
      if (!lockSnapshot.exists) return;
      const lock = lockSnapshot.data() as Record<string, any>;
      if (
        String(lock.operationId || '') !== operationId ||
        String(lock.uid || '').trim() !== uid ||
        String(lock.email || '').trim().toLowerCase() !== email ||
        !challengeHashMatches(lock.challengeHash, challenge) ||
        String(lock.ownerToken || '') !== ownerToken
      ) {
        return;
      }
      transaction.delete(lockRef);
    });
  } catch (error) {
    // The durable operation and its proof window remain the retry mechanism.
    // A lock-cleanup failure must not hide the original request error.
    console.error('Could not release the email-link lock:', error);
  }
}

/**
 * Adds a verified email address to a phone-first account.
 *
 * The existing StayServe email OTP is the ownership proof. The challenge is
 * bound to the signed-in uid and is consumed before Firebase Auth is changed.
 * A durable, server-only operation document records that authorisation so
 * the exact same request can be retried if either of the two writes fails.
 *
 * The operation is deliberately split into three phases:
 *
 *   1. authorise and consume the OTP challenge;
 *   2. update Firebase Auth, which is the authority for the address;
 *   3. copy the resulting Auth state to the Firestore profile.
 *
 * If phase 2 succeeds and phase 3 fails, the next retry observes the same
 * verified address in Firebase Auth and finishes phase 3 without requiring a
 * second SMS/email code. A different challenge cannot reuse the operation.
 */
export const linkVerifiedEmail = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Please sign in before adding an email address.',
    );
  }

  const uid = context.auth.uid;
  const email = String(data?.email || '').trim().toLowerCase();
  const challenge = String(data?.challenge || '').trim();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Enter a valid email address',
    );
  }
  if (!challenge) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Verify the email address before adding it.',
    );
  }

  const userRef = db.collection('users').doc(uid);
  const otpRef = db.collection('otpCodes').doc(emailOtpDocumentId(email));
  const operationRef = db
    .collection('emailLinkOperations')
    .doc(emailLinkOperationId(uid, email));
  const lockRef = db
    .collection('emailLinkOperations')
    .doc(emailLinkLockId(uid));
  const suppliedChallengeHash = challengeHash(challenge);
  const lockOwnerToken = crypto.randomUUID();
  let lockAcquired = false;

  try {
    // Read Auth before consuming the proof. A phone-first account must not
    // silently replace an address which is already attached to it.
    let firebaseUser: auth.UserRecord;
    try {
      firebaseUser = await auth.getAuth().getUser(uid);
    } catch (error) {
      console.error('Could not read the Firebase Auth account:', error);
      throw new functions.https.HttpsError(
        'not-found',
        'Your authentication account no longer exists.',
      );
    }
    let existingFirebaseEmail = String(firebaseUser.email || '')
      .trim()
      .toLowerCase();
    if (
      existingFirebaseEmail &&
      existingFirebaseEmail !== email &&
      firebaseUser.emailVerified
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This account already uses a different verified email address.',
      );
    }

    await acquireEmailLinkLock({
      lockRef,
      uid,
      operationId: operationRef.id,
      email,
      challenge,
      ownerToken: lockOwnerToken,
    });
    lockAcquired = true;

    // Re-read the live Auth record after the lock was acquired and before the
    // proof is consumed. A request which started while another address was
    // being linked must not consume its own proof after that link has won.
    firebaseUser = await auth.getAuth().getUser(uid);
    existingFirebaseEmail = String(firebaseUser.email || '')
      .trim()
      .toLowerCase();
    if (
      existingFirebaseEmail &&
      existingFirebaseEmail !== email &&
      firebaseUser.emailVerified
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This account already uses a different verified email address.',
      );
    }

    // Phase 1: consume the proof and create the
    // durable retry record. If the same operation already exists, its challenge
    // hash is the authorisation for a retry; the consumed OTP itself is not
    // inspected a second time.
    await db.runTransaction(async (transaction) => {
      const [userSnapshot, otpSnapshot, operationSnapshot, lockSnapshot] =
        await Promise.all([
          transaction.get(userRef),
          transaction.get(otpRef),
          transaction.get(operationRef),
          transaction.get(lockRef),
        ]);

      if (!userSnapshot.exists) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Your account profile is still being created. Please try again.',
        );
      }
      if (
        userSnapshot.get('registrationCompleted') !== true ||
        userSnapshot.get('isActive') !== true
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Complete your registration before adding an email address.',
        );
      }

      let operationIsAuthorised = false;
      let operationExpiresAt = Date.now() + EMAIL_LINK_OPERATION_TTL_MS;
      if (operationSnapshot.exists) {
        const operation = operationSnapshot.data() as Record<string, any>;
        const operationUid = String(operation.uid || '').trim();
        const operationEmail = String(operation.email || '')
          .trim()
          .toLowerCase();
        if (operationUid !== uid || operationEmail !== email) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'The email-linking request does not match this account.',
          );
        }

        const status = String(operation.status || '').trim();
        const expiresAt = timestampMillis(operation.expiresAt);
        const sameChallenge = challengeHashMatches(
          operation.challengeHash,
          challenge,
        );
        // A completed operation is retryable only while its original proof
        // window remains open. Otherwise an old, consumed email code could
        // indefinitely restore an address which was later removed from Auth.
        const retryIsAuthorised =
          sameChallenge &&
          expiresAt !== null &&
          expiresAt > Date.now() &&
          (status === 'authorised' || status === 'complete');
        if (retryIsAuthorised) {
          operationIsAuthorised = true;
          operationExpiresAt = expiresAt;
        }
      }

      if (!lockSnapshot.exists) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The email-linking request is no longer available. Please verify again.',
        );
      }
      const lock = lockSnapshot.data() as Record<string, any>;
      if (
        String(lock.operationId || '') !== operationRef.id ||
        String(lock.uid || '').trim() !== uid ||
        String(lock.email || '').trim().toLowerCase() !== email ||
        !challengeHashMatches(lock.challengeHash, challenge) ||
        String(lock.ownerToken || '') !== lockOwnerToken
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Another email address is already being linked to this account.',
        );
      }

      if (!operationIsAuthorised) {
        // No usable operation exists. The current OTP challenge must therefore
        // be a fresh, unused proof bound to this uid.
        assertOtpChallenge(otpSnapshot, 'email', challenge, uid);
        transaction.set(
          otpRef,
          {
            challengeUsed: true,
            challengeConsumedAt: firestore.FieldValue.serverTimestamp(),
            verifiedByUid: uid,
          },
          { merge: true },
        );
        transaction.set(
          operationRef,
          {
            operationId: operationRef.id,
            uid,
            email,
            challengeHash: suppliedChallengeHash,
            status: 'authorised',
            createdAt: firestore.FieldValue.serverTimestamp(),
            expiresAt: firestore.Timestamp.fromMillis(operationExpiresAt),
            updatedAt: firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
    });

    // Phase 2: update Firebase Auth. Read it again after the lock was acquired
    // so a request which started earlier cannot act on a stale address.
    try {
      firebaseUser = await auth.getAuth().getUser(uid);
      existingFirebaseEmail = String(firebaseUser.email || '')
        .trim()
        .toLowerCase();
      if (
        existingFirebaseEmail &&
        existingFirebaseEmail !== email &&
        firebaseUser.emailVerified
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This account already uses a different verified email address.',
        );
      }
      if (!(existingFirebaseEmail === email && firebaseUser.emailVerified)) {
        await auth.getAuth().updateUser(uid, {
          email,
          emailVerified: true,
        });
      }

      // Re-read the live record after the update. The profile copy below must
      // be based on the final Auth state, not on the value which happened to be
      // returned by the update call.
      firebaseUser = await auth.getAuth().getUser(uid);
      const finalIdentity = firebaseIdentityFromAuthUser(firebaseUser);
      if (!finalIdentity.emailVerified || finalIdentity.email !== email) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The account email changed while it was being linked. Please try again.',
        );
      }
    } catch (error) {
      if (error instanceof functions.https.HttpsError) throw error;
      if (isEmailAlreadyInUse(error)) {
        throw new functions.https.HttpsError(
          'already-exists',
          'That email address is already connected to another account.',
        );
      }
      console.error('Could not add the verified email to Firebase Auth:', error);
      throw new functions.https.HttpsError(
        'internal',
        'The verified email could not be added. Please try again.',
      );
    }

    // Phase 3: copy the final Auth result to the profile, mark the durable
    // operation complete and release the account lock in one transaction.
    await db.runTransaction(async (transaction) => {
      const [snapshot, operationSnapshot, lockSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(operationRef),
        transaction.get(lockRef),
      ]);
      if (!snapshot.exists) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Your account profile is still being created. Please try again.',
        );
      }
      if (
        snapshot.get('registrationCompleted') !== true ||
        snapshot.get('isActive') !== true
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Complete your registration before adding an email address.',
        );
      }
      if (!operationSnapshot.exists) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The email-linking request is no longer available. Please verify again.',
        );
      }
      const operation = operationSnapshot.data() as Record<string, any>;
      if (
        String(operation.uid || '').trim() !== uid ||
        String(operation.email || '').trim().toLowerCase() !== email ||
        !challengeHashMatches(operation.challengeHash, challenge)
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The email-linking request does not match this account.',
        );
      }
      if (!lockSnapshot.exists) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The email-linking request is no longer available. Please verify again.',
        );
      }
      const lock = lockSnapshot.data() as Record<string, any>;
      if (
        String(lock.operationId || '') !== operationRef.id ||
        String(lock.uid || '').trim() !== uid ||
        String(lock.email || '').trim().toLowerCase() !== email ||
        !challengeHashMatches(lock.challengeHash, challenge) ||
        String(lock.ownerToken || '') !== lockOwnerToken
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Another email address is already being linked to this account.',
        );
      }

      const profile = snapshot.data() as Record<string, any>;
      const identity = firebaseIdentityFromAuthUser(firebaseUser);
      const currentEmail = String(profile.email || '').trim().toLowerCase();
      const currentEmailVerified = profile.emailVerified === true;
      const legacyProofMatches = legacyEmailProofMatches(
        profile,
        identity.email,
      );
      const updates: Record<string, unknown> = {
        email: identity.email,
        emailVerified: identity.emailVerified,
        authProviders: identity.providers,
        legacyEmailProofSource: legacyProofMatches
          ? LEGACY_EMAIL_PROOF_SOURCE
          : null,
        legacyEmailProofEmail: legacyProofMatches ? identity.email : null,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      };
      if (
        identity.emailVerified &&
        (!currentEmailVerified || currentEmail !== identity.email)
      ) {
        updates.emailVerifiedAt = firestore.FieldValue.serverTimestamp();
      } else if (
        !identity.emailVerified &&
        (currentEmailVerified || profile.emailVerifiedAt != null)
      ) {
        updates.emailVerifiedAt = null;
      }
      transaction.set(userRef, updates, { merge: true });
      transaction.set(
        operationRef,
        {
          status: 'complete',
          completedAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.delete(lockRef);
    });

  return {
    success: true,
    email,
    emailVerified: true,
  };
  } catch (error) {
    if (lockAcquired) {
      await releaseEmailLinkLock(
        uid,
        operationRef.id,
        email,
        challenge,
        lockOwnerToken,
      );
    }
    throw error;
  }
});

/**
 * Synchronises the Firebase-verified contact fields into the Firestore
 * profile.
 *
 * The client cannot write `phone`, `phoneVerified`, `emailVerified` or the
 * provider list directly. It refreshes its Firebase session after a phone or
 * Google challenge and calls this function. The server then copies the live
 * Firebase Auth facts into the profile.
 *
 * The operation is deliberately idempotent: a retry after a lost response
 * simply writes the same facts again. The email, email-verification flag and
 * phone identities are always read from the **live** Firebase Auth record.
 * A legacy one-time email proof is retained only under its own source marker
 * and can never preserve a stale verified address. An ID token can remain
 * valid for a short time after a provider is unlinked; consulting that old
 * token would therefore leave a revoked contact marked as verified.
 */
export const syncAuthProfile = callableHttps.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Please sign in before updating your verification details.',
    );
  }

  const uid = context.auth.uid;
  const userRef = db.collection('users').doc(uid);

  // Firebase only exposes `phoneNumber` on a user record after the phone
  // provider has been linked and verified. Reading the record directly makes
  // an unlink effective immediately, even when the caller still presents an
  // older — but cryptographically valid — ID token.
  let identity: FirebaseAuthIdentity;
  try {
    const firebaseUser = await auth.getAuth().getUser(uid);
    identity = firebaseIdentityFromAuthUser(firebaseUser);
  } catch (error) {
    const code = String((error as { code?: unknown })?.code || '').trim();
    console.error('Could not read the live Firebase Auth identity:', error);
    throw new functions.https.HttpsError(
      code === 'auth/user-not-found' ? 'failed-precondition' : 'internal',
      code === 'auth/user-not-found'
        ? 'Your authentication account no longer exists.'
        : 'The account state could not be verified. Please try again.',
    );
  }

  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Your account profile is still being created. Please try again.',
      );
    }

    const currentEmail = String(snapshot.get('email') || '').trim().toLowerCase();
    const currentEmailVerified = snapshot.get('emailVerified') === true;
    const currentPhone = String(snapshot.get('phone') || '').trim();
    const currentPhoneVerified = snapshot.get('phoneVerified') === true;
    const profile = snapshot.data() as Record<string, any>;

    // Firebase Auth is authoritative for both the current address and its
    // verification flag. A removed or replaced address must not survive in
    // the profile merely because an older copy was marked verified.
    const email = identity.email;
    const emailVerified = identity.emailVerified;
    const legacyProofMatches = legacyEmailProofMatches(profile, identity.email);

    // The live Auth record is authoritative for the phone. In particular, a
    // missing phone revokes the previous verified-phone grant; an older ID
    // token must not be able to preserve it.
    const phone = identity.phone;
    const phoneVerified = identity.phoneVerified;

    const providers = identity.providers;

    const updates: Record<string, unknown> = {
      email,
      emailVerified,
      legacyEmailProofSource: legacyProofMatches
        ? LEGACY_EMAIL_PROOF_SOURCE
        : null,
      legacyEmailProofEmail: legacyProofMatches ? identity.email : null,
      phone: phone || null,
      phoneVerified,
      authProviders: providers,
      lastAuthSyncAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    };

    if (
      identity.emailVerified &&
      (!currentEmailVerified || currentEmail !== identity.email)
    ) {
      updates.emailVerifiedAt = firestore.FieldValue.serverTimestamp();
    } else if (
      !identity.emailVerified &&
      (currentEmailVerified || profile.emailVerifiedAt != null)
    ) {
      updates.emailVerifiedAt = null;
    }
    if (
      phoneVerified &&
      (!currentPhoneVerified || currentPhone !== phone)
    ) {
      updates.phoneVerifiedAt = firestore.FieldValue.serverTimestamp();
    }

    transaction.set(userRef, updates, { merge: true });

    return {
      email,
      emailVerified,
      phone: phone || null,
      phoneVerified,
      providers,
    };
  });

  return {
    success: true,
    ...result,
  };
});
