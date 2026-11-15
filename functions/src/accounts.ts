import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = admin.firestore();

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

  let snapshot: admin.firestore.DocumentSnapshot;
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
}

/**
 * Checks the **live** administrator role.
 *
 * The `admin` custom claim is copied into an ID token and remains valid
 * until that token expires. A demoted or banned admin could therefore keep
 * using the old token. The server-side role in Firestore is the source of
 * truth for an administrative operation.
 */
export async function assertLiveAdmin(uid: string): Promise<void> {
  await assertActiveAccount(uid);

  const snapshot = await db.collection('users').doc(uid).get();
  if (!snapshot.exists || snapshot.get('role') !== 'admin') {
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
  await assertActiveAccount(uid);

  const snapshot = await db.collection('users').doc(uid).get();
  if (!snapshot.exists || snapshot.get('role') !== 'owner') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Owner access required',
    );
  }
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
  await assertActiveAccount(uid);

  const snapshot = await db.collection('users').doc(uid).get();
  const role = snapshot.exists ? String(snapshot.get('role') || '') : '';

  if (role !== 'owner' && role !== 'admin') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Owner or admin access required',
    );
  }

  return role;
}
