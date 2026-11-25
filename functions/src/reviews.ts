import * as functions from 'firebase-functions/v1';
import { callableHttps } from './appCheck';
import * as firestore from 'firebase-admin/firestore';
import * as crypto from 'crypto';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  OWNER_ACCEPTED_STATUSES,
  canActAsRoomOwner,
  canBookAsStudent,
} from './bookingAccess';
import { assertActiveAccount, canActAsAdmin } from './accounts';
import {
  notificationDocumentData,
  notificationRecipientAllows,
  pushToDevice,
} from './notifications';

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
 * The server-only attribution records of notifications.
 *
 * The notification document itself is readable by its recipient. Keeping the
 * author and recipient uids in a separate server-only collection preserves
 * the participant-name/identity boundary while still allowing account
 * cleanup to remove every attributable copy.
 */
export const NOTIFICATION_ATTRIBUTIONS = 'notificationAttributions';

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
 * The lifecycle id of one review instance.
 *
 * A review keeps the same deterministic document id when it is edited. If an
 * administrator deletes it and the student creates it again, the new review
 * is a new lifecycle and receives a new id. Moderation audit events use this
 * id, so a later deletion cannot overwrite the history of an earlier one.
 */
export function reviewInstanceIdFor(
  snapshot: firestore.DocumentSnapshot,
): string {
  const stored = String(snapshot.get('reviewInstanceId') || '').trim();
  if (stored) return stored;

  // Reviews created before lifecycle ids were introduced are identified by
  // their original creation timestamp. A recreated review is written by the
  // current server and receives a random lifecycle id instead.
  const createdAt = snapshot.get('createdAt');
  if (
    createdAt &&
    typeof createdAt === 'object' &&
    typeof (createdAt as { toMillis?: unknown }).toMillis === 'function'
  ) {
    const millis = Number(
      (createdAt as { toMillis: () => number }).toMillis(),
    );
    if (Number.isFinite(millis)) return `legacy-${millis}`;
  }

  const reviewId = String(snapshot.get('reviewId') || snapshot.id || '').trim();
  return `legacy-${crypto
    .createHash('sha256')
    .update(reviewId)
    .digest('hex')
    .slice(0, 24)}`;
}

/** The deterministic id of one moderation event. */
function reviewDeletionAuditId(
  reviewId: string,
  reviewInstanceId: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${reviewId.trim()}:${reviewInstanceId.trim()}`)
    .digest('hex');
}

/**
 * The deterministic state id of one moderated review lifecycle.
 *
 * The old implementation used the review id alone and therefore kept only
 * the newest lifecycle. A per-lifecycle pointer lets every historical
 * moderation remain idempotent, even after the review is recreated.
 */
function reviewDeletionStateId(
  reviewId: string,
  reviewInstanceId: string,
): string {
  return `STATE-${reviewDeletionAuditId(reviewId, reviewInstanceId)}`;
}

/** The deterministic notification id of one review lifecycle. */
export function reviewNotificationId(
  reviewId: string,
  reviewInstanceId: string,
  ownerId: string,
): string {
  return `review-${crypto
    .createHash('sha256')
    .update(
      `${reviewId.trim()}:${reviewInstanceId.trim()}:${ownerId.trim()}`,
    )
    .digest('hex')}`;
}

/** An opaque id used when a viewer may not see the reviewer's identity. */
function publicReviewId(reviewId: string, reviewInstanceId: string): string {
  return `PUBLIC-${crypto
    .createHash('sha256')
    .update(`${reviewId.trim()}:${reviewInstanceId.trim()}`)
    .digest('hex')
    .slice(0, 40)}`;
}

/** Reads a Firestore timestamp (or date-like value) as epoch millis. */
function timestampMillis(value: unknown): number {
  if (value instanceof firestore.Timestamp) return value.toMillis();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    const millis = Number((value as { toMillis: () => number }).toMillis());
    if (Number.isFinite(millis)) return millis;
  }
  return 0;
}

/** The live fields used to decide whether an account may read room reviews. */
function reviewViewerState(snapshot: firestore.DocumentSnapshot) {
  return {
    exists: snapshot.exists,
    registrationCompleted: snapshot.get('registrationCompleted'),
    isActive: snapshot.get('isActive'),
    role: snapshot.get('role'),
    phoneVerified: snapshot.get('phoneVerified'),
  };
}

/**
 * Lists the reviews of one room without exposing the collection to clients.
 *
 * A room-scoped server query replaces the former direct Firestore list. The
 * reviewer identity is returned only to the room owner, an administrator and
 * the reviewer itself. Other signed-in tenants can still see the public
 * rating/comment, but cannot enumerate reviews across rooms or learn the
 * reviewer's uid or display name.
 */
export const getRoomReviews = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  await assertActiveAccount(uid);
  const roomId = String(data?.roomId || '').trim();
  if (!roomId || roomId.length > 512) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid room');
  }

  const callerSnapshot = await db.collection('users').doc(uid).get();
  const callerState = reviewViewerState(callerSnapshot);
  const callerIsAdmin = canActAsAdmin(callerState);
  if (
    !callerIsAdmin &&
    !canBookAsStudent(callerState) &&
    !canActAsRoomOwner(callerState)
  ) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'This account is not allowed to read room reviews.',
    );
  }

  const roomSnapshot = await db.collection('rooms').doc(roomId).get();
  if (!roomSnapshot.exists) {
    throw new functions.https.HttpsError('not-found', 'That room no longer exists');
  }
  const roomOwnerId = String(roomSnapshot.get('ownerId') || '').trim();

  const reviewSnapshot = await db
    .collection('roomReviews')
    .where('roomId', '==', roomId)
    .get();

  const reviews = reviewSnapshot.docs
    .map((snapshot) => {
      const review = snapshot.data() as Record<string, any>;
      const reviewId = String(review.reviewId || snapshot.id || '').trim();
      const reviewInstanceId = reviewInstanceIdFor(snapshot);
      const studentId = String(review.studentId || '').trim();
      const maySeeReviewer =
        callerIsAdmin || uid === roomOwnerId || uid === studentId;

      return {
        reviewId: maySeeReviewer ? reviewId : publicReviewId(reviewId, reviewInstanceId),
        reviewInstanceId,
        roomId: String(review.roomId || roomId),
        studentId: maySeeReviewer ? studentId : '',
        ownerId: roomOwnerId,
        joinRequestId: '',
        rating: Number(review.rating || 0),
        comment: String(review.comment || ''),
        studentName: maySeeReviewer
          ? String(review.studentName || 'A student')
          : 'A student',
        createdAt: timestampMillis(review.createdAt),
        updatedAt: timestampMillis(review.updatedAt),
      };
    })
    .sort((left, right) => right.createdAt - left.createdAt);

  return { success: true, roomId, reviews };
});

/** Removes notification copies created before review attribution existed. */
async function deleteLegacyReviewNotifications(reviewId: string): Promise<void> {
  if (!reviewId) return;
  const snapshot = await db
    .collection('notifications')
    .where('data.reviewId', '==', reviewId)
    .get();
  await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
}

/**
 * Reads every notification and attribution which depends on one review.
 *
 * The references are returned separately so the caller can delete the
 * recipient-visible copies first and the server-only attribution records
 * second. The review source is deleted only after both groups are gone.
 */
export async function readReviewNotificationDependencyRefs(
  reviewId: string,
  reviewInstanceId: string,
): Promise<{
  notificationRefs: firestore.DocumentReference[];
  attributionRefs: firestore.DocumentReference[];
}> {
  const notificationRefs = new Map<string, firestore.DocumentReference>();
  const attributionRefs = new Map<string, firestore.DocumentReference>();

  const legacySnapshot = await db
    .collection('notifications')
    .where('data.reviewId', '==', reviewId)
    .get();
  for (const document of legacySnapshot.docs) {
    notificationRefs.set(document.ref.path, document.ref);
  }

  const reviewAttributionSnapshot = await db
    .collection(NOTIFICATION_ATTRIBUTIONS)
    .where('sourceReviewId', '==', reviewId)
    .get();
  const lifecycleAttributionSnapshot = reviewInstanceId
    ? await db
        .collection(NOTIFICATION_ATTRIBUTIONS)
        .where('sourceId', '==', reviewInstanceId)
        .get()
    : { docs: [] as firestore.QueryDocumentSnapshot[] };
  for (const document of [
    ...reviewAttributionSnapshot.docs,
    ...lifecycleAttributionSnapshot.docs,
  ]) {
    attributionRefs.set(document.ref.path, document.ref);
  }

  return {
    notificationRefs: Array.from(notificationRefs.values()),
    attributionRefs: Array.from(attributionRefs.values()),
  };
}

/**
 * Writes the owner notification for one review lifecycle.
 *
 * The notification body never contains the review comment. The transaction
 * binds the notification to the exact review lifecycle, so a delayed write
 * after moderation is refused and a moderation transaction removes any copy
 * which was written first.
 */
async function writeReviewNotification(options: {
  reviewId: string;
  reviewInstanceId: string;
  ownerId: string;
  studentId: string;
  studentName: string;
  rating: number;
  roomId: string;
}): Promise<void> {
  const notificationId = reviewNotificationId(
    options.reviewId,
    options.reviewInstanceId,
    options.ownerId,
  );
  const notificationRef = db.collection('notifications').doc(notificationId);
  const attributionRef = db
    .collection(NOTIFICATION_ATTRIBUTIONS)
    .doc(notificationId);
  const title = 'New review';
  const body = `${options.studentName || 'A student'} rated your room ${options.rating}/5`;
  const data = { roomId: options.roomId };

  const shouldPush = await db.runTransaction(async (transaction) => {
    const [
      reviewSnapshot,
      ownerSnapshot,
      studentSnapshot,
      notificationSnapshot,
      attributionSnapshot,
    ] = await Promise.all([
      transaction.get(db.collection('roomReviews').doc(options.reviewId)),
      transaction.get(db.collection('users').doc(options.ownerId)),
      transaction.get(db.collection('users').doc(options.studentId)),
      transaction.get(notificationRef),
      transaction.get(attributionRef),
    ]);

    if (!reviewSnapshot.exists) return false;
    if (reviewInstanceIdFor(reviewSnapshot) !== options.reviewInstanceId) {
      return false;
    }
    const review = reviewSnapshot.data() as Record<string, any>;
    if (
      String(review.studentId || '') !== options.studentId ||
      String(review.ownerId || '') !== options.ownerId
    ) {
      return false;
    }
    if (!notificationRecipientAllows(ownerSnapshot, 'review')) return false;
    if (
      !canBookAsStudent({
        exists: studentSnapshot.exists,
        registrationCompleted: studentSnapshot.get('registrationCompleted'),
        isActive: studentSnapshot.get('isActive'),
        role: studentSnapshot.get('role'),
        phoneVerified: studentSnapshot.get('phoneVerified'),
      })
    ) {
      return false;
    }

    if (notificationSnapshot.exists) {
      const notification = notificationSnapshot.data() as Record<string, any>;
      if (
        String(notification.userId || '') !== options.ownerId ||
        String(notification.type || '') !== 'review'
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The review notification is malformed.',
        );
      }

      // The deterministic id and the review lifecycle stay unchanged. Only
      // the safe summary is refreshed, so an edit cannot leave the owner
      // looking at the previous rating.
      transaction.update(notificationRef, {
        title,
        body,
        type: 'review',
        data,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
    } else {
      transaction.set(
        notificationRef,
        notificationDocumentData(
          options.ownerId,
          title,
          body,
          'review',
          data,
        ),
      );
    }

    if (attributionSnapshot.exists) {
      const attribution = attributionSnapshot.data() as Record<string, any>;
      if (
        String(attribution.sourceReviewId || '') !== options.reviewId ||
        String(attribution.sourceId || '') !== options.reviewInstanceId
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The review notification attribution is malformed.',
        );
      }
    }
    transaction.set(
      attributionRef,
      {
        notificationId,
        userId: options.ownerId,
        sourceType: 'roomReview',
        sourceAuthorUid: options.studentId,
        sourceRecipientUid: options.ownerId,
        sourceId: options.reviewInstanceId,
        sourceReviewId: options.reviewId,
        createdAt: attributionSnapshot.exists
          ? attributionSnapshot.get('createdAt')
          : firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return true;
  });

  if (!shouldPush) return;

  // Check the exact lifecycle once more immediately before the external
  // push. The in-app document is already protected by the transaction above.
  const reviewSnapshot = await db
    .collection('roomReviews')
    .doc(options.reviewId)
    .get();
  if (
    !reviewSnapshot.exists ||
    reviewInstanceIdFor(reviewSnapshot) !== options.reviewInstanceId
  ) {
    return;
  }
  await pushToDevice(options.ownerId, title, body, { ...data, type: 'review' });
}

/**
 * Writes (or replaces) the review of the current student for a room.
 */
export const submitRoomReview = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  await assertActiveAccount(uid);
  const roomId = String(data?.roomId || '').trim();
  const comment = String(data?.comment || '').trim();
  const rating = Number(data?.rating);
  const expectedReviewInstanceId = String(
    data?.expectedReviewInstanceId || '',
  ).trim();

  if (!roomId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing room');
  }
  if (expectedReviewInstanceId.length > 256) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Invalid review lifecycle',
    );
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
  const result = await db.runTransaction(async (transaction) => {
    const studentSnapshot = await transaction.get(
      db.collection('users').doc(uid),
    );
    if (
      !canBookAsStudent({
        exists: studentSnapshot.exists,
        registrationCompleted: studentSnapshot.get('registrationCompleted'),
        isActive: studentSnapshot.get('isActive'),
        role: studentSnapshot.get('role'),
        phoneVerified: studentSnapshot.get('phoneVerified'),
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

    if (existing.exists) {
      const existingInstanceId = reviewInstanceIdFor(existing);
      if (
        !expectedReviewInstanceId ||
        existingInstanceId !== expectedReviewInstanceId
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This review changed or was removed. Refresh it before editing.',
        );
      }
    } else if (expectedReviewInstanceId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This review was removed or replaced. Refresh it before editing.',
      );
    }

    const reviewInstanceId = existing.exists
      ? reviewInstanceIdFor(existing)
      : crypto.randomUUID();

    const review = {
      reviewId,
      reviewInstanceId,
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
      // The `createdAt` and lifecycle id of the first review are kept.
      transaction.update(reviewRef, review);
    } else {
      transaction.set(reviewRef, {
        ...review,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
    }

    return {
      ownerId: roomOwnerId,
      studentName: resolvedName,
      reviewInstanceId,
    };
  });

  // The owner is told about it. The body deliberately contains no part of
  // the comment, so a later moderation/account deletion cannot leave a copy
  // of the review text behind.
  if (result.ownerId && result.ownerId !== uid) {
    await writeReviewNotification({
      reviewId,
      reviewInstanceId: result.reviewInstanceId,
      ownerId: result.ownerId,
      studentId: uid,
      studentName: result.studentName,
      rating,
      roomId,
    });
  }

  return { success: true, reviewId, reviewInstanceId: result.reviewInstanceId };
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
  await assertActiveAccount(uid);
  const roomId = String(data?.roomId || '').trim();
  const expectedReviewInstanceId = String(
    data?.expectedReviewInstanceId || '',
  ).trim();
  if (!roomId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing room');
  }
  if (!expectedReviewInstanceId || expectedReviewInstanceId.length > 256) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Invalid review lifecycle',
    );
  }

  const reviewId = reviewIdFor(roomId, uid);
  const reviewRef = db.collection('roomReviews').doc(reviewId);
  const dependencyRefs = await readReviewNotificationDependencyRefs(
    reviewId,
    expectedReviewInstanceId,
  );

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
        phoneVerified: studentSnapshot.get('phoneVerified'),
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
    if (reviewInstanceIdFor(existing) !== expectedReviewInstanceId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This review changed or was replaced. Refresh it before deleting.',
      );
    }

    const review = existing.data() as Record<string, any>;
    const ownerId = String(review.ownerId || '').trim();
    const notificationRefs = new Map(
      dependencyRefs.notificationRefs.map((reference) => [
        reference.path,
        reference,
      ]),
    );
    const attributionRefs = new Map(
      dependencyRefs.attributionRefs.map((reference) => [
        reference.path,
        reference,
      ]),
    );

    if (ownerId) {
      const notificationId = reviewNotificationId(
        reviewId,
        expectedReviewInstanceId,
        ownerId,
      );
      const notificationRef = db.collection('notifications').doc(notificationId);
      const attributionRef = db
        .collection(NOTIFICATION_ATTRIBUTIONS)
        .doc(notificationId);
      notificationRefs.set(notificationRef.path, notificationRef);
      attributionRefs.set(attributionRef.path, attributionRef);
    }

    // The recipient-visible copies are removed first, followed by the
    // server-only attribution. Only then may the review source disappear.
    for (const reference of notificationRefs.values()) {
      transaction.delete(reference);
    }
    for (const reference of attributionRefs.values()) {
      transaction.delete(reference);
    }
    transaction.delete(reviewRef);
  });

  return { success: true };
});

/**
 * Removes any room review as a live administrator.
 *
 * The ordinary deletion path belongs to the student who wrote the review.
 * Moderation is a separate server-owned operation: the acting administrator
 * is checked again inside the transaction which deletes the document, so a
 * demotion or ban cannot race the deletion.
 *
 * A small, server-owned audit record keeps the moderation action
 * attributable without copying the review comment into the audit trail.
 */
export const deleteAnyRoomReview = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const adminUid = context.auth.uid;
  const reviewId = String(data?.reviewId || '').trim();
  const expectedReviewInstanceId = String(
    data?.expectedReviewInstanceId || '',
  ).trim();
  if (!reviewId || reviewId.length > 512) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid review');
  }
  if (!expectedReviewInstanceId || expectedReviewInstanceId.length > 256) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Invalid review lifecycle',
    );
  }

  const reviewRef = db.collection('roomReviews').doc(reviewId);
  const deletionStateRef = db
    .collection('reviewDeletionState')
    .doc(reviewDeletionStateId(reviewId, expectedReviewInstanceId));
  const auditRef = db
    .collection('reviewDeletionAudit')
    .doc(reviewDeletionAuditId(reviewId, expectedReviewInstanceId));
  // Moderation events used the review id directly before lifecycle ids were
  // introduced. The compatibility read lets the administrator who performed
  // such a deletion retry it idempotently after this migration.
  const legacyStateRef = db.collection('reviewDeletionState').doc(reviewId);
  const legacyAuditRef = db.collection('reviewDeletionAudit').doc(reviewId);
  const dependencyRefs = await readReviewNotificationDependencyRefs(
    reviewId,
    expectedReviewInstanceId,
  );
  let alreadyDeleted = false;

  await db.runTransaction(async (transaction) => {
    const [
      adminSnapshot,
      reviewSnapshot,
      stateSnapshot,
      auditSnapshot,
      legacyStateSnapshot,
      legacyAuditSnapshot,
    ] = await Promise.all([
      transaction.get(db.collection('users').doc(adminUid)),
      transaction.get(reviewRef),
      transaction.get(deletionStateRef),
      transaction.get(auditRef),
      transaction.get(legacyStateRef),
      transaction.get(legacyAuditRef),
    ]);

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

    // The per-lifecycle state is the durable idempotency pointer. It is
    // checked before the current review so a retry for an old lifecycle can
    // never delete a recreated review.
    if (stateSnapshot.exists || auditSnapshot.exists) {
      alreadyDeleted = true;
      return;
    }
    if (
      legacyStateSnapshot.exists &&
      String(
        legacyStateSnapshot.get('reviewInstanceId') || '',
      ).trim() === expectedReviewInstanceId
    ) {
      alreadyDeleted = true;
      return;
    }
    if (
      legacyAuditSnapshot.exists &&
      String(
        legacyAuditSnapshot.get('reviewInstanceId') || '',
      ).trim() === expectedReviewInstanceId
    ) {
      alreadyDeleted = true;
      return;
    }

    if (!reviewSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', 'That review no longer exists');
    }

    const review = reviewSnapshot.data() as Record<string, any>;
    const reviewInstanceId = reviewInstanceIdFor(reviewSnapshot);
    if (reviewInstanceId !== expectedReviewInstanceId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This review was replaced. Refresh the moderation list before deleting it.',
      );
    }

    // The event id is tied to the review lifecycle. A later recreation of
    // the review therefore receives a different event id, and the earlier
    // moderation history is never overwritten.
    transaction.set(auditRef, {
      auditEventId: auditRef.id,
      reviewId,
      reviewInstanceId,
      roomId: String(review.roomId || ''),
      studentId: String(review.studentId || ''),
      ownerId: String(review.ownerId || ''),
      deletedByAdminId: adminUid,
      deletedAt: firestore.FieldValue.serverTimestamp(),
    });

    // The idempotency state is also per lifecycle. It is not a "latest
    // review" pointer and therefore keeps every historical retry safe.
    transaction.set(deletionStateRef, {
      reviewId,
      reviewInstanceId,
      auditEventId: auditRef.id,
      roomId: String(review.roomId || ''),
      studentId: String(review.studentId || ''),
      ownerId: String(review.ownerId || ''),
      deletedByAdminId: adminUid,
      deletedAt: firestore.FieldValue.serverTimestamp(),
    });

    const ownerId = String(review.ownerId || '').trim();
    const notificationRefs = new Map(
      dependencyRefs.notificationRefs.map((reference) => [
        reference.path,
        reference,
      ]),
    );
    const attributionRefs = new Map(
      dependencyRefs.attributionRefs.map((reference) => [
        reference.path,
        reference,
      ]),
    );
    if (ownerId) {
      const notificationId = reviewNotificationId(
        reviewId,
        reviewInstanceId,
        ownerId,
      );
      const notificationRef = db.collection('notifications').doc(notificationId);
      const attributionRef = db
        .collection(NOTIFICATION_ATTRIBUTIONS)
        .doc(notificationId);
      notificationRefs.set(notificationRef.path, notificationRef);
      attributionRefs.set(attributionRef.path, attributionRef);
    }

    // The recipient-visible copies are removed first, followed by the
    // server-only attribution. The review source is deleted last.
    for (const reference of notificationRefs.values()) {
      transaction.delete(reference);
    }
    for (const reference of attributionRefs.values()) {
      transaction.delete(reference);
    }
    transaction.delete(reviewRef);
  });

  await deleteLegacyReviewNotifications(reviewId);

  return { success: true, reviewId, reviewInstanceId: expectedReviewInstanceId, alreadyDeleted };
});
