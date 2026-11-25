import * as functions from 'firebase-functions/v1';
import * as firestore from 'firebase-admin/firestore';
import * as authSdk from 'firebase-admin/auth';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = firestore.getFirestore();

/**
 * Confirms that Firebase still has a verified phone linked to the account.
 *
 * The Firestore profile is a server-owned cache of the Firebase Auth facts.
 * It is necessary for efficient rule evaluation, but it cannot by itself
 * detect a phone provider which a modified client unlinked without calling
 * `syncAuthProfile`. Firebase Auth has no provider-update trigger, so every
 * sensitive callable reads the live user record before it grants tenant
 * access. A failed lookup fails closed.
 */
export async function assertLiveVerifiedPhone(uid: string): Promise<void> {
  if (!uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Please sign in before using this feature.',
    );
  }

  let user: authSdk.UserRecord;
  try {
    user = await authSdk.getAuth().getUser(uid);
  } catch (error) {
    const code = String((error as { code?: unknown })?.code || '').trim();
    console.error('Could not read the live Firebase Auth identity:', error);
    throw new functions.https.HttpsError(
      code === 'auth/user-not-found' ? 'failed-precondition' : 'permission-denied',
      code === 'auth/user-not-found'
        ? 'Your authentication account no longer exists.'
        : 'The account state could not be verified. Please try again.',
    );
  }

  const phone = String(user.phoneNumber || '').trim();
  if (!phone) {
    // Revoke a stale cached grant as soon as the live Auth lookup proves that
    // the phone provider was unlinked. The write is best-effort because the
    // authorization decision below already fails closed.
    await cacheLivePhoneState(uid, null, false);
    throw new functions.https.HttpsError(
      'permission-denied',
      'Verify your phone number before using StayServe.',
    );
  }

  // Firebase Auth is authoritative. The Firestore flag is only a cache which
  // lets Firestore/Storage rules evaluate the service gate. Backfill it here
  // so a legitimate legacy profile which predates `phoneVerified` is not
  // locked out after its live phone has been confirmed.
  await cacheLivePhoneState(uid, phone, true);
}

/**
 * Copies the live phone fact into the server-owned profile cache.
 *
 * A failed cache write does not turn a valid live Auth identity into an
 * invalid one. The callable can still authorize the request, while the
 * normal `syncAuthProfile` retry repairs the rules-facing cache.
 */
async function cacheLivePhoneState(
  uid: string,
  phone: string | null,
  phoneVerified: boolean,
): Promise<void> {
  try {
    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(userRef);
      if (!snapshot.exists) return;

      const currentPhone = String(snapshot.get('phone') || '').trim();
      const currentVerified = snapshot.get('phoneVerified') === true;
      if (currentPhone === (phone || '') && currentVerified === phoneVerified) {
        return;
      }

      const update: Record<string, unknown> = {
        phone: phone || null,
        phoneVerified,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      };
      if (phoneVerified && (!currentVerified || currentPhone !== phone)) {
        update.phoneVerifiedAt = firestore.FieldValue.serverTimestamp();
      }
      transaction.set(userRef, update, { merge: true });
    });
  } catch (error) {
    console.error('Could not refresh the cached live phone state:', error);
  }
}

/** The live profile fields used by the privileged-account checks. */
export interface LiveAccountState {
  exists: boolean;
  registrationCompleted: unknown;
  isActive: unknown;
  role: unknown;
}

/** Whether a live profile may act as an administrator. */
export function canActAsAdmin(profile: LiveAccountState): boolean {
  return (
    profile.exists &&
    profile.registrationCompleted === true &&
    profile.isActive === true &&
    String(profile.role ?? '').trim().toLowerCase() === 'admin'
  );
}

/**
 * Reads a set of user profiles in a stable document-path order.
 *
 * Two administrators who act on each other at the same time would otherwise
 * acquire the same two profile locks in opposite orders. A fixed order makes
 * the transactions abort and retry instead of deadlocking.
 */
export async function readUserProfilesInPathOrder(
  transaction: firestore.Transaction,
  uids: string[],
): Promise<Map<string, firestore.DocumentSnapshot>> {
  const unique = Array.from(new Set(uids.filter(Boolean))).sort();
  const snapshots = new Map<string, firestore.DocumentSnapshot>();
  for (const uid of unique) {
    const snapshot = await transaction.get(db.collection('users').doc(uid));
    snapshots.set(uid, snapshot);
  }
  return snapshots;
}

/**
 * The state of an account.
 *
 * Disabling an account in the Firebase console (or through the admin
 * panel of the app) sets `isActive: false` **and** disables the Auth
 * account. Disabling the Auth account stops the *next* sign-in — but the
 * identity token that is already on the device stays valid until it
 * expires (up to an hour).
 *
 * Without this check a banned user could keep using the app with the token
 * they already had: they could book rooms, send messages and — with the
 * token of an admin — call the admin functions.
 *
 * The check is therefore made **on the server**, in every function that
 * changes something.
 */
export async function assertActiveAccount(uid: string): Promise<void> {
  if (!uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Please sign in before using this feature.',
    );
  }

  let snapshot: firestore.DocumentSnapshot;
  try {
    snapshot = await db.collection('users').doc(uid).get();
  } catch (error) {
    // A failed authorization lookup must **not** fail open. Otherwise a
    // banned account can keep using the API during a transient Firestore
    // error.
    console.error(`Could not read the profile of ${uid}:`, error);
    throw new functions.https.HttpsError(
      'permission-denied',
      'The account state could not be verified. Please try again.',
    );
  }

  if (!snapshot.exists) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Complete your registration before using this feature.',
    );
  }

  // `registrationCompleted` is written by the server only after the OTP
  // registration flow has finished. New Auth accounts must not be usable
  // before that point.
  if (snapshot.get('registrationCompleted') !== true) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Complete your registration before using this feature.',
    );
  }

  if (snapshot.get('isActive') !== true) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'This account has been disabled. Please contact support.',
    );
  }

  // Administrators operate the platform and are not tenants. Every student
  // and owner, on the other hand, has to prove control of a phone number
  // before the account may use the booking, payment or messaging services.
  // The live Firebase Auth record is authoritative; the profile flag is only
  // a cache for Firestore/Storage rules and may be absent on a legitimate
  // legacy profile.
  const role = String(snapshot.get('role') || '')
    .trim()
    .toLowerCase();
  if (canActAsAdmin({
    exists: snapshot.exists,
    registrationCompleted: snapshot.get('registrationCompleted'),
    isActive: snapshot.get('isActive'),
    role,
  })) {
    return;
  }

  if (role === 'student' || role === 'owner') {
    await assertLiveVerifiedPhone(uid);
    return;
  }

  throw new functions.https.HttpsError(
    'permission-denied',
    'This account cannot use the StayServe services.',
  );
}

/**
 * Checks the **live** student role of an account that wants to book a room.
 *
 * Booking is a student-only operation. The role is read from the live
 * Firestore profile so an owner cannot bypass this check with an old token
 * or by changing a field on the client.
 */
export async function assertLiveStudent(uid: string): Promise<void> {
  if (!uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Please sign in before using this feature.',
    );
  }

  let snapshot: firestore.DocumentSnapshot;
  try {
    // The role, registration state and active flag are read from the same
    // snapshot. Reading them separately could combine values from two
    // different versions of the profile.
    snapshot = await db.collection('users').doc(uid).get();
  } catch (error) {
    console.error(`Could not read the profile of ${uid}:`, error);
    throw new functions.https.HttpsError(
      'permission-denied',
      'The account state could not be verified. Please try again.',
    );
  }

  if (!snapshot.exists || snapshot.get('registrationCompleted') !== true) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Complete your registration before using this feature.',
    );
  }

  if (snapshot.get('isActive') !== true) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'This account has been disabled. Please contact support.',
    );
  }

  const role = String(snapshot.get('role') || '')
    .trim()
    .toLowerCase();
  if (role !== 'student') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Only student accounts can book rooms.',
    );
  }

  await assertLiveVerifiedPhone(uid);
}

/**
 * Checks the **live** administrator role.
 *
 * The `admin` custom claim is copied into an ID token and remains valid
 * until that token expires. A demoted or banned admin could therefore keep
 * using the old token. The server-side role in Firestore is the source of
 * truth for an administrative operation.
 *
 * This helper is a **preflight check**: it rejects an account which is
 * already known to be ineligible. A protected mutation must read the
 * administrator profile again inside its own transaction, so a demotion
 * which commits between this check and the write is still refused.
 */
export async function assertLiveAdmin(uid: string): Promise<void> {
  if (!uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Please sign in before using this feature.',
    );
  }

  let snapshot: firestore.DocumentSnapshot;
  try {
    // The role, registration state and active flag come from one profile
    // version. Reading them in separate snapshots could combine a live admin
    // role with an account which was banned in between.
    snapshot = await db.collection('users').doc(uid).get();
  } catch (error) {
    console.error(`Could not read the profile of ${uid}:`, error);
    throw new functions.https.HttpsError(
      'permission-denied',
      'The account state could not be verified. Please try again.',
    );
  }

  if (!canActAsAdmin({
    exists: snapshot.exists,
    registrationCompleted: snapshot.get('registrationCompleted'),
    isActive: snapshot.get('isActive'),
    role: snapshot.get('role'),
  })) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Admin access required',
    );
  }
}

/**
 * Checks the **live** owner role.
 *
 * An owner custom claim remains valid in an already-issued ID token until
 * that token expires. The role in the Firestore profile is therefore checked
 * for operations that only an owner may perform, so a demoted or banned owner
 * cannot keep using an old token.
 */
export async function assertLiveOwner(uid: string): Promise<void> {
  if (!uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Please sign in before using this feature.',
    );
  }

  let snapshot: firestore.DocumentSnapshot;
  try {
    snapshot = await db.collection('users').doc(uid).get();
  } catch (error) {
    console.error(`Could not read the profile of ${uid}:`, error);
    throw new functions.https.HttpsError(
      'permission-denied',
      'The account state could not be verified. Please try again.',
    );
  }

  const role = String(snapshot.get('role') || '')
    .trim()
    .toLowerCase();
  if (
    !snapshot.exists ||
    snapshot.get('registrationCompleted') !== true ||
    snapshot.get('isActive') !== true ||
    role !== 'owner'
  ) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Owner access required',
    );
  }

  await assertLiveVerifiedPhone(uid);
}

/**
 * Checks the live role of an account that may be an owner **or** an admin.
 *
 * Some operations have a different scope for the two roles: an owner may
 * only change their own listing, while an admin may act on any listing. The
 * role is still read from the live profile — a stale custom claim is never
 * enough.
 */
export async function assertLiveOwnerOrAdmin(
  uid: string,
): Promise<'owner' | 'admin'> {
  if (!uid) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Please sign in before using this feature.',
    );
  }

  let snapshot: firestore.DocumentSnapshot;
  try {
    snapshot = await db.collection('users').doc(uid).get();
  } catch (error) {
    console.error(`Could not read the profile of ${uid}:`, error);
    throw new functions.https.HttpsError(
      'permission-denied',
      'The account state could not be verified. Please try again.',
    );
  }

  const role = snapshot.exists
    ? String(snapshot.get('role') || '')
        .trim()
        .toLowerCase()
    : '';
  const callerIsAdmin = canActAsAdmin({
    exists: snapshot.exists,
    registrationCompleted: snapshot.get('registrationCompleted'),
    isActive: snapshot.get('isActive'),
    role,
  });
  const callerIsLiveOwner =
    snapshot.exists &&
    snapshot.get('registrationCompleted') === true &&
    snapshot.get('isActive') === true &&
    role === 'owner';
  if (!callerIsAdmin && !callerIsLiveOwner) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Owner or admin access required',
    );
  }

  if (!callerIsAdmin) {
    await assertLiveVerifiedPhone(uid);
  }

  return role as 'owner' | 'admin';
}
