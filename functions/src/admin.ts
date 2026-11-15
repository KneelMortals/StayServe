import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import { assertLiveAdmin } from './accounts';
import { isActiveBookingStatus } from './bookings';
import { deleteWhere } from './batches';
import { notify } from './notifications';

const db = admin.firestore();
const auth = admin.auth();

/**
 * The admin surface of the backend.
 *
 * Two things live here that used to live in the client:
 *
 *  - the **admin review** of a booking request, and
 *  - the **deletion of a user account** (with a seven day grace period).
 */

/**
 * Deletes everything that belongs to a user.
 *
 * The Firestore data is deleted **before** the Auth account — the other way
 * round the account was gone while the personal data (rooms, requests,
 * invoices, notifications, conversations) was still in the database: an
 * orphan nobody could ever clean up.
 */
export async function deleteUserEverywhere(uid: string): Promise<void> {
  // ---------------------------------------------------------------------
  // Every document of the user is deleted **page by page**.
  //
  // A Firestore batch holds at most 500 writes, and a query without a
  // limit reads everything that matches it into memory. The old code
  // collected *all* references first and deleted them afterwards — so an
  // account with a lot of rooms, requests or messages either blew the
  // memory of the function or left the account half deleted.
  //
  // The helpers in `./batches` walk through the documents in pages of 300
  // and write at most 400 deletions per batch. Nothing is ever held in
  // memory as a whole.
  // ---------------------------------------------------------------------

  // The user document.
  const userRef = db.collection('users').doc(uid);
  try {
    await userRef.delete();
  } catch (error) {
    console.error(`Failed to delete the profile of ${uid}:`, error);
  }

  // The rooms of the user.
  await deleteWhere(() =>
    db.collection('rooms')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  // The join requests — as the student and as the owner.
  await deleteWhere(() =>
    db.collection('joinRequests')
      .where('studentId', '==', uid)
      .orderBy('__name__'),
  );

  await deleteWhere(() =>
    db.collection('joinRequests')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  // The commission invoices — as the owner and as the tenant.
  await deleteWhere(() =>
    db.collection('commissionInvoices')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  await deleteWhere(() =>
    db.collection('commissionInvoices')
      .where('tenantId', '==', uid)
      .orderBy('__name__'),
  );

  // The payment records, so the admin payments list does not keep showing
  // entries for requests that no longer exist.
  await deleteWhere(() =>
    db.collection('payments')
      .where('studentId', '==', uid)
      .orderBy('__name__'),
  );

  await deleteWhere(() =>
    db.collection('payments')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  // The notifications addressed to the user.
  await deleteWhere(() =>
    db.collection('notifications')
      .where('userId', '==', uid)
      .orderBy('__name__'),
  );

  // The reviews — the ones the user wrote and the ones about the rooms of
  // the user.
  //
  // A review of the user is personal data and has to go with the account.
  // A review about a room of the user would be an orphan without its room,
  // so it goes as well.
  await deleteWhere(() =>
    db.collection('roomReviews')
      .where('studentId', '==', uid)
      .orderBy('__name__'),
  );

  await deleteWhere(() =>
    db.collection('roomReviews')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  // The locks of the booking requests — a lock that points at a request of
  // a deleted account would block a new request of somebody else.
  await deleteWhere(() =>
    db.collection('joinRequestLocks')
      .where('studentId', '==', uid)
      .orderBy('__name__'),
  );

  // The conversations of the user, with all their messages.
  //
  // The **messages first**: Firestore does not delete the documents of a
  // subcollection when the parent is deleted — the messages would stay
  // behind as orphans.
  const conversationsQuery = () =>
    db.collection('conversations')
      .where('participantIds', 'array-contains', uid)
      .orderBy('__name__');

  let conversationCursor: admin.firestore.QueryDocumentSnapshot | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = conversationsQuery();
    const snapshot = await (conversationCursor
      ? query.startAfter(conversationCursor)
      : query
    ).limit(200).get();
    if (snapshot.empty) break;

    for (const conversation of snapshot.docs) {
      await deleteWhere(() =>
        conversation.ref.collection('messages').orderBy('__name__'),
      );
    }

    conversationCursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < 200) break;
  }

  // Now the conversations themselves.
  await deleteWhere(conversationsQuery);

  // The photos of the rooms of the user.
  try {
    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({ prefix: `rooms/${uid}/` });
    await Promise.all(files.map((file) => file.delete().catch(() => undefined)));
  } catch (error) {
    console.error('Failed to delete the room photos:', error);
  }

  // The Auth account goes last — everything else is already gone.
  //
  // The account may already be gone: the `onUserDelete` trigger runs this
  // very function again, and an admin may delete an account that was
  // already removed in the Firebase console. "User not found" is not an
  // error in that case — the account is gone either way.
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (!isUserNotFound(error)) {
      throw error;
    }
    console.log(`The Auth account ${uid} was already gone.`);
  }
}

/**
 * Whether the error means "this Auth account does not exist".
 */
function isUserNotFound(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const message = String((error as { message?: string })?.message || '');
  return (
    code === 'auth/user-not-found' ||
    message.includes('auth/user-not-found')
  );
}

/**
 * The admin reviews a booking request.
 *
 * The review used to be a Firestore transaction in the app. That had two
 * problems: the transaction was written by the client (so it could be
 * tampered with) and it did **not** create a notification — the student and
 * the owner never heard that the booking was approved.
 *
 * The review happens inside a **transaction** that re-reads the request, so
 * a cancellation that happens at the same moment cannot be overwritten by
 * the review.
 */
export const adminReviewRequest = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // Do not trust the `admin` custom claim alone: it stays in an already
  // issued token until that token expires.
  await assertLiveAdmin(context.auth.uid);

  const requestId = String(data?.requestId || '').trim();
  const approve = data?.approve === true;
  const rejectionReason = data?.rejectionReason
    ? String(data.rejectionReason).trim()
    : null;

  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing booking request');
  }

  const requestRef = db.collection('joinRequests').doc(requestId);

  const { request, alreadyActive } = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(requestRef);
    if (!snapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That booking request no longer exists',
      );
    }

    const request = snapshot.data() as Record<string, any>;

    // -------------------------------------------------------------------
    // A booking that is already active is **final**.
    //
    // Approving it again would recreate its invoice — and the invoice would
    // go back to `pending` even when the admin had already marked it as
    // paid. The payment history would silently disappear.
    //
    // And it may not be rejected either: the room, the invoice and the
    // payment of an active booking are only released together — by
    // rejecting the **payment** (`verifyPayment`), which does the whole
    // rollback in one transaction.
    // -------------------------------------------------------------------
    if (isActiveBookingStatus(String(request.status || ''))) {
      if (!approve) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This booking is already active — reject its payment instead',
        );
      }
      return { request, alreadyActive: true };
    }

    const ownerApproved =
      request.status === 'ownerConfirmed' || request.status === 'studentConfirmed';
    if (!ownerApproved) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        request.status === 'cancelled'
          ? 'This booking was cancelled'
          : 'The owner has to approve the request before it can be reviewed',
      );
    }

    // A request that already points at another invoice must not get a
    // second one.
    const invoiceId = `INV-${requestId}`;
    if (approve && request.invoiceId && request.invoiceId !== invoiceId) {
      throw new functions.https.HttpsError(
        'already-exists',
        `This booking already has an invoice (${request.invoiceId})`,
      );
    }

    if (approve) {
      // -------------------------------------------------------------------
      // A booking is activated by **verifying its payment** only.
      //
      // The old admin-review path could create the invoice and increment
      // the occupancy without checking that any money had arrived. That
      // made a second, independent activation path and allowed a request
      // with a fake payment to become a tenancy.
      //
      // `verifyPayment` is the single activation transition. This function
      // remains as an idempotent acknowledgement for bookings that are
      // already active and as the rejection path for a request that has
      // not been paid.
      // -------------------------------------------------------------------
      if (request.advancePaymentStatus !== 'verified') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Verify the platform fee payment first — the booking is activated when the payment is verified',
        );
      }

      // A verified payment normally activates the request in
      // `verifyPayment`. Reaching this point means the request is in an
      // inconsistent legacy state; refuse it instead of creating a second
      // activation path.
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Use the Verify Payment action to activate this booking',
      );
    } else {
      transaction.update(requestRef, {
        status: 'rejected',
        rejectionReason,
        rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
        adminReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return { request, alreadyActive: false };
  });

  // The booking was already active — nothing changed, so nobody is told
  // about it a second time.
  if (alreadyActive) {
    return { success: true, status: 'adminReviewed', alreadyActive: true };
  }

  // Both sides are told what happened.
  await notify(
    String(request.studentId || ''),
    approve ? 'Your booking is confirmed' : 'Your booking was declined',
    approve
      ? 'Your room is booked. The rent is settled directly with the owner.'
      : rejectionReason || 'The booking could not be completed.',
    approve ? 'invoicePaid' : 'adminReview',
    { requestId, roomId: String(request.roomId || '') },
  );

  await notify(
    String(request.ownerId || ''),
    approve ? 'Booking confirmed' : 'Booking declined',
    approve
      ? 'The student booked your room. The rent is settled directly with them.'
      : rejectionReason || 'The booking could not be completed.',
    approve ? 'invoicePaid' : 'adminReview',
    { requestId, roomId: String(request.roomId || '') },
  );

  return { success: true, status: approve ? 'adminReviewed' : 'rejected' };
});

/** How many days the user has before the account is really deleted. */
export const DELETION_GRACE_DAYS = 7;

/**
 * Schedules the deletion of a user account.
 *
 * The account is **not** deleted right away: the user gets seven days to
 * change their mind, and the admin can cancel the deletion in the meantime.
 * The account is disabled immediately, so nobody can use it while the
 * clock is running.
 */
export const scheduleUserDeletion = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // Do not trust the `admin` custom claim alone: it stays in an already
  // issued token until that token expires.
  await assertLiveAdmin(context.auth.uid);

  const uid = String(data?.uid || '').trim();
  const days = Number(data?.days || DELETION_GRACE_DAYS);

  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }
  if (uid === context.auth.uid) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'You cannot schedule the deletion of your own account',
    );
  }
  if (!Number.isFinite(days) || days < 0 || days > 365) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid number of days');
  }

  const userRef = db.collection('users').doc(uid);
  const snapshot = await userRef.get();
  if (!snapshot.exists) {
    throw new functions.https.HttpsError('not-found', 'That user does not exist');
  }
  const user = snapshot.data() || {};

  const deleteAfter = admin.firestore.Timestamp.fromMillis(
    Date.now() + days * 24 * 60 * 60 * 1000,
  );

  await userRef.update({
    deletionScheduled: true,
    deletionScheduledAt: admin.firestore.FieldValue.serverTimestamp(),
    deletionRequestedBy: context.auth.uid,
    deleteAfter,
    isActive: false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // The account is disabled right away — it may not be used while the
  // seven days are running.
  try {
    await auth.updateUser(uid, { disabled: true });
  } catch (error) {
    console.error('Failed to disable the account:', error);
  }

  await notify(
    uid,
    'Your account will be deleted',
    `Your StayServe account has been scheduled for deletion in ${days} ` +
      'days. All your data — your listings, requests and invoices — will be ' +
      'removed. Contact support if you did not request this.',
    'account',
    { uid, days: String(days) },
  );

  return {
    success: true,
    uid,
    deleteAfter: deleteAfter.toDate().toISOString(),
    days,
  };
});

/**
 * Cancels a scheduled deletion and re-enables the account.
 */
export const cancelUserDeletion = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // Do not trust the `admin` custom claim alone: it stays in an already
  // issued token until that token expires.
  await assertLiveAdmin(context.auth.uid);

  const uid = String(data?.uid || '').trim();
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }

  const userRef = db.collection('users').doc(uid);
  const snapshot = await userRef.get();
  if (!snapshot.exists) {
    throw new functions.https.HttpsError('not-found', 'That user does not exist');
  }

  await userRef.update({
    deletionScheduled: false,
    deletionScheduledAt: null,
    deletionRequestedBy: null,
    deleteAfter: null,
    isActive: true,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    await auth.updateUser(uid, { disabled: false });
  } catch (error) {
    console.error('Failed to re-enable the account:', error);
  }

  await notify(
    uid,
    'Your account was restored',
    'The scheduled deletion of your StayServe account was cancelled. ' +
      'Your account is active again.',
    'account',
    { uid },
  );

  return { success: true, uid };
});

/**
 * Deletes every account whose seven days are over.
 *
 * Runs once a day. The query only asks for the accounts that are marked for
 * deletion — the date is checked in the code, because a range query on a
 * timestamp together with an equality filter would need an extra composite
 * index.
 */
export const processScheduledDeletions = functions.pubsub
  .schedule('every day 03:00')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const now = Date.now();
    const pending = await db
      .collection('users')
      .where('deletionScheduled', '==', true)
      .get();

    let deleted = 0;

    for (const doc of pending.docs) {
      const data = doc.data() || {};
      const deleteAfter = data.deleteAfter;
      const due =
        deleteAfter &&
        typeof deleteAfter.toMillis === 'function' &&
        deleteAfter.toMillis() <= now;

      if (!due) continue;

      const uid = doc.id;
      try {
        await deleteUserEverywhere(uid);
        deleted += 1;
        console.log(`Deleted the account ${uid} — the seven days were over.`);
      } catch (error) {
        console.error(`Failed to delete the account ${uid}:`, error);
        // The account is not scheduled again, so the next run tries it once
        // more.
        await doc.ref.update({
          deletionFailedAt: admin.firestore.FieldValue.serverTimestamp(),
          deletionError: String(error).slice(0, 300),
        });
      }
    }

    console.log(`Scheduled deletions: ${deleted} account(s) deleted.`);
    return null;
  });
