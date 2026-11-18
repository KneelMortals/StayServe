import * as functions from 'firebase-functions/v1';
import { callableHttps } from './appCheck';
import * as firestore from 'firebase-admin/firestore';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  OWNER_ACCEPTED_STATUSES,
  canBookAsStudent,
} from './bookingAccess';
import { notify } from './notifications';

const db = firestore.getFirestore();

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
export const submitRoomReview = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const roomId = String(data?.roomId || '').trim();
  const comment = String(data?.comment || '').trim();
  const rating = Number(data?.rating);

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

  const reviewId = reviewIdFor(roomId, uid);
  const reviewRef = db.collection('roomReviews').doc(reviewId);

  // The live student profile, the room, the accepted request and the
  // existing review are read in the same transaction as the write. A
  // cancellation or an account-deletion fence which commits first therefore
  // cannot be raced by a late review.
  const { ownerId, studentName } = await db.runTransaction(async (transaction) => {
    const studentSnapshot = await transaction.get(
      db.collection('users').doc(uid),
    );
    if (
      !canBookAsStudent({
        exists: studentSnapshot.exists,
        registrationCompleted: studentSnapshot.get('registrationCompleted'),
        isActive: studentSnapshot.get('isActive'),
        role: studentSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only an active student account can review a room.',
      );
    }

    const roomSnapshot = await transaction.get(
      db.collection('rooms').doc(roomId),
    );
    if (!roomSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That room no longer exists',
      );
    }
    const roomOwnerId = String(roomSnapshot.get('ownerId') || '').trim();
    const roomListingGeneration = String(
      roomSnapshot.get('listingGeneration') || '',
    ).trim();

    const acceptedSnapshot = await transaction.get(
      db
        .collection('joinRequests')
        .where('roomId', '==', roomId)
        .where('studentId', '==', uid)
        .where('status', 'in', OWNER_ACCEPTED_STATUSES)
        .limit(1),
    );
    if (acceptedSnapshot.empty) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You can only review a room after the owner accepts your request',
      );
    }

    const existing = await transaction.get(reviewRef);
    const profileName = String(studentSnapshot.get('name') || '').trim();
    const profileEmail = String(studentSnapshot.get('email') || '').trim();
    const resolvedName =
      profileName || (profileEmail ? profileEmail.split('@')[0] : 'A student');

    const review = {
      reviewId,
      roomId,
      studentId: uid,
      ownerId: roomOwnerId,
      listingGeneration: roomListingGeneration,
      // The internal booking-request id is deliberately not published.
      rating,
      comment,
      studentName: resolvedName,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    };

    if (existing.exists) {
      if (String(existing.get('studentId') || '') !== uid) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'You can only change your own review.',
        );
      }
      // The `createdAt` of the first review is kept.
      transaction.update(reviewRef, review);
    } else {
      transaction.set(reviewRef, {
        ...review,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
    }

    return { ownerId: roomOwnerId, studentName: resolvedName };
  });

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
export const deleteRoomReview = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const roomId = String(data?.roomId || '').trim();
  if (!roomId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing room');
  }

  const reviewId = reviewIdFor(roomId, uid);
  const reviewRef = db.collection('roomReviews').doc(reviewId);

  await db.runTransaction(async (transaction) => {
    const studentSnapshot = await transaction.get(
      db.collection('users').doc(uid),
    );
    if (
      !canBookAsStudent({
        exists: studentSnapshot.exists,
        registrationCompleted: studentSnapshot.get('registrationCompleted'),
        isActive: studentSnapshot.get('isActive'),
        role: studentSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only an active student account can change a review.',
      );
    }

    const acceptedSnapshot = await transaction.get(
      db
        .collection('joinRequests')
        .where('roomId', '==', roomId)
        .where('studentId', '==', uid)
        .where('status', 'in', OWNER_ACCEPTED_STATUSES)
        .limit(1),
    );
    if (acceptedSnapshot.empty) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You can only change a review while your request for the room is accepted',
      );
    }

    const existing = await transaction.get(reviewRef);
    if (!existing.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'You have not reviewed this room',
      );
    }
    if (String(existing.get('studentId') || '') !== uid) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'You can only delete your own review.',
      );
    }

    transaction.delete(reviewRef);
  });

  return { success: true };
});
