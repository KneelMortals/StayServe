import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import { displayNameOf, findOwnerAcceptedRequest } from './bookingAccess';
import { assertActiveAccount } from './accounts';
import { notify } from './notifications';

const db = admin.firestore();

/**
 * Reviews.
 *
 * A student may review a room — but **only** when the owner has accepted
 * their booking request. Without that rule anybody could write a review for
 * a room they never even visited, and a room owner could be buried under
 * made-up reviews of people who never applied.
 *
 * The check is made **on the server**: the client sends the room and the
 * rating, and the server looks the booking request up itself. A modified
 * client therefore cannot review a room it was never accepted for.
 *
 * The reviews themselves are written by the server too, so the room id, the
 * owner and the student cannot be forged.
 */

/** The longest comment a review may have. */
export const MAX_REVIEW_COMMENT_LENGTH = 500;

/**
 * The id of the review of a student for a room.
 *
 * It is derived from the two ids, so a student has **one** review per room:
 * writing it again replaces the old one instead of filling the room with a
 * dozen reviews from the same person.
 */
function reviewIdFor(roomId: string, studentId: string): string {
  return `REV-${roomId}-${studentId}`;
}

/**
 * Writes (or replaces) the review of the current student for a room.
 */
export const submitRoomReview = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const roomId = String(data?.roomId || '').trim();
  const comment = String(data?.comment || '').trim();
  const rating = Number(data?.rating);

  await assertActiveAccount(uid);

  if (!roomId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing room');
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The rating has to be a whole number between 1 and 5',
    );
  }
  if (comment.length > MAX_REVIEW_COMMENT_LENGTH) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `A review can be at most ${MAX_REVIEW_COMMENT_LENGTH} characters long`,
    );
  }

  const roomSnapshot = await db.collection('rooms').doc(roomId).get();
  if (!roomSnapshot.exists) {
    throw new functions.https.HttpsError('not-found', 'That room no longer exists');
  }
  const room = roomSnapshot.data() as Record<string, any>;
  const ownerId = String(room.ownerId || '');

  // ---------------------------------------------------------------------
  // The rule of the feature: the owner has to have accepted the request.
  // ---------------------------------------------------------------------
  const accepted = await findOwnerAcceptedRequest(uid, roomId);
  if (!accepted) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'You can only review a room after the owner accepts your request',
    );
  }

  const studentName = await displayNameOf(uid);
  const reviewId = reviewIdFor(roomId, uid);
  const reviewRef = db.collection('roomReviews').doc(reviewId);
  const existing = await reviewRef.get();

  const review = {
    reviewId,
    roomId,
    studentId: uid,
    ownerId,
    // -------------------------------------------------------------------
    // The id of the booking request is **not** part of the public review.
    //
    // Every signed-in user may read the reviews of a room — that is the
    // point of a review. The internal id of the booking request is none of
    // their business, though: it is the internal bookkeeping of the
    // booking and it would tell them who booked which room.
    //
    // The server does not need it either — the gate of the feature is
    // checked again with `findOwnerAcceptedRequest` every time the review
    // is written or removed.
    // -------------------------------------------------------------------
    rating,
    comment,
    studentName,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (existing.exists) {
    // The `createdAt` of the first review is kept — it is the date the
    // student first reviewed the room.
    await reviewRef.update(review);
  } else {
    await reviewRef.set({
      ...review,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // ---------------------------------------------------------------------
  // The owner is told about it.
  // ---------------------------------------------------------------------
  if (ownerId && ownerId !== uid) {
    await notify(
      ownerId,
      'New review',
      `${studentName || 'A student'} rated your room ${rating}/5` +
        (comment ? `: ${comment.slice(0, 120)}` : '.'),
      'review',
      { roomId, reviewId },
    );
  }

  return { success: true, reviewId };
});

/**
 * Removes the review of the current student.
 *
 * The review is only removed while the student still has the booking — a
 * student who walked away from the booking may not take their review with
 * them, because the review is about the room they were allowed to book.
 */
export const deleteRoomReview = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const roomId = String(data?.roomId || '').trim();
  if (!roomId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing room');
  }

  await assertActiveAccount(uid);

  const accepted = await findOwnerAcceptedRequest(uid, roomId);
  if (!accepted) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'You can only change a review while your request for the room is accepted',
    );
  }

  const reviewId = reviewIdFor(roomId, uid);
  const reviewRef = db.collection('roomReviews').doc(reviewId);
  const existing = await reviewRef.get();
  if (!existing.exists) {
    throw new functions.https.HttpsError('not-found', 'You have not reviewed this room');
  }

  await reviewRef.delete();
  return { success: true };
});
