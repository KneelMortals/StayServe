import * as functions from 'firebase-functions/v1';
import { callableHttps } from './appCheck';
import * as firestore from 'firebase-admin/firestore';
import * as crypto from 'crypto';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  PLATFORM_FEE_PERCENTAGE,
  PLATFORM_UPI_NAME,
  PLATFORM_UPI_VPA,
  areNotificationsEnabled,
  isValidFeePercentage,
  platformFeeFor,
  resolveAgreedTermsFromData,
  resolveFeePayer,
  resolveFeePercentage,
} from './platform';
import {
  addBookingActivation,
  rejectedPaymentBookingStatus,
  buildPaymentSubmissionRecord,
  buildPaymentSubmissionRequestUpdates,
  commissionFor,
  isActiveBookingStatus,
  roomStatusAfterOccupancyChange,
  INVOICE_PREFIX,
  ActivatableRequest,
} from './bookings';
import {
  assertActiveAccount,
  assertLiveAdmin,
  canActAsAdmin,
} from './accounts';
import {
  canActAsRoomOwner,
  canBookAsStudent,
  hasValidBookingParties,
  paymentMatchesBookingRequest,
} from './bookingAccess';
import {
  decideRoomBookingEligibility,
  isValidMonthlyRent,
  roomBookingRejectionMessage,
} from './roomValidation';
import { notify } from './notifications';

const db = firestore.getFirestore();

/**
 * Platform-fee payments.
 *
 * The whole point of this file is that the **server** owns the money flow:
 *
 *  - `createUpiPayment` builds the UPI intent. The payee VPA and the amount
 *    are taken from the server configuration and from the rent stored on the
 *    join request, so a modified client can neither redirect the payment to
 *    another account nor underpay the fee.
 *  - `submitPayment` records the reference that was paid with. It leaves
 *    the payment in the `submitted` state — it never marks it as paid.
 *  - `verifyPayment` is admin only. It is the single place where
 *    `advancePaid` is ever set to `true`.
 *
 * ### The cut is taken only once
 *
 * The platform fee belongs to the **first** payment of a booking. As soon
 * as it has been collected (`platformCutTaken === true`) every later payment
 * goes straight from the student to the room owner — the platform does not
 * take a percentage of the rent any more.
 *
 * Firestore rules additionally forbid the client from writing the payment
 * fields on a join request, so the client cannot skip verification.
 */

const VALID_METHODS = ['upi', 'bank_transfer', 'card'];

/**
 * Parses a numeric Firestore value without accepting `null` or an empty
 * string as zero. Money and percentage fields are integrity-sensitive: a
 * missing value must be rejected rather than silently treated as a waiver.
 */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export { PLATFORM_FEE_PERCENTAGE, platformFeeFor, resolveFeePercentage };

/**
 * The rent the platform fee is calculated from.
 *
 * The **agreed** rent of the booking is the source of truth — the client
 * never gets a say in what the fee is based on.
 *
 * The request carries the rent as it was when the request was made
 * (`monthlyRentAtJoin`), and that snapshot is what the owner was told
 * (`respondToJoinRequest` quotes the fee of that rent) and what the
 * invoice is based on. The *current* rent of the room is only used when the
 * request has no snapshot at all (a request of an older version of the app).
 *
 * Reading the room instead would be wrong: the owner may change the rent
 * of a room while a request is waiting, and then the UPI intent, the
 * payment record and the invoice would ask for three different amounts.
 */
function monthlyRentFromData(request: Record<string, any>): number {
  return isValidMonthlyRent(request.monthlyRentAtJoin)
    ? request.monthlyRentAtJoin
    : 0;
}

/**
 * The limits of a UPI intent.
 *
 * They are part of the UPI specification and every UPI app enforces them:
 * an intent that breaks one of them is **rejected** by the app — usually
 * with a message like "the value exceeds the limit", even though the
 * *amount* is perfectly fine.
 */
export const UPI_INTENT_LIMITS = {
  /** The virtual payment address, e.g. `name@bank`. */
  payeeAddress: 100,
  /** The name of the payee shown in the UPI app. */
  payeeName: 50,
  /** The amount, e.g. `133.00`. */
  amount: 20,
  /** The transaction reference. */
  transactionRef: 40,
  /** The note of the transaction — the one that was too long. */
  transactionNote: 50,
};

/**
 * Builds the UPI intent.
 *
 * Every value is cut down to the limit of the specification: an intent that
 * is too long is refused by the UPI app, and the user is told that "the
 * amount exceeds the limit" — which is completely misleading, because the
 * amount was fine. The transaction note was the culprit: it carried the
 * whole request id ("StayServe platform fee for request JRQ-1794561182291"
 * — 52 characters) and the UPI specification allows only 50.
 *
 * ## The payee address is **not** encoded
 *
 * The canonical form of a UPI address is `name@bank` — the `@` is part of
 * the address, not a character that has to be escaped. Several UPI apps
 * (Paytm and some versions of the BHIM app) read the query of the intent
 * by hand instead of decoding it; with `pa=name%40bank` they then see
 * `name%40bank`, do not recognise the address and refuse the payment with
 * a message that has nothing to do with the real reason ("the amount
 * exceeds the limit", "the transaction cannot be completed"). The address
 * is therefore written as it is.
 *
 * The other values are encoded with `encodeURIComponent` and **not** with
 * `URLSearchParams`: the latter writes a space as `+`, which not every UPI
 * app decodes as a space.
 */
function buildUpiUri(params: {
  payeeVpa: string;
  payeeName: string;
  amount: number;
  transactionRef: string;
  transactionNote: string;
}): string {
  const payeeVpa = params.payeeVpa.trim().slice(0, UPI_INTENT_LIMITS.payeeAddress);
  const payeeName = params.payeeName.trim().slice(0, UPI_INTENT_LIMITS.payeeName);
  const amount = params.amount.toFixed(2).slice(0, UPI_INTENT_LIMITS.amount);
  const transactionRef = params.transactionRef
    .trim()
    .slice(0, UPI_INTENT_LIMITS.transactionRef);
  const transactionNote = params.transactionNote
    .trim()
    .slice(0, UPI_INTENT_LIMITS.transactionNote);

  const query = [
    `pa=${payeeVpa}`,
    `pn=${encodeURIComponent(payeeName)}`,
    `am=${amount}`,
    'cu=INR',
    `tr=${encodeURIComponent(transactionRef)}`,
    `tn=${encodeURIComponent(transactionNote)}`,
  ].join('&');

  return `upi://pay?${query}`;
}

/**
 * Writes an in-app notification — unless the admin switched the
 * notifications off from Admin → Settings.
 *
 * The shared helper in `./notifications` also pushes the message to the
 * device; this wrapper only adds the admin's on/off switch.
 */
async function notifyUser(
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
  await notify(userId, title, body, type, data);
}

/**
 * Builds the UPI intent for a booking.
 *
 * Only a participant of the booking may ask for it, and only while the
 * booking is waiting for the platform fee.
 *
 * The answer depends on three things:
 *
 *  - `platformCutTaken` — the platform fee belongs to the **first**
 *    payment of a booking. Once it has been taken, this function says so
 *    and the client tells the student to pay the rent directly to the room
 *    owner.
 *  - the configured fee payer — the student or the room owner settles the
 *    fee with the platform.
 *  - **who is asking** — `youPay` says whether *this* caller has to open
 *    the UPI app.
 *
 * ### The payment option appears on both sides
 *
 * The fee payer is configured once (`settings/platform.feePayer`), but the
 * party that actually pays is the party the setting names. When the setting
 * says `owner`, the **owner** gets the pay button; when it says `student`,
 * the **student** gets it. The other side only sees an explanation of who
 * has to pay.
 */
export const createUpiPayment = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const callerUid = context.auth.uid;
  const requestId = String(data?.joinRequestId || '').trim();
  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing booking request');
  }

  await assertActiveAccount(callerUid);

  const requestRef = db.collection('joinRequests').doc(requestId);

  // The request, both live party profiles and the room are read from one
  // transaction snapshot. A role change, an account-deletion fence or a
  // listing-status change therefore cannot race with the creation of a
  // payable UPI intent.
  return db.runTransaction(async (transaction) => {
    const requestSnapshot = await transaction.get(requestRef);
    if (!requestSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That booking request no longer exists',
      );
    }

    const request = requestSnapshot.data() as Record<string, any>;
    const studentId = String(request.studentId || '').trim();
    const ownerId = String(request.ownerId || '').trim();
    const roomId = String(request.roomId || '').trim();

    if (!hasValidBookingParties(request) || !roomId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This request does not identify a valid booking.',
      );
    }

    const isStudent = studentId === callerUid;
    const isOwner = ownerId === callerUid;
    if (!isStudent && !isOwner) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'This booking request belongs to somebody else',
      );
    }

    const studentSnapshot = await transaction.get(
      db.collection('users').doc(studentId),
    );
    const ownerSnapshot = await transaction.get(
      db.collection('users').doc(ownerId),
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
        'The student can no longer pay for this booking.',
      );
    }
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
        'The room owner can no longer take payment for this booking.',
      );
    }

    // ---------------------------------------------------------------------
    // The cut has already been taken — this booking has been paid for once.
    // From now on everything goes straight from the student to the room
    // owner. This acknowledgement remains available even if the listing has
    // since been taken off the market.
    // ---------------------------------------------------------------------
    if (request.platformCutTaken === true) {
      return {
        alreadySettled: true,
        youPay: false,
        studentPays: false,
        payer: 'none',
        amount: 0,
        feePercentage: 0,
        payeeVpa: PLATFORM_UPI_VPA,
        payeeName: PLATFORM_UPI_NAME,
        transactionRef: '',
        uri: '',
        message:
          'The platform fee for this booking has already been paid. The rent ' +
          'is settled directly with the room owner.',
      };
    }

    const status = String(request.status || '');
    if (status !== 'studentConfirmed') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The student has to confirm the request before you can pay',
      );
    }

    const roomRef = db.collection('rooms').doc(roomId);
    const roomSnapshot = await transaction.get(roomRef);
    if (!roomSnapshot.exists) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'That room no longer exists',
      );
    }

    const room = roomSnapshot.data() as Record<string, any>;
    const eligibility = decideRoomBookingEligibility(room, ownerId);
    if (!eligibility.allowed) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        roomBookingRejectionMessage(eligibility.reason),
      );
    }

    const monthlyRent = monthlyRentFromData(request);
    if (!monthlyRent) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The agreed rent for this request is not valid',
      );
    }

    // The amount is derived from the rent that was agreed when the request
    // was made — never from the current room rent or from client input.
    const snapshotPercentage = request.commissionPercentageAtJoin;
    const snapshotPayer = String(request.platformFeePayer || '');
    const needsSettings =
      !isValidFeePercentage(snapshotPercentage) ||
      (snapshotPayer !== 'student' && snapshotPayer !== 'owner');
    const settingsSnapshot = needsSettings
      ? await transaction.get(db.collection('settings').doc('platform'))
      : null;
    const { percentage, payer } = resolveAgreedTermsFromData(
      request,
      settingsSnapshot
        ? (settingsSnapshot.data() as Record<string, any> | undefined)
        : undefined,
    );
    const amount = platformFeeFor(monthlyRent, percentage);

    // A zero percentage is the only waived fee. A positive percentage which
    // rounds to zero is rejected by `platformFeeFor` instead of silently
    // becoming a free booking.
    if (percentage === 0) {
      return {
        alreadySettled: false,
        feeWaived: true,
        youPay: false,
        studentPays: false,
        payer: 'none',
        amount: 0,
        feePercentage: percentage,
        payeeVpa: PLATFORM_UPI_VPA,
        payeeName: PLATFORM_UPI_NAME,
        transactionRef: '',
        uri: '',
        message:
          'No platform fee is due for this booking. Submit it for admin ' +
          'verification without a transaction reference.',
      };
    }

    const callerPays = payer === 'owner' ? isOwner : isStudent;
    if (!callerPays) {
      return {
        alreadySettled: false,
        youPay: false,
        studentPays: payer === 'student',
        payer,
        amount,
        feePercentage: percentage,
        payeeVpa: PLATFORM_UPI_VPA,
        payeeName: PLATFORM_UPI_NAME,
        transactionRef: '',
        uri: '',
        message:
          payer === 'owner'
            ? `The ${percentage}% StayServe platform fee ` +
              `(₹${amount}) is paid by the room owner. You only pay the rent ` +
              'directly with the owner.'
            : `The ${percentage}% StayServe platform fee ` +
              `(₹${amount}) is paid by the student. You only pay the rent ` +
              'directly with the student.',
      };
    }

    const transactionRef = `SS${requestId.replace(/[^A-Za-z0-9]/g, '').slice(-12)}`;

    return {
      alreadySettled: false,
      youPay: true,
      studentPays: payer === 'student',
      payer,
      uri: buildUpiUri({
        payeeVpa: PLATFORM_UPI_VPA,
        payeeName: PLATFORM_UPI_NAME,
        amount,
        transactionRef,
        transactionNote: `StayServe fee ${requestId}`,
      }),
      amount,
      feePercentage: percentage,
      payeeVpa: PLATFORM_UPI_VPA,
      payeeName: PLATFORM_UPI_NAME,
      transactionRef,
      message: '',
    };
  });
});

/**
 * Records the payment reference that was paid with.
 *
 * A submission is **not** an activated booking. The payment record and the
 * request only move to the `submitted` state; no invoice is created and no
 * occupancy is changed. An admin has to verify that the money really arrived
 * through [verifyPayment]. Only that verification moves the request to
 * `adminReviewed` and makes it a joined room.
 *
 * A rejection by the admin restores the payable state — see [verifyPayment].
 */
export const submitPayment = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const callerUid = context.auth.uid;
  const requestId = String(data?.requestId || '');
  const reference = String(data?.reference || '').trim();
  const method = String(data?.method || 'upi');

  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing booking request');
  }
  if (!VALID_METHODS.includes(method)) {
    throw new functions.https.HttpsError('invalid-argument', 'Unsupported payment method');
  }

  await assertActiveAccount(callerUid);

  const ref = db.collection('joinRequests').doc(requestId);
  const paymentRef = db.collection('payments').doc(requestId);

  // ---------------------------------------------------------------------
  // Everything happens in **one** transaction, so the payment record and the
  // request can never drift apart.
  //
  // The terms, identities, rent and amount are all derived from the request
  // snapshot read by this transaction. A preliminary read outside the
  // transaction may be stale by the time the payment is committed; using it
  // could record an old amount, payer or tenant in the payment document.
  // ---------------------------------------------------------------------
  const submissionDetails = await db.runTransaction(async (transaction) => {
    // Every read happens before the first write — a transaction may not read
    // a document it has already written.
    const requestSnapshot = await transaction.get(ref);
    if (!requestSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That booking request no longer exists',
      );
    }

    const fresh = requestSnapshot.data() as Record<string, any>;
    const freshStatus = String(fresh.status || '');
    const studentId = String(fresh.studentId || '');
    const ownerId = String(fresh.ownerId || '');
    const roomId = String(fresh.roomId || '');

    if (!hasValidBookingParties(fresh)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This request does not have a valid student tenant.',
      );
    }
    if (!roomId.trim()) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This request does not identify a room.',
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
        'The student can no longer pay for this booking.',
      );
    }

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
        'The room owner can no longer take payment for this booking.',
      );
    }

    const paymentSnapshot = await transaction.get(paymentRef);
    if (paymentSnapshot.exists) {
      const existingPaymentStatus = String(
        paymentSnapshot.get('status') || '',
      );
      if (existingPaymentStatus === 'verified') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This payment has already been verified',
        );
      }
      if (existingPaymentStatus === 'submitted') {
        // A submitted reference is the payment which the administrator is
        // about to review. A second submission must never overwrite its
        // amount, payer or reference: the first evidence has to remain the
        // evidence which is verified or rejected.
        throw new functions.https.HttpsError(
          'failed-precondition',
          'A payment has already been submitted for this request and is waiting for verification.',
        );
      }
    }

    // Legacy requests may not contain the agreed terms. Read the live
    // settings inside the same transaction so the fallback cannot drift
    // between the read and the commit. A complete request snapshot needs no
    // settings read at all.
    const snapshotPercentage = finiteNumber(fresh.commissionPercentageAtJoin);
    const snapshotPayer = String(fresh.platformFeePayer || '');
    const needsSettings =
      !isValidFeePercentage(snapshotPercentage) ||
      (snapshotPayer !== 'student' && snapshotPayer !== 'owner');
    const settingsSnapshot = needsSettings
      ? await transaction.get(db.collection('settings').doc('platform'))
      : null;
    const { percentage, payer } = resolveAgreedTermsFromData(
      fresh,
      settingsSnapshot
        ? (settingsSnapshot.data() as Record<string, any> | undefined)
        : undefined,
    );

    // The room is always part of the same transaction snapshot. A listing
    // which was taken off the market, deleted or filled after the request
    // was created must not accept a new payment.
    const roomSnapshot = await transaction.get(
      db.collection('rooms').doc(roomId),
    );
    if (!roomSnapshot.exists) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'That room no longer exists',
      );
    }
    const room = roomSnapshot.data() as Record<string, any>;
    const eligibility = decideRoomBookingEligibility(room, ownerId);
    if (!eligibility.allowed) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        roomBookingRejectionMessage(eligibility.reason),
      );
    }

    // The agreed rent is the only canonical source of the payable amount.
    // A legacy request without a valid rent snapshot fails closed instead
    // of silently charging the current room price.
    const monthlyRent = monthlyRentFromData(fresh);
    if (!monthlyRent) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The agreed rent for this request is not valid',
      );
    }
    const amount = platformFeeFor(monthlyRent, percentage);
    const feeWaived = percentage === 0;

    // Every booking decision belongs to one of its two parties. This check
    // also applies when the platform fee is waived: a waived booking still
    // activates a real tenancy, so an unrelated account must never be able to
    // submit it for verification.
    const isStudent = studentId === callerUid;
    const isOwner = ownerId === callerUid;
    if (!isStudent && !isOwner) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'This booking request belongs to somebody else',
      );
    }

    // A waived fee needs no money and no transaction reference. Every other
    // payment needs a reference and may only be submitted by the agreed
    // payer.
    if (!feeWaived && reference.length < 4) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Enter the transaction reference from your UPI app',
      );
    }
    if (!feeWaived && payer === 'owner' && !isOwner) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'The platform fee for this booking is paid by the room owner',
      );
    }
    if (!feeWaived && payer === 'student' && !isStudent) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'The platform fee for this booking is paid by the student',
      );
    }

    // The student has to confirm the booking before a payment is recorded.
    // The owner confirmation alone is not a tenancy and must not activate a
    // room.
    if (freshStatus !== 'studentConfirmed') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        freshStatus === 'cancelled'
          ? 'This booking was cancelled'
          : 'The student has to confirm the request before you can pay',
      );
    }

    // The cut is taken only once — a second payment for the same booking is
    // never accepted.
    if (fresh.platformCutTaken === true) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The platform fee for this booking has already been paid',
      );
    }

    // -------------------------------------------------------------------
    // A transaction reference may only be used **once**.
    //
    // The reference is locked by a deterministic document which is created
    // inside this transaction. Firestore guarantees that only one
    // transaction can create a document with a given id.
    // -------------------------------------------------------------------
    const referenceKey = crypto
      .createHash('sha256')
      .update(
        feeWaived
          ? `waived:${requestId}`
          : reference.toLowerCase(),
      )
      .digest('hex');
    const referenceLockRef = db.collection('paymentReferences').doc(referenceKey);
    const referenceLockSnapshot = await transaction.get(referenceLockRef);
    if (referenceLockSnapshot.exists) {
      const lockedBy = String(referenceLockSnapshot.get('requestId') || '');
      if (lockedBy !== requestId) {
        throw new functions.https.HttpsError(
          'already-exists',
          'That transaction reference has already been used for another payment',
        );
      }
    } else {
      transaction.create(referenceLockRef, {
        requestId,
        reference: feeWaived ? 'waived' : reference,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
    }

    const details = {
      requestId,
      studentId,
      ownerId,
      roomId,
      monthlyRent,
      amount,
      feePercentage: percentage,
      reference,
      method,
      payer,
      feeWaived,
      payeeVpa: PLATFORM_UPI_VPA,
    };

    // The payment record is only a **submission**. It is deliberately kept
    // in the `submitted` state; an admin has to verify it before the
    // booking becomes a joined room.
    transaction.set(
      paymentRef,
      {
        ...buildPaymentSubmissionRecord(details),
        submittedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Only the **payment state** is recorded here. No invoice is created,
    // no occupancy is changed and the request does not become active. The
    // activation belongs to `verifyPayment` alone.
    transaction.update(ref, {
      ...buildPaymentSubmissionRequestUpdates(details),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });

    return details;
  });

  const {
    amount,
    feeWaived,
    payer,
    feePercentage: percentage,
    roomId,
    studentId,
    ownerId,
  } = submissionDetails;
  const who = payer === 'owner' ? 'The room owner' : 'The student';
  const other = payer === 'owner' ? studentId : ownerId;

  // ---------------------------------------------------------------------
  // Both sides are told that the payment is waiting for verification.
  //
  // The booking is **not** active yet. Only `verifyPayment` may create the
  // invoice and put the student into the room's occupancy counter.
  // ---------------------------------------------------------------------
  await notifyUser(
    context.auth.uid,
    feeWaived ? 'Booking submitted' : 'Payment submitted',
    feeWaived
      ? 'There was no platform fee for this booking — it is waiting for the ' +
        'admin confirmation.'
      : `Your ₹${amount} platform fee for request ${requestId} was recorded. ` +
        'It is waiting for verification.',
    'invoicePaid',
    { requestId, roomId, amount: String(amount) },
  );

  await notifyUser(
    other,
    'Payment submitted',
    feeWaived
      ? 'The booking was submitted — there was no platform fee to pay. It is ' +
        'waiting for the admin confirmation.'
      : `The ${percentage}% StayServe platform fee (₹${amount}) was submitted by ` +
        `${who.toLowerCase()}. The booking is waiting for verification.`,
    'invoicePaid',
    { requestId, roomId, amount: String(amount) },
  );

  return {
    success: true,
    status: 'submitted',
    amount,
    payer: feeWaived ? 'none' : payer,
    invoiceId: null,
    bookingConfirmed: false,
    message: feeWaived
      ? 'The booking was submitted — it is waiting for admin confirmation.'
      : 'Payment submitted — the booking is waiting for admin verification.',
  };
});

/**
 * Admin-only: verifies or rejects a submitted payment.
 *
 * This is the only place where `advancePaid` is set to `true`.
 */
export const verifyPayment = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale; the live server-side role decides
  // whether this administrator may still verify a payment.
  await assertLiveAdmin(context.auth.uid);
  // The uid is read once — inside the transaction callback TypeScript cannot
  // narrow `context.auth` any more.
  const adminUid = context.auth.uid;

  const requestId = String(data?.requestId || '');
  const approve = data?.approve === true;
  const note = data?.note ? String(data.note).trim() : null;

  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing booking request');
  }

  const paymentRef = db.collection('payments').doc(requestId);
  const requestRef = db.collection('joinRequests').doc(requestId);
  const invoiceRef = db.collection('commissionInvoices').doc(`INV-${requestId}`);
  const status = approve ? 'verified' : 'rejected';

  // ---------------------------------------------------------------------
  // The decision happens inside a **transaction**.
  //
  // Two admins (or one admin who double-clicks) could otherwise both read
  // the payment as `submitted` and then write two different decisions: one
  // of them would verify the payment while the other one rolled the
  // booking back — and the request, the invoice, the room and the payment
  // record would end up contradicting each other.
  //
  // The transaction re-reads the payment, so the second decision is
  // refused: only one of them may commit.
  // ---------------------------------------------------------------------
  const { request, amount, activated } = await db.runTransaction(async (transaction) => {
    // The caller's live administrator role is checked in the same
    // transaction as the payment decision. A concurrent demotion or ban
    // therefore serializes with this verification.
    const adminSnapshot = await transaction.get(
      db.collection('users').doc(adminUid),
    );
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

    const paymentSnapshot = await transaction.get(paymentRef);
    if (!paymentSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'No payment was submitted for this request',
      );
    }

    const payment = paymentSnapshot.data() as Record<string, any>;
    if (payment.status === 'verified') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This payment is already verified',
      );
    }
    if (payment.status !== 'submitted') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        `This payment is ${payment.status} and can no longer be verified`,
      );
    }

    const requestSnapshot = await transaction.get(requestRef);
    if (!requestSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That booking request no longer exists',
      );
    }
    // The document id is the authoritative request id. Older requests did
    // not always store the same value in their `requestId` field; using the
    // document id prevents an activation from writing to `INV-undefined` or
    // addressing the wrong join-request document.
    const request: Record<string, any> = Object.assign(
      {},
      requestSnapshot.data() as Record<string, any>,
      { requestId },
    );
    const requestStatus = String(request.status || '');
    const wasAlreadyActive = isActiveBookingStatus(requestStatus);
    const studentId = String(request.studentId || '');
    const ownerId = String(request.ownerId || '');
    const roomId = String(request.roomId || '');

    const roomRef = roomId
      ? db.collection('rooms').doc(roomId)
      : null;

    // Every read happens before the first write — a transaction may not read
    // a document it has already written.
    const roomSnapshot = roomRef
      ? await transaction.get(roomRef)
      : null;
    const invoiceSnapshot = await transaction.get(invoiceRef);
    const parsedPaymentAmount = finiteNumber(payment.amount);
    const commissionValue =
      request.commissionPercentageAtJoin !== undefined
        ? finiteNumber(request.commissionPercentageAtJoin)
        : finiteNumber(payment.feePercentage);
    // A malformed payment must still be rejectable. These safe values are
    // used only for the rejection notification; approval validates the raw
    // values below and refuses to activate the booking.
    const paymentAmount =
      parsedPaymentAmount !== null && parsedPaymentAmount >= 0
        ? parsedPaymentAmount
        : 0;
    const commissionPercentage =
      commissionValue !== null && isValidFeePercentage(commissionValue)
        ? commissionValue
        : 0;
    const paymentMatchesRequest = paymentMatchesBookingRequest(
      payment,
      request,
      requestId,
    );

    if (approve) {
      if (parsedPaymentAmount === null || parsedPaymentAmount < 0) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The submitted payment amount is not valid.',
        );
      }
      if (commissionValue === null || !isValidFeePercentage(commissionValue)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The booking commission percentage is not valid.',
        );
      }
      const agreedRent = request.monthlyRentAtJoin;
      if (!isValidMonthlyRent(agreedRent)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The agreed rent for this booking is not valid.',
        );
      }
      const expectedAmount = platformFeeFor(agreedRent, commissionValue);
      if (parsedPaymentAmount !== expectedAmount) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The submitted payment amount does not match this booking request.',
        );
      }
      if (!hasValidBookingParties(request)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This request does not have a valid student tenant.',
        );
      }
      if (!roomId || !roomSnapshot) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This request does not identify a room.',
        );
      }
      if (!paymentMatchesRequest) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The payment does not match this booking request.',
        );
      }

      // The live student requirement applies only when this decision would
      // activate a new tenancy. An already-active legacy record is merely
      // acknowledged idempotently: it does not occupy another slot, and a
      // banned tenant must not prevent an admin from repairing that record.
      if (!wasAlreadyActive) {
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
            'The student can no longer occupy this room.',
          );
        }

        // The owner profile is read in the same transaction as the
        // activation. An owner whose account is being deleted cannot have a
        // new tenancy committed under their listing.
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
            'The room owner can no longer activate this booking.',
          );
        }
      }

      // Only a confirmed, non-active booking may be activated. An already
      // active legacy record is idempotent, but it must not be counted a
      // second time.
      if (!wasAlreadyActive && requestStatus !== 'studentConfirmed') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The student has to confirm the request before the payment can be verified',
        );
      }

      if (!wasAlreadyActive) {
        if (!roomSnapshot.exists) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'That room no longer exists',
          );
        }

        const roomData = roomSnapshot.data() || {};
        const eligibility = decideRoomBookingEligibility(roomData, ownerId);
        if (!eligibility.allowed) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            roomBookingRejectionMessage(eligibility.reason),
          );
        }
      }

      // The activation is the **only** place where a booking becomes a
      // joined room. It writes the request, invoice, payment state and
      // occupancy in one transaction.
      const activation = await addBookingActivation(
        transaction,
        { ...(request as ActivatableRequest), status: requestStatus },
        {
          commissionPercentage,
          platformCutTaken: true,
          // A waived fee is a real booking, but no money changed hands.
          advancePaid: paymentAmount > 0,
          advancePaymentStatus: 'verified',
          advanceAmount: paymentAmount,
          advancePaymentReference:
            paymentAmount > 0 ? payment.reference || null : null,
          advancePaymentMethod:
            paymentAmount > 0 ? payment.method || null : null,
          advanceUpiTransactionId:
            paymentAmount > 0 ? payment.reference || null : null,
          paidAt:
            paymentAmount > 0
              ? firestore.FieldValue.serverTimestamp()
              : undefined,
        },
        roomSnapshot,
        invoiceSnapshot,
      );

      if (activation.roomFull) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'That room is full — every slot is taken',
        );
      }

      transaction.set(
        paymentRef,
        {
          status,
          verifiedAt: firestore.FieldValue.serverTimestamp(),
          verifiedBy: adminUid,
          note,
        },
        { merge: true },
      );

      return { request, amount: paymentAmount, activated: !wasAlreadyActive };
    }

    // -------------------------------------------------------------------
    // The money did **not** arrive.
    //
    // The payment record is always rejected, even when its identities are
    // malformed: an invalid payment has to remain rejectable. The booking
    // itself is changed only when the payment belongs to it and the request
    // is in a state from which payment may be submitted. A cancelled or
    // declined request is terminal and must never be resurrected here.
    // -------------------------------------------------------------------
    transaction.set(
      paymentRef,
      {
        status,
        verifiedAt: firestore.FieldValue.serverTimestamp(),
        verifiedBy: adminUid,
        note,
      },
      { merge: true },
    );

    const validParties = hasValidBookingParties(request);
    const roomOwnerMatches =
      !wasAlreadyActive ||
      !!(
        roomSnapshot &&
        roomSnapshot.exists &&
        String(roomSnapshot.data()?.ownerId || '') === ownerId
      );
    const canChangeRequest =
      paymentMatchesRequest && validParties && roomOwnerMatches;
    const nextStatus = rejectedPaymentBookingStatus(
      requestStatus,
      wasAlreadyActive,
      canChangeRequest,
    );
    const rollsBackActiveBooking = nextStatus !== null && wasAlreadyActive;

    if (nextStatus !== null) {
      transaction.update(requestRef, {
        status: nextStatus,
        advancePaid: false,
        advancePaymentStatus: status,
        advancePaidAt: null,
        platformCutTaken: false,
        invoiceId: wasAlreadyActive ? null : request.invoiceId || null,
        advancePaymentReference: null,
        advancePaymentMethod: null,
        advanceUpiTransactionId: null,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });

      if (invoiceSnapshot && invoiceSnapshot.exists) {
        transaction.update(invoiceRef, {
          status: 'cancelled',
          cancelledAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    if (
      rollsBackActiveBooking &&
      roomRef &&
      roomSnapshot &&
      roomSnapshot.exists
    ) {
      const data = roomSnapshot.data() || {};
      const current = Number(data.currentOccupancy || 0);
      const occupancy = Number(data.occupancy || 1);
      const newOccupancy = current > 0 ? current - 1 : 0;
      transaction.update(roomRef, {
        currentOccupancy: newOccupancy,
        status: roomStatusAfterOccupancyChange(
          String(data.status || 'available'),
          occupancy,
          newOccupancy,
        ),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
    }

    return { request, amount: paymentAmount, activated: false };
  });

  await notifyUser(
    request.studentId,
    approve ? 'Payment verified' : 'Payment could not be verified',
    approve
      ? `The ₹${amount} platform fee has been verified. The owner has been notified.`
      : `We could not verify your ₹${amount} payment${note ? `: ${note}` : '.'} Please check the reference and try again.`,
    approve ? 'invoicePaid' : 'adminReview',
    { requestId, roomId: request.roomId, amount: String(amount) },
  );

  await notifyUser(
    request.ownerId,
    approve ? 'Platform fee received' : 'Platform fee could not be verified',
    approve
      ? `The ₹${amount} platform fee for request ${requestId} has been verified. ` +
        'From now on the rent is settled directly between you and the student.'
      : `The ₹${amount} platform fee for request ${requestId} could not be ` +
        `verified${note ? `: ${note}` : '.'} The booking has been put on hold.`,
    approve ? 'invoicePaid' : 'adminReview',
    { requestId, roomId: request.roomId, amount: String(amount) },
  );

  return { success: true, status, amount };
});
