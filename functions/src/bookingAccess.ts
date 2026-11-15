import * as admin from 'firebase-admin';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = admin.firestore();

/**
 * The states of a join request in which the **owner has accepted** it.
 *
 * The owner accepts a request by moving it to `ownerConfirmed`. The student
 * then confirms it (`studentConfirmed`) and payment verification activates
 * the booking (`adminReviewed`). All three mean the same thing for the two
 * features that are built on top of that acceptance:
 *
 *  - the student may **review** the room, and
 *  - the student may see **where** the room is.
 *
 * The check lives here — and only here — so that the two features can never
 * drift apart.
 */
export const OWNER_ACCEPTED_STATUSES = [
  'ownerConfirmed',
  'studentConfirmed',
  'adminReviewed',
  // Legacy spelling of `adminReviewed`; old joined rooms must keep their
  // visit details and review access.
  'admin_reviewed',
];

/**
 * Whether the owner has accepted a request that is in the given state.
 */
export function ownerHasAccepted(status: string): boolean {
  return OWNER_ACCEPTED_STATUSES.indexOf(status) >= 0;
}

/**
 * Whether a booking has reached a payment state that must be settled by an
 * admin instead of being cancelled by one of the two parties.
 *
 * A submitted reference is not proof that the money arrived, but it is a
 * live payment attempt. The request therefore cannot be cancelled underneath
 * the admin: verification activates it, while rejection restores the payable
 * state.
 *
 * The status alone is not enough: the payment fields are what really matter,
 * and the status is only the summary of them.
 */
export function paymentAlreadyMade(request: Record<string, any>): boolean {
  if (request.advancePaid === true) return true;
  if (request.platformCutTaken === true) return true;

  const status = String(request.advancePaymentStatus || '');
  return status === 'submitted' || status === 'verified';
}

/**
 * The join request of `studentId` for `roomId` in a state in which the owner
 * has accepted it — `null` when there is none.
 *
 * The query is constrained to the two parties, so it only ever returns the
 * requests of the student themselves.
 */
export async function findOwnerAcceptedRequest(
  studentId: string,
  roomId: string,
): Promise<{ requestId: string; data: Record<string, any> } | null> {
  const snapshot = await db
    .collection('joinRequests')
    .where('roomId', '==', roomId)
    .where('studentId', '==', studentId)
    .where('status', 'in', OWNER_ACCEPTED_STATUSES)
    .limit(1)
    .get();

  if (snapshot.empty) return null;

  const doc = snapshot.docs[0];
  return {
    requestId: doc.id,
    data: doc.data() as Record<string, any>,
  };
}

/**
 * The name of a user — used to show who wrote a review.
 */
export async function displayNameOf(uid: string): Promise<string> {
  try {
    const snapshot = await db.collection('users').doc(uid).get();
    const name = String(snapshot.get('name') || '').trim();
    if (name) return name;

    const email = String(snapshot.get('email') || '').trim();
    if (email) return email.split('@')[0];

    const user = await admin.auth().getUser(uid);
    return String(user.displayName || user.email || '').split('@')[0];
  } catch (error) {
    console.error('Could not read the name of a user:', error);
    return '';
  }
}
