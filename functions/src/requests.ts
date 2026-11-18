import * as functions from 'firebase-functions/v1';
import { callableHttps } from './appCheck';
import * as firestore from 'firebase-admin/firestore';
import * as crypto from 'crypto';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  areNotificationsEnabled,
  platformFeeFor,
  resolveAgreedTerms,
  resolveAgreedTermsFromData,
  PLATFORM_UPI_NAME,
  PLATFORM_UPI_VPA,
} from './platform';
import {
  canActAsRoomOwner,
  canBookAsStudent,
  canStudentCancelBooking,
  hasValidBookingParties,
  paymentAlreadyMade,
} from './bookingAccess';
import { isActiveBookingStatus } from './bookings';
import {
  decideRoomBookingEligibility,
  isValidMonthlyRent,
  roomBookingRejectionMessage,
} from './roomValidation';
import { assertActiveAccount } from './accounts';
import {
  notificationRecipientAllows,
  notify as pushNotification,
  pushToDevice,
} from './notifications';

const db = firestore.getFirestore();

/**
 * Booking requests (join requests).
 *
 * Everything in this file is written by the **server**, never by the client.
 *
 * The reason is simple: a join request carries the money terms
 * (`monthlyRentAtJoin`, `commissionPercentageAtJoin`) and the two parties
 * (`studentId`, `ownerId`). If the client were allowed to write those, a
 * student could:
 *
 *   * claim a rent of ₹1 and thereby pay a platform fee of ₹0,
 *   * claim a commission of 0 %,
 *   * set `ownerId` to their own uid and approve their own request.
 *
 * The Firestore rules pin those fields after creation, but the *initial*
 * values have to come from the server as well — which is what these
 * functions do.
 */

/** A request in one of these states is still "open". */
const OPEN_STATUSES = ['pending', 'studentConfirmed', 'ownerConfirmed'];

/**
 * The states in which the student **already occupies** a slot of the room.
 *
 * `adminReviewed` is the state of an **active** booking — the payment has
 * been made and the room counts the student in its occupancy. A student who
 * already lives in a room cannot book it a second time: the room would
 * count the same person twice and a student could take every slot of a
 * room alone.
 */
const TENANT_STATUSES = ['adminReviewed', 'admin_reviewed'];

/**
 * Writes an in-app notification — unless the admin switched the
 * notifications off from Admin → Settings.
 *
 * The shared helper in `./notifications` also pushes the message to the
 * device, so the user is told even when the app is closed.
 */
async function notify(
  userId: string,
  title: string,
  body: string,
  type: string,
  data: Record<string, string> = {},
): Promise<void> {
  try {
    if (!(await areNotificationsEnabled())) {
      console.log('Notifications are disabled — skipping notification', type);
      return;
    }
  } catch (error) {
    console.error('Could not read the notification setting:', error);
  }
  await pushNotification(userId, title, body, type, data);
}

/**
 * Creates a booking request for a room.
 *
 * The room is read on the server, so the owner and the rent are the ones the
 * owner actually published. The client cannot negotiate them.
 */
export const createJoinRequest = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const roomId = String(data?.roomId || '').trim();
  if (!roomId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing room');
  }

  const roomRef = db.collection('rooms').doc(roomId);
  const studentRef = db.collection('users').doc(uid);

  // Only one open request per student and room.
  const existing = await db
    .collection('joinRequests')
    .where('roomId', '==', roomId)
    .where('studentId', '==', uid)
    .where('status', 'in', OPEN_STATUSES)
    .limit(1)
    .get();
  if (!existing.empty) {
    throw new functions.https.HttpsError(
      'already-exists',
      'You have already requested to join this room',
    );
  }

  // The student may not book a room they already live in.
  const tenancy = await db
    .collection('joinRequests')
    .where('roomId', '==', roomId)
    .where('studentId', '==', uid)
    .where('status', 'in', TENANT_STATUSES)
    .limit(1)
    .get();
  if (!tenancy.empty) {
    throw new functions.https.HttpsError(
      'already-exists',
      'You already live in this room',
    );
  }

  // ---------------------------------------------------------------------
  // The id of the request.
  //
  // The id used to be `JRQ-${Date.now()}` — two requests that were created
  // in the same millisecond got the **same** id, and the second one
  // overwrote the first one: the booking, the invoice and the notification
  // of the first request then pointed at the second one.
  //
  // The id is now drawn from the CSPRNG — it cannot collide, and it does
  // not tell anybody anything about the time of the request.
  // ---------------------------------------------------------------------
  const requestId = `JRQ-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

  // ---------------------------------------------------------------------
  // The **lock** of this student and this room.
  //
  // The duplicate check above is a query — and a query has a race: two
  // requests for the same room can both pass the check before either of
  // them is written, and the student ends up with two open requests (and
  // the owner with two notifications).
  //
  // The lock is a document whose id is derived from the student and the
  // room, and it is written inside the **same transaction** as the
  // request. Firestore lets exactly one transaction create a document with
  // a given id — the other one is retried, and then it finds the lock and
  // refuses the second request.
  // ---------------------------------------------------------------------
  const lockKey = crypto
    .createHash('sha256')
    .update(`${uid}:${roomId}`)
    .digest('hex');
  const lockRef = db.collection('joinRequestLocks').doc(lockKey);

  let createdOwnerId = '';
  let createdRoomTitle = '';
  let createdMonthlyRent = 0;
  let percentage = 0;
  let payer: 'student' | 'owner' = 'owner';

  await db.runTransaction(async (transaction) => {
    // The student's live profile is read in the same transaction as the
    // request. This is the authoritative student-only check: a role change
    // and a booking request cannot both commit from contradictory profile
    // versions.
    const studentSnapshot = await transaction.get(studentRef);
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
        'Only active student accounts can book rooms.',
      );
    }

    // The room is read **inside** the transaction that creates the request.
    // A room deletion marks the listing inactive in the same way, so the two
    // operations cannot race: either the request is created first and the
    // deletion sees it, or the deletion marks the room first and this
    // transaction refuses the new request.
    const roomSnapshot = await transaction.get(roomRef);
    if (!roomSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That room no longer exists',
      );
    }

    const room = roomSnapshot.data() as Record<string, any>;
    const ownerId = String(room.ownerId || '').trim();
    if (!ownerId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This listing has no owner and cannot be booked',
      );
    }
    if (ownerId === uid) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You cannot request to join your own room',
      );
    }

    // The owner profile is read in the same transaction as the request. A
    // demoted, banned or deleting owner therefore cannot gain a new request
    // after their live authority was removed.
    const ownerSnapshot = await transaction.get(
      db.collection('users').doc(ownerId),
    );
    if (
      !canActAsRoomOwner({
        exists: ownerSnapshot.exists,
        registrationCompleted: ownerSnapshot.get('registrationCompleted'),
        isActive: ownerSnapshot.get('isActive'),
        role: ownerSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'This room is not available for booking.',
      );
    }

    const eligibility = decideRoomBookingEligibility(room, ownerId);
    if (!eligibility.allowed) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        roomBookingRejectionMessage(eligibility.reason),
      );
    }

    const monthlyRent = room.monthlyRent;
    if (!isValidMonthlyRent(monthlyRent)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The rent for this room is not valid',
      );
    }

    // Both fee terms come from one settings snapshot. A percentage and a
    // payer from two different configuration versions can never be written
    // to the same request.
    const settingsSnapshot = await transaction.get(
      db.collection('settings').doc('platform'),
    );
    const agreedTerms = resolveAgreedTermsFromData(
      {},
      settingsSnapshot.data() as Record<string, any> | undefined,
    );
    percentage = agreedTerms.percentage;
    payer = agreedTerms.payer;

    const lockSnapshot = await transaction.get(lockRef);

    if (lockSnapshot.exists) {
      const lockedRequestId = String(lockSnapshot.get('requestId') || '');
      if (lockedRequestId) {
        const lockedRequest = await transaction.get(
          db.collection('joinRequests').doc(lockedRequestId),
        );
        const lockedStatus = lockedRequest.exists
          ? String(lockedRequest.get('status') || '')
          : '';

        if (OPEN_STATUSES.indexOf(lockedStatus) >= 0) {
          throw new functions.https.HttpsError(
            'already-exists',
            'You have already requested to join this room',
          );
        }
        if (TENANT_STATUSES.indexOf(lockedStatus) >= 0) {
          throw new functions.https.HttpsError(
            'already-exists',
            'You already live in this room',
          );
        }
      }
    }

    transaction.set(lockRef, {
      studentId: uid,
      roomId,
      requestId,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });

    transaction.create(db.collection('joinRequests').doc(requestId), {
      requestId,
      roomId,
      studentId: uid,
      ownerId,
      status: 'pending',
      createdAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
      monthlyRentAtJoin: monthlyRent,
      commissionPercentageAtJoin: percentage,
      // The platform takes its cut **once**, on the first payment of this
      // booking. Until it has been taken the fee is due; afterwards every
      // payment goes straight from the student to the owner.
      platformCutTaken: false,
      platformFeePayer: payer,
      // Explicitly empty payment state — the client may not create a request
      // that pretends the fee was already paid.
      advancePaid: false,
      advanceAmount: null,
      advancePaymentReference: null,
      advancePaymentMethod: null,
      advanceUpiTransactionId: null,
      advancePaidAt: null,
      advancePaymentStatus: null,
    });

    createdOwnerId = ownerId;
    createdRoomTitle = String(room.title || '');
    createdMonthlyRent = monthlyRent;
  });

  const feeAmount = platformFeeFor(createdMonthlyRent, percentage);

  // ---------------------------------------------------------------------
  // The owner is told right away that a student booked their room and what
  // the platform fee is.
  //
  // The owner never has to upload a UPI: the fee is settled with the
  // platform on the platform's own UPI, and it is charged only once — on
  // the first payment of the booking.
  // ---------------------------------------------------------------------
  await notify(
    createdOwnerId,
    'New Join Request',
    payer === 'owner'
      ? `A student wants to join your room. After the student confirms the ` +
        `request, please pay the ${percentage}% StayServe platform fee ` +
        `(₹${feeAmount}) to our UPI ${PLATFORM_UPI_VPA} ` +
        `(${PLATFORM_UPI_NAME}). It is charged only once — on the first ` +
        'payment of the booking.'
      : `A student wants to join your room. After the student confirms the ` +
        `request, the ${percentage}% StayServe platform fee (₹${feeAmount}) ` +
        `is paid by the student to our UPI ${PLATFORM_UPI_VPA} ` +
        `(${PLATFORM_UPI_NAME}).`,
    'joinRequest',
    { requestId, roomId },
  );

  // ---------------------------------------------------------------------
  // The student gets the confirmation as well.
  //
  // Without it the request simply disappeared into the void until the
  // owner happened to look at their phone.
  // ---------------------------------------------------------------------
  await notify(
    uid,
    'Booking requested',
    `Your request for "${String(createdRoomTitle || 'the room')}" was sent to the ` +
      'owner. You will be notified as soon as they approve it.',
    'joinRequest',
    { requestId, roomId },
  );

  return {
    success: true,
    requestId,
    monthlyRentAtJoin: createdMonthlyRent,
    commissionPercentageAtJoin: percentage,
    platformFeeAmount: feeAmount,
    platformFeePayer: payer,
    platformUpiVpa: PLATFORM_UPI_VPA,
  };
});

/**
 * The owner approves or rejects a booking request.
 *
 * The status transition is validated on the server, and the student is
 * notified by the server — a client may not push notifications into somebody
 * else's list.
 *
 * ### The race with the cancellation
 *
 * The status change happens inside a **transaction** that re-reads the
 * request. Without that the approval could overwrite a cancellation that
 * happened in the meantime: the student cancelled, the owner pressed
 * "approve" at the very same moment, and the request ended up approved even
 * though the student had walked away. With the transaction one of the two
 * wins and the other one is refused.
 */
export const respondToJoinRequest = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const requestId = String(data?.requestId || '').trim();
  const approve = data?.approve === true;
  const reason = data?.reason ? String(data.reason).trim() : null;

  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing booking request');
  }

  await assertActiveAccount(uid);

  const ref = db.collection('joinRequests').doc(requestId);

  // The request is read inside the transaction, so the state that is
  // checked is the state the write is based on.
  const request = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That booking request no longer exists',
      );
    }

    const request = snapshot.data() as Record<string, any>;

    if (request.ownerId !== uid) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'This booking request belongs to somebody else',
      );
    }

    // The caller's live owner role is read in the same transaction as the
    // request. A role change therefore cannot race with an approval: either
    // the approval sees the old owner role and commits first, or the role
    // change commits first and the approval is refused.
    const ownerSnapshot = await transaction.get(
      db.collection('users').doc(uid),
    );
    if (
      !canActAsRoomOwner({
        exists: ownerSnapshot.exists,
        registrationCompleted: ownerSnapshot.get('registrationCompleted'),
        isActive: ownerSnapshot.get('isActive'),
        role: ownerSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only a live owner account can approve or decline this request.',
      );
    }

    const status = String(request.status || '');
    if (approve) {
      if (status !== 'pending') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This request cannot be confirmed',
        );
      }
    } else if (status !== 'pending' && status !== 'ownerConfirmed') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This request cannot be rejected',
      );
    }

    // A request that was paid for may not be declined any more — the money
    // has to be given back first (the admin does that by rejecting the
    // payment).
    if (!approve && paymentAlreadyMade(request)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This request cannot be declined because a payment has already been made',
      );
    }

    if (approve) {
      if (!hasValidBookingParties(request)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This request does not have a valid student tenant.',
        );
      }
      const studentId = String(request.studentId || '');
      const roomId = String(request.roomId || '').trim();
      if (!isValidMonthlyRent(request.monthlyRentAtJoin)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The agreed rent for this request is not valid.',
        );
      }

      const tenantSnapshot = await transaction.get(
        db.collection('users').doc(studentId),
      );
      if (
        !canBookAsStudent({
          exists: tenantSnapshot.exists,
          registrationCompleted: tenantSnapshot.get('registrationCompleted'),
          isActive: tenantSnapshot.get('isActive'),
          role: tenantSnapshot.get('role'),
        })
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'The student can no longer book this room.',
        );
      }

      // The listing is revalidated in the approval transaction. A request
      // which was created while the room was available cannot be approved
      // after the owner took it off the market or filled its last slot.
      if (!roomId) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This request does not identify a room.',
        );
      }
      const roomSnapshot = await transaction.get(
        db.collection('rooms').doc(roomId),
      );
      if (!roomSnapshot.exists) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'That room no longer exists',
        );
      }
      const eligibility = decideRoomBookingEligibility(
        roomSnapshot.data() as Record<string, any>,
        String(request.ownerId || '').trim(),
      );
      if (!eligibility.allowed) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          roomBookingRejectionMessage(eligibility.reason),
        );
      }
    }

    const updates: Record<string, any> = {
      status: approve ? 'ownerConfirmed' : 'rejected',
      updatedAt: firestore.FieldValue.serverTimestamp(),
    };

    if (approve) {
      updates.ownerConfirmedAt = firestore.FieldValue.serverTimestamp();
    } else {
      updates.rejectionReason = reason;
      updates.rejectedAt = firestore.FieldValue.serverTimestamp();
    }

    transaction.update(ref, updates);

    return request;
  });

  await notify(
    request.studentId,
    approve ? 'Your request was approved' : 'Request declined',
    approve
      ? 'The owner accepted your request. Please confirm it; the platform-fee ' +
        'payment can be submitted after both parties confirm.'
      : reason || 'The owner could not accept your request.',
    approve ? 'joinConfirmed' : 'joinRequest',
    { requestId, roomId: String(request.roomId || '') },
  );

  // ---------------------------------------------------------------------
  // The owner accepted the request, but the booking is not active yet. The
  // student still has to confirm it. The owner is told that the platform fee
  // becomes payable only after that confirmation.
  // ---------------------------------------------------------------------
  if (approve) {
    // The terms that were agreed when the request was made — the owner is
    // told the amount that will really be charged.
    const { percentage, payer } = await resolveAgreedTerms(request);
    const monthlyRent = Number(request.monthlyRentAtJoin || 0);
    const feeAmount = platformFeeFor(monthlyRent, percentage);

    await notify(
      request.ownerId,
      'Request accepted — waiting for the student',
      payer === 'owner'
        ? `The student wants to join your room. After the student confirms, ` +
          `please pay the ${percentage}% StayServe platform fee ` +
          `(₹${feeAmount}) to our UPI ${PLATFORM_UPI_VPA} ` +
          `(${PLATFORM_UPI_NAME}). It is charged only once — after that the ` +
          'rent is settled directly with the student.'
        : `The student wants to join your room. After the student confirms, ` +
          `the ${percentage}% StayServe platform fee (₹${feeAmount}) is paid ` +
          `by the student to our UPI ${PLATFORM_UPI_VPA} ` +
          `(${PLATFORM_UPI_NAME}).`,
      'joinConfirmed',
      { requestId, roomId: String(request.roomId || '') },
    );
  }

  return { success: true, status: approve ? 'ownerConfirmed' : 'rejected' };
});

/**
 * The student confirms the booking after the owner approved it.
 *
 * The request then waits for the platform fee to be paid and verified.
 *
 * The status change happens inside a **transaction** that re-reads the
 * request — so a cancellation that happens at the same moment cannot be
 * overwritten by this confirmation.
 */
export const confirmJoinAsStudent = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const requestId = String(data?.requestId || '').trim();
  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing booking request');
  }

  await assertActiveAccount(uid);

  const ref = db.collection('joinRequests').doc(requestId);

  const request = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That booking request no longer exists',
      );
    }

    const request = snapshot.data() as Record<string, any>;

    if (request.studentId !== uid) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'This booking request belongs to somebody else',
      );
    }

    if (!hasValidBookingParties(request)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This request does not have a valid student tenant.',
      );
    }

    const tenantSnapshot = await transaction.get(
      db.collection('users').doc(uid),
    );
    if (
      !canBookAsStudent({
        exists: tenantSnapshot.exists,
        registrationCompleted: tenantSnapshot.get('registrationCompleted'),
        isActive: tenantSnapshot.get('isActive'),
        role: tenantSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only active student accounts can confirm bookings.',
      );
    }

    if (String(request.status || '') !== 'ownerConfirmed') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The owner has to approve your request first',
      );
    }

    const ownerId = String(request.ownerId || '').trim();
    const roomId = String(request.roomId || '').trim();
    if (!ownerId || !roomId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This request does not identify a complete booking.',
      );
    }

    // Both the owner profile and the listing are checked in the same
    // transaction as the confirmation. A deleted owner, a demoted owner or
    // an unavailable room cannot become payable through a stale request.
    const ownerSnapshot = await transaction.get(
      db.collection('users').doc(ownerId),
    );
    if (
      !canActAsRoomOwner({
        exists: ownerSnapshot.exists,
        registrationCompleted: ownerSnapshot.get('registrationCompleted'),
        isActive: ownerSnapshot.get('isActive'),
        role: ownerSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'The room owner can no longer accept this booking.',
      );
    }

    const roomSnapshot = await transaction.get(
      db.collection('rooms').doc(roomId),
    );
    if (!roomSnapshot.exists) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'That room no longer exists',
      );
    }
    const eligibility = decideRoomBookingEligibility(
      roomSnapshot.data() as Record<string, any>,
      ownerId,
    );
    if (!eligibility.allowed) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        roomBookingRejectionMessage(eligibility.reason),
      );
    }

    transaction.update(ref, {
      status: 'studentConfirmed',
      studentConfirmedAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });

    return request;
  });

  const percentage = Number(request.commissionPercentageAtJoin || 0);
  await notify(
    request.ownerId,
    'Student confirmed — platform fee pending',
    `The student confirmed the request. The booking is waiting for the ` +
      `${percentage.toFixed(0)}% platform fee to be submitted and verified.`,
    'joinRequest',
    { requestId, roomId: String(request.roomId || '') },
  );

  return { success: true, status: 'studentConfirmed' };
});

/**
 * Cancels a booking request.
 *
 * Either party may walk away — **also after the owner has accepted** the
 * request, as long as nothing was paid for it yet. That is the whole point
 * of the rule: the owner approves a request, the student has not paid the
 * platform fee yet, and one of the two changes their mind. The booking is
 * then simply gone, and the room slot (which was never taken) stays free.
 *
 * Once money has changed hands the booking can no longer be cancelled this
 * way — the platform would have to give the money back, and the room would
 * have to give the slot back. That case is handled by the admin (the
 * payment is rejected and the booking is rolled back).
 *
 * ### The race with the payment
 *
 * The cancel runs inside a **transaction** and re-reads the request inside
 * it. Without that, a student who pressed "cancel" at the very same moment
 * as "pay" could end up with a booking that was cancelled *and* a payment
 * that was recorded — the room would keep the slot and the platform would
 * have taken the money for a booking that does not exist.
 */
export const cancelJoinRequest = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const requestId = String(data?.requestId || '').trim();
  const reason = data?.reason ? String(data.reason).trim().slice(0, 300) : null;

  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing booking request');
  }

  await assertActiveAccount(uid);

  const ref = db.collection('joinRequests').doc(requestId);

  // The request is read inside the transaction, so the state that is
  // checked is the state the write is based on.
  const request = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That booking request no longer exists',
      );
    }

    const data = snapshot.data() as Record<string, any>;

    if (data.studentId !== uid && data.ownerId !== uid) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'This booking request belongs to somebody else',
      );
    }

    // Each party has to keep the live role for the side of the booking it
    // is cancelling. In particular, an owner whose role was changed may not
    // cancel an owner-side request with an old token. The profile is read in
    // this transaction so a concurrent role change is serialized with the
    // cancellation.
    const callerSnapshot = await transaction.get(
      db.collection('users').doc(uid),
    );
    const callerIsOwner = data.ownerId === uid;
    const callerMayCancel = callerIsOwner
      ? canActAsRoomOwner({
          exists: callerSnapshot.exists,
          registrationCompleted: callerSnapshot.get('registrationCompleted'),
          isActive: callerSnapshot.get('isActive'),
          role: callerSnapshot.get('role'),
        })
      : canBookAsStudent({
          exists: callerSnapshot.exists,
          registrationCompleted: callerSnapshot.get('registrationCompleted'),
          isActive: callerSnapshot.get('isActive'),
          role: callerSnapshot.get('role'),
        });
    if (!callerMayCancel) {
      throw new functions.https.HttpsError(
        'permission-denied',
        callerIsOwner
          ? 'Only a live owner account can cancel an owner-side booking.'
          : 'Only a live student account can cancel a student-side booking.',
      );
    }

    const status = String(data.status || '');
    if (status === 'cancelled') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This booking has already been cancelled',
      );
    }

    // -------------------------------------------------------------------
    // A **rejected** request is over — it cannot be cancelled.
    //
    // The old code only refused a cancelled request, so a declined request
    // could be "cancelled" afterwards: the status changed from `rejected`
    // to `cancelled` and the owner saw "The student withdrew the request"
    // in their dashboard — although the owner had declined it themselves.
    // -------------------------------------------------------------------
    if (status === 'rejected') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This request was declined and cannot be cancelled',
      );
    }

    // -------------------------------------------------------------------
    // A student may withdraw only before the booking becomes active.
    //
    // After the booking is activated, the student has joined the room until
    // the owner or an administrator explicitly makes the room available
    // again. That server-owned release path removes the joined-room
    // subscription immediately and keeps every other booking of the same
    // student untouched.
    // -------------------------------------------------------------------
    const bookingIsActive = isActiveBookingStatus(status);
    if (!callerIsOwner && bookingIsActive) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This booking is already joined and can no longer be cancelled by the student. ' +
          'The room owner or an administrator must make the room available again.',
      );
    }

    // -------------------------------------------------------------------
    // Money has already changed hands — the booking can no longer simply be
    // walked away from.
    // -------------------------------------------------------------------
    if (bookingIsActive || paymentAlreadyMade(data)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This booking can no longer be cancelled because a payment has already ' +
          'been made. Please contact support.',
      );
    }

    if (!callerIsOwner && !canStudentCancelBooking(status, data)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This booking request cannot be cancelled by the student.',
      );
    }

    transaction.update(ref, {
      status: 'cancelled',
      cancelledAt: firestore.FieldValue.serverTimestamp(),
      cancelledBy: uid,
      cancellationReason: reason,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });

    return data;
  });

  // ---------------------------------------------------------------------
  // The other party is told.
  //
  // The cancel used to be completely silent: the owner approved a request,
  // the student cancelled it, and the owner kept waiting for a payment
  // that was never going to arrive.
  // ---------------------------------------------------------------------
  const cancelledByOwner = request.ownerId === uid;
  const other = cancelledByOwner ? request.studentId : request.ownerId;

  if (other && other !== uid) {
    await notify(
      other,
      'Booking cancelled',
      cancelledByOwner
        ? 'The owner cancelled the booking request' +
          (reason ? `: ${reason}` : '.') +
          ' The room is available again.'
        : 'The student cancelled the booking request. The room is available ' +
          'again.',
      'joinRequest',
      { requestId, roomId: String(request.roomId || '') },
    );
  }

  return { success: true, status: 'cancelled' };
});

/**
 * Whether two users are the two parties of a booking inside a transaction.
 */
async function hasBookingRelationshipInTransaction(
  transaction: firestore.Transaction,
  a: string,
  b: string,
): Promise<boolean> {
  const asStudent = await transaction.get(
    db
      .collection('joinRequests')
      .where('studentId', '==', a)
      .where('ownerId', '==', b)
      .limit(1),
  );
  if (!asStudent.empty) return true;

  const asOwner = await transaction.get(
    db
      .collection('joinRequests')
      .where('studentId', '==', b)
      .where('ownerId', '==', a)
      .limit(1),
  );
  return !asOwner.empty;
}

/**
 * Opens a verified student-to-owner conversation for a room.
 *
 * Conversation creation is server-owned. The client cannot put an arbitrary
 * uid into a new participant list and start a conversation with it. The
 * other participant must really be the owner of the room which the student
 * is viewing.
 */
export const openConversation = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const otherUserId = String(data?.otherUserId || '').trim();
  const roomId = String(data?.roomId || '').trim();
  if (!otherUserId || !roomId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Missing conversation participant or room',
    );
  }
  if (otherUserId === uid) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'You cannot start a conversation with yourself',
    );
  }

  await assertActiveAccount(uid);

  const participants = [uid, otherUserId].sort();
  const conversationId = participants.join('_');
  const conversationRef = db.collection('conversations').doc(conversationId);
  const roomRef = db.collection('rooms').doc(roomId);
  const userRef = db.collection('users').doc(uid);

  await db.runTransaction(async (transaction) => {
    const roomSnapshot = await transaction.get(roomRef);
    const userSnapshot = await transaction.get(userRef);

    if (!roomSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That room no longer exists',
      );
    }
    if (
      !canBookAsStudent({
        exists: userSnapshot.exists,
        registrationCompleted: userSnapshot.get('registrationCompleted'),
        isActive: userSnapshot.get('isActive'),
        role: userSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only a live student account can start a room conversation.',
      );
    }

    const roomOwnerId = String(roomSnapshot.get('ownerId') || '').trim();
    if (!roomOwnerId || roomOwnerId !== otherUserId) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'A room conversation may only be opened with the owner of that room.',
      );
    }

    // The owner must still be a live owner. This also closes the account
    // deletion race: the deletion fence marks the profile inactive before the
    // conversation cleanup starts, so no new conversation with that account
    // can appear after the cleanup scan.
    const ownerSnapshot = await transaction.get(
      db.collection('users').doc(roomOwnerId),
    );
    if (
      !canActAsRoomOwner({
        exists: ownerSnapshot.exists,
        registrationCompleted: ownerSnapshot.get('registrationCompleted'),
        isActive: ownerSnapshot.get('isActive'),
        role: ownerSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The owner account is not available for a conversation.',
      );
    }

    const conversationSnapshot = await transaction.get(conversationRef);
    if (conversationSnapshot.get('deletionInProgress') === true) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This conversation is being closed.',
      );
    }

    if (conversationSnapshot.exists) {
      const existing = Array.from(
        new Set(
          (conversationSnapshot.get('participantIds') || []) as string[],
        ),
      ).sort();
      if (
        existing.length !== 2 ||
        existing[0] !== participants[0] ||
        existing[1] !== participants[1]
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This conversation belongs to different participants.',
        );
      }
      return;
    }

    transaction.set(conversationRef, {
      conversationId,
      participantIds: participants,
      roomId,
      createdByServer: true,
      lastMessage: '',
      lastMessageAt: firestore.FieldValue.serverTimestamp(),
      createdAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
      unreadCount: {},
    });
  });

  return { success: true, conversationId };
});

/**
 * Writes the notification for one chat message.
 *
 * A client may not choose notification text or create an arbitrary number
 * of notifications. It names the exact message which it just sent; the
 * server reads that message, verifies its sender and recipient, derives the
 * title and body from the stored content, and writes one deterministic
 * notification. Calling the function again for the same message is
 * idempotent.
 */
export const notifyUser = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const recipientId = String(data?.userId || '').trim();
  const type = String(data?.type || '').trim();
  const payload = (data?.data && typeof data.data === 'object'
    ? data.data
    : {}) as Record<string, unknown>;

  if (!recipientId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing recipient');
  }
  if (recipientId === uid) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'You cannot send a notification to yourself',
    );
  }
  if (type !== 'newMessage') {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Only chat notifications may be sent by a client',
    );
  }

  const conversationId = String(payload.conversationId || '').trim();
  const messageId = String(payload.messageId || '').trim();
  if (!conversationId || !messageId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Missing chat message',
    );
  }
  if (conversationId.length > 512 || messageId.length > 512) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid chat message');
  }

  // The deterministic id makes the notification idempotent. One sent
  // message can therefore create at most one notification, no matter how
  // often the client retries the callable.
  const notificationId = `chat-${crypto
    .createHash('sha256')
    .update(`${conversationId}:${messageId}`)
    .digest('hex')}`;
  const notificationRef = db.collection('notifications').doc(notificationId);

  const notification = await db.runTransaction(async (transaction) => {
    // The live actor, recipient, conversation, exact message and existing
    // notification are checked in one transaction. A ban, deletion fence or
    // conversation cleanup which commits first therefore rejects the late
    // notification.
    const actorSnapshot = await transaction.get(
      db.collection('users').doc(uid),
    );
    if (
      !actorSnapshot.exists ||
      actorSnapshot.get('registrationCompleted') !== true ||
      actorSnapshot.get('isActive') !== true
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'This account is not allowed to send notifications.',
      );
    }

    const recipientSnapshot = await transaction.get(
      db.collection('users').doc(recipientId),
    );
    if (!notificationRecipientAllows(recipientSnapshot, type)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The recipient is no longer available for notifications.',
      );
    }

    const conversationSnapshot = await transaction.get(
      db.collection('conversations').doc(conversationId),
    );
    if (!conversationSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', 'Unknown conversation');
    }
    if (conversationSnapshot.get('deletionInProgress') === true) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This conversation is being closed.',
      );
    }

    const participants = (conversationSnapshot.get('participantIds') ||
      []) as string[];
    const uniqueParticipants = Array.from(new Set(participants));
    const otherParticipant =
      uniqueParticipants.length === 2
        ? uniqueParticipants.find((participant) => participant !== uid)
        : undefined;

    if (
      uniqueParticipants.length !== 2 ||
      !uniqueParticipants.includes(uid) ||
      otherParticipant !== recipientId
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'You can only notify the other participant of a conversation',
      );
    }

    // New conversations are created by the server after it verifies the room
    // and its owner. Legacy conversations do not carry that marker, so their
    // parties still have to be the two sides of a real booking.
    const serverVerifiedConversation =
      conversationSnapshot.get('createdByServer') === true;
    if (
      !serverVerifiedConversation &&
      !(await hasBookingRelationshipInTransaction(
        transaction,
        uid,
        recipientId,
      ))
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'You can only message the other participant of an authorized conversation.',
      );
    }

    const messageSnapshot = await transaction.get(
      db
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .doc(messageId),
    );
    if (!messageSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That chat message no longer exists',
      );
    }

    const message = messageSnapshot.data() as Record<string, any>;
    if (
      String(message.senderId || '') !== uid ||
      String(message.receiverId || '') !== recipientId ||
      String(message.conversationId || '') !== conversationId
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'You can only notify somebody about a message which you sent to them.',
      );
    }

    const existingNotification = await transaction.get(notificationRef);
    if (existingNotification.exists) {
      return { created: false, title: '', body: '' };
    }

    // The notification text is derived from the stored message. The client
    // cannot replace it with arbitrary text or use the callable as a general
    // notification sender.
    const messageType = String(message.type || 'text').trim().toLowerCase();
    const storedContent = String(message.content || '').trim();
    let title = 'New message';
    let body = storedContent;
    if (messageType === 'image') {
      title = 'New photo';
      if (!body) body = 'A photo was sent.';
    } else if (messageType === 'contactshare') {
      title = 'New contact';
      if (!body) body = 'A contact was shared.';
    }
    if (!body) body = 'A new message was sent.';
    if (body.length > 1000) body = `${body.substring(0, 999)}…`;

    transaction.set(notificationRef, {
      userId: recipientId,
      title,
      body,
      type,
      data: { conversationId, messageId },
      read: false,
      createdAt: firestore.FieldValue.serverTimestamp(),
    });

    return { created: true, title, body };
  });

  // The message is also **pushed** to the device. The push happens only
  // when the one deterministic in-app notification was really created.
  if (notification.created) {
    await pushToDevice(
      recipientId,
      notification.title,
      notification.body,
      { conversationId, messageId, type },
    );
  }

  return { success: true, created: notification.created };
});
