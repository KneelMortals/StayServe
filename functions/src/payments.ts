import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  PLATFORM_FEE_PERCENTAGE,
  PLATFORM_UPI_NAME,
  PLATFORM_UPI_VPA,
  areNotificationsEnabled,
  platformFeeFor,
  resolveAgreedTerms,
  resolveFeePayer,
  resolveFeePercentage,
} from './platform';
import {
  addBookingActivation,
  bookingStatusAfterRejectedPayment,
  buildPaymentSubmissionRecord,
  buildPaymentSubmissionRequestUpdates,
  commissionFor,
  isActiveBookingStatus,
  roomStatusAfterOccupancyChange,
  INVOICE_PREFIX,
  ActivatableRequest,
} from './bookings';
import { assertActiveAccount, assertLiveAdmin } from './accounts';
import { notify } from './notifications';

const db = admin.firestore();

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
async function resolveMonthlyRent(request: Record<string, any>): Promise<number> {
  const agreed = Number(request.monthlyRentAtJoin || 0);
  if (agreed > 0) return agreed;

  const roomId = String(request.roomId || '');
  if (roomId) {
    try {
      const roomSnapshot = await db.collection('rooms').doc(roomId).get();
      const roomRent = Number(roomSnapshot.get('monthlyRent') || 0);
      if (roomRent > 0) return roomRent;
    } catch (error) {
      console.error('Failed to read the room rent:', error);
    }
  }
  return agreed;
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

async function loadJoinRequest(requestId: string) {
  const ref = db.collection('joinRequests').doc(requestId);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'That booking request no longer exists',
    );
  }
  return { ref, snapshot, data: snapshot.data() as Record<string, any> };
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
export const createUpiPayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const requestId = String(data?.joinRequestId || '');
  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing booking request');
  }

  await assertActiveAccount(context.auth.uid);

  const { data: request } = await loadJoinRequest(requestId);

  const isStudent = request.studentId === context.auth.uid;
  const isOwner = request.ownerId === context.auth.uid;
  if (!isStudent && !isOwner) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'This booking request belongs to somebody else',
    );
  }

  // ---------------------------------------------------------------------
  // The cut has already been taken — this booking has been paid for once.
  //
  // From now on everything goes straight from the student to the room
  // owner; the platform does not take a percentage of the rent any more.
  //
  // This is checked **before** the status, so a stale client gets the
  // explanation instead of a confusing "the owner has to approve your
  // request" error for a booking that is already active.
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

  const monthlyRent = await resolveMonthlyRent(request);
  if (!monthlyRent || monthlyRent <= 0) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The rent for this request is not set',
    );
  }

  // The amount is derived from the rent that was agreed when the request was
  // made — never from anything the client sent, and never from a rent the
  // owner may have changed in the meantime.
  const { percentage, payer } = await resolveAgreedTerms(request);
  const amount = platformFeeFor(monthlyRent, percentage);

  // ---------------------------------------------------------------------
  // The fee is **waived** — the admin has set the percentage to 0 %.
  //
  // There is nothing to pay, so there is no UPI intent and no transaction
  // reference either: the booking can be submitted for admin verification
  // without a payment. The old code still asked for a UPI link of ₹0 and
  // then demanded a reference of at least four characters — a booking that
  // could never be completed.
  // ---------------------------------------------------------------------
  if (amount <= 0) {
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

  // ---------------------------------------------------------------------
  // Does *this* caller have to pay?
  //
  // The setting names the party that settles the fee. The owner and the
  // student each get the pay option on their own side — the sheet shows
  // the real UPI button to the party that has to pay and only an
  // explanation to the other one.
  // ---------------------------------------------------------------------
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
            'directly to the owner.'
          : `The ${percentage}% StayServe platform fee ` +
            `(₹${amount}) is paid by the student. You only pay the rent ` +
            'directly to the student.',
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
      // The note has to stay **below 50 characters** — the UPI apps refuse
      // everything that is longer. The whole request id does not fit next
      // to the explanation, so only the id itself is used.
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
export const submitPayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const requestId = String(data?.requestId || '');
  const reference = String(data?.reference || '').trim();
  const method = String(data?.method || 'upi');

  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing booking request');
  }
  if (!VALID_METHODS.includes(method)) {
    throw new functions.https.HttpsError('invalid-argument', 'Unsupported payment method');
  }

  const { ref, data: request } = await loadJoinRequest(requestId);

  await assertActiveAccount(context.auth.uid);

  // ---------------------------------------------------------------------
  // Who has to settle the platform fee?
  //
  // The party is the one that was agreed when the request was made — the
  // admin can switch the setting, but a booking that is already waiting for
  // its payment keeps the terms it was made with.
  // ---------------------------------------------------------------------
  const { percentage, payer } = await resolveAgreedTerms(request);
  const isStudent = request.studentId === context.auth.uid;
  const isOwner = request.ownerId === context.auth.uid;

  // ---------------------------------------------------------------------
  // A **waived** fee (0 %) needs no money and no transaction reference.
  //
  // The reference is only checked when there is something to pay — with a
  // waived fee there is no UPI transfer, so there is no reference to enter.
  // ---------------------------------------------------------------------
  const feeWaived = percentage === 0;
  if (!feeWaived && reference.length < 4) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Enter the transaction reference from your UPI app',
    );
  }

  // With a waived fee nobody has to pay, so both parties may confirm the
  // booking.
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

  if (request.status !== 'studentConfirmed') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The student has to confirm the request before you can pay',
    );
  }

  // The cut is taken only once — a second payment for the same booking is
  // never accepted.
  if (request.platformCutTaken === true) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The platform fee for this booking has already been paid',
    );
  }

  const paymentRef = db.collection('payments').doc(requestId);

  // ---------------------------------------------------------------------
  // A transaction reference may only be used **once**.
  //
  // The check used to be a plain query ("has anybody else used this
  // reference?"). That check has a race: two different bookings can submit
  // the *same* reference at the same moment, and both queries run before
  // either payment is written — so both bookings would be activated with one
  // and the same UPI transaction.
  //
  // The reference is therefore locked by a **deterministic document**: the
  // id of the lock is the hash of the reference, and the document is
  // *created* inside the transaction. Firestore guarantees that only one
  // transaction can create a document with a given id — the second one
  // fails and is retried, and then it finds the lock and refuses the
  // payment.
  // ---------------------------------------------------------------------
  const referenceKey = crypto
    .createHash('sha256')
    .update(
      feeWaived
        ? `waived:${requestId}`
        : reference.toLowerCase(),
    )
    .digest('hex');
  const referenceLockRef = db.collection('paymentReferences').doc(referenceKey);

  const monthlyRent = await resolveMonthlyRent(request);
  const amount = platformFeeFor(monthlyRent, percentage);
  const submissionDetails = {
    requestId,
    studentId: request.studentId,
    ownerId: request.ownerId,
    roomId: request.roomId,
    amount,
    feePercentage: percentage,
    reference,
    method,
    payer,
    feeWaived,
    payeeVpa: PLATFORM_UPI_VPA,
  };

  // ---------------------------------------------------------------------
  // Everything happens in **one** transaction, so the payment record and the
  // request can never drift apart.
  //
  // A transaction (and not a plain batch) is what makes the payment safe
  // against a cancellation that happens at the very same moment: the
  // transaction re-reads the request, and it fails if somebody else changed
  // it in the meantime.
  // ---------------------------------------------------------------------
  await db.runTransaction(async (transaction) => {
    // Every read happens before the first write — a transaction may not read
    // a document it has already written.
    const requestSnapshot = await transaction.get(ref);
    const paymentSnapshot = await transaction.get(paymentRef);
    const referenceLockSnapshot = await transaction.get(referenceLockRef);

    if (!requestSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That booking request no longer exists',
      );
    }

    const fresh = requestSnapshot.data() as Record<string, any>;
    const freshStatus = String(fresh.status || '');

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

    if (paymentSnapshot.exists && paymentSnapshot.get('status') === 'verified') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This payment has already been verified',
      );
    }

    // The reference may only be used once — the lock document makes that
    // check atomic (see the comment above).
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
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // The payment record is only a **submission**. It is deliberately kept
    // in the `submitted` state; an admin has to verify it before the
    // booking becomes a joined room.
    transaction.set(
      paymentRef,
      {
        ...buildPaymentSubmissionRecord(submissionDetails),
        submittedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    // Only the **payment state** is recorded here. No invoice is created,
    // no occupancy is changed and the request does not become active. The
    // activation belongs to `verifyPayment` alone.
    transaction.update(ref, {
      ...buildPaymentSubmissionRequestUpdates(submissionDetails),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  const who = payer === 'owner' ? 'The room owner' : 'The student';
  const other = payer === 'owner' ? request.studentId : request.ownerId;

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
    { requestId, roomId: request.roomId, amount: String(amount) },
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
    { requestId, roomId: request.roomId, amount: String(amount) },
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
export const verifyPayment = functions.https.onCall(async (data, context) => {
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
    const request = requestSnapshot.data() as Record<string, any>;
    const requestStatus = String(request.status || '');
    const wasAlreadyActive = isActiveBookingStatus(requestStatus);
    const roomId = String(request.roomId || '');
    const roomRef = db.collection('rooms').doc(roomId);

    // Every read happens before the first write — a transaction may not read
    // a document it has already written.
    const roomSnapshot = await transaction.get(roomRef);
    const invoiceSnapshot = await transaction.get(invoiceRef);
    const paymentAmount = Number(payment.amount || 0);
    const commissionPercentage =
      request.commissionPercentageAtJoin !== undefined
        ? Number(request.commissionPercentageAtJoin)
        : Number(payment.feePercentage || 0);

    if (approve) {
      // Only a confirmed, non-active booking may be activated. An already
      // active legacy record is idempotent, but it must not be counted a
      // second time.
      if (!wasAlreadyActive && requestStatus !== 'studentConfirmed') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The student has to confirm the request before the payment can be verified',
        );
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
              ? admin.firestore.FieldValue.serverTimestamp()
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
          verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
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
    // A submitted payment was never allowed to activate a booking, so a
    // rejection normally has no occupancy to release. Legacy records that
    // were activated by the old submit path are handled explicitly: only
    // those records decrement the counter.
    // -------------------------------------------------------------------
    transaction.set(
      paymentRef,
      {
        status,
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        verifiedBy: adminUid,
        note,
      },
      { merge: true },
    );

    transaction.update(requestRef, {
      status: bookingStatusAfterRejectedPayment(requestStatus),
      advancePaid: false,
      advancePaymentStatus: status,
      advancePaidAt: null,
      platformCutTaken: false,
      invoiceId: wasAlreadyActive ? null : request.invoiceId || null,
      advancePaymentReference: null,
      advancePaymentMethod: null,
      advanceUpiTransactionId: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (invoiceSnapshot && invoiceSnapshot.exists) {
      transaction.update(invoiceRef, {
        status: 'cancelled',
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    if (wasAlreadyActive && roomSnapshot && roomSnapshot.exists) {
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
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
