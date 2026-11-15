import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = admin.firestore();

/**
 * Booking activation.
 *
 * "Activating" a booking means three things happen together:
 *
 *  1. the join request moves to `adminReviewed` — that is the state that
 *     makes it a *joined room*,
 *  2. the commission invoice is created, and
 *  3. the room takes the new tenant into account.
 *
 * They used to happen in two different places — a client-side transaction in
 * the admin app and a cloud function for the payment — and the two copies
 * drifted apart. They now live here, so there is exactly one definition of
 * "the booking is active".
 */

/** The prefix of a commission invoice id. */
export const INVOICE_PREFIX = 'INV-';

/**
 * Whether a request status represents an active booking.
 *
 * `admin_reviewed` is the legacy spelling of `adminReviewed`. Both mean
 * that the student has a joined room and that the occupancy counter already
 * includes the tenant.
 */
export function isActiveBookingStatus(status: string): boolean {
  return status === 'adminReviewed' || status === 'admin_reviewed';
}

/**
 * The request status after a submitted payment is rejected.
 *
 * A normal submission never activated the booking, so the request returns to
 * the last state in which the platform fee may be paid. A legacy active
 * record is also rolled back to `studentConfirmed`; only the payment
 * verification path is allowed to release its occupancy.
 */
export function bookingStatusAfterRejectedPayment(status: string): string {
  return status === 'ownerConfirmed' ? 'ownerConfirmed' : 'studentConfirmed';
}

/** The payment details recorded by `submitPayment`. */
export interface PaymentSubmissionDetails {
  requestId: string;
  studentId: string;
  ownerId: string;
  roomId: string;
  amount: number;
  feePercentage: number;
  reference: string;
  method: string;
  payer: string;
  feeWaived: boolean;
  payeeVpa: string;
}

/**
 * Builds the payment record of a submission.
 *
 * The status is deliberately `submitted`: only the admin verification path
 * may mark it `verified` and activate the booking.
 */
export function buildPaymentSubmissionRecord(
  details: PaymentSubmissionDetails,
): Record<string, any> {
  return {
    requestId: details.requestId,
    studentId: details.studentId,
    ownerId: details.ownerId,
    roomId: details.roomId,
    amount: details.amount,
    feePercentage: details.feePercentage,
    reference: details.feeWaived ? 'waived' : details.reference,
    method: details.feeWaived ? 'waived' : details.method,
    payer: details.payer,
    payeeVpa: details.payeeVpa,
    status: 'submitted',
    verifiedAt: null,
    verifiedBy: null,
    note: null,
  };
}

/**
 * Builds the request fields changed by a payment submission.
 *
 * There is deliberately no `status`, `invoiceId` or occupancy field here:
 * a submitted payment is not a tenancy and must not activate a room.
 */
export function buildPaymentSubmissionRequestUpdates(
  details: PaymentSubmissionDetails,
): Record<string, any> {
  return {
    advancePaid: false,
    advanceAmount: details.amount,
    advancePaymentReference: details.feeWaived ? null : details.reference,
    advancePaymentMethod: details.feeWaived ? null : details.method,
    advanceUpiTransactionId: details.feeWaived ? null : details.reference,
    advancePaymentStatus: 'submitted',
    platformCutTaken: false,
    commissionPercentageAtJoin: details.feePercentage,
    platformFeePayer: details.payer,
  };
}

/** The join request, as far as the activation needs it. */
export interface ActivatableRequest {
  requestId: string;
  roomId: string;
  ownerId: string;
  studentId: string;
  monthlyRentAtJoin: number;
  commissionPercentageAtJoin: number;
  status: string;
  [key: string]: any;
}

/** How a booking is activated. */
export interface ActivationOptions {
  /** The commission percentage that is recorded on the booking. */
  commissionPercentage: number;
  /** Whether the platform cut has been taken (it is taken **once**). */
  platformCutTaken: boolean;
  /** Whether the advance has been paid. */
  advancePaid: boolean;
  /** The state of the payment record (`submitted`, `verified`, …). */
  advancePaymentStatus: string;
  /** The amount that was charged. */
  advanceAmount: number;
  /** The reference the payer used. */
  advancePaymentReference?: string | null;
  /** How the payment was made. */
  advancePaymentMethod?: string | null;
  /** The UPI transaction id. */
  advanceUpiTransactionId?: string | null;
  /** When the payment was made — `null` leaves the old value alone. */
  paidAt?: admin.firestore.FieldValue | null;
}

/**
 * The commission for a monthly rent.
 *
 * Rounded to whole rupees — the same rounding the client uses, so the
 * invoice, the payment and the screen always agree.
 */
export function commissionFor(monthlyRent: number, percentage: number): number {
  return Math.round((monthlyRent * percentage) / 100);
}

/**
 * The status a room has after its occupancy changed.
 *
 * An **inactive** listing stays inactive.
 *
 * The owner took the listing off the market on purpose, and neither a
 * booking that starts nor a booking that ends may put it back into the
 * search. The old code wrote `available` (or `occupied`) unconditionally —
 * so rolling back a payment quietly republished a listing the owner had
 * deactivated, and a student could book a room that was not on the market.
 */
export function roomStatusAfterOccupancyChange(
  currentStatus: string,
  occupancy: number,
  currentOccupancy: number,
): string {
  if (currentStatus === 'inactive') return 'inactive';
  return currentOccupancy >= occupancy ? 'occupied' : 'available';
}

/**
 * Where the writes of the activation go.
 *
 * Both a **batch** and a **transaction** can do this — and the difference
 * matters: a transaction re-reads the documents it writes and fails if
 * somebody else changed them in the meantime. That is what makes the
 * activation safe against a cancellation that happens at the same moment.
 */
export interface BookingWriter {
  set(
    ref: admin.firestore.DocumentReference,
    data: admin.firestore.DocumentData,
    options?: admin.firestore.SetOptions,
  ): void;
  update(
    ref: admin.firestore.DocumentReference,
    data: admin.firestore.UpdateData<admin.firestore.DocumentData>,
  ): void;
}

/**
 * The result of an activation.
 */
export interface ActivationResult {
  /** The id of the commission invoice that was created. */
  invoiceId: string;
  /**
   * Whether the room was **full**.
   *
   * The activation is refused in that case — a room with one slot cannot
   * take a second tenant. The caller has to abort the transaction (and
   * tell the user why).
   */
  roomFull: boolean;
}

/**
 * Adds the activation of a booking to [writer].
 *
 * The room document is read **before** the writes are committed (a batch
 * cannot read), so the occupancy is correct.
 *
 * [roomSnapshot] may be handed in when the caller already read the room —
 * a transaction has to read **everything** before it writes anything, and
 * it must not read the room a second time (a second read would return the
 * version the transaction already holds).
 */
export async function addBookingActivation(
  writer: BookingWriter,
  request: ActivatableRequest,
  options: ActivationOptions,
  roomSnapshot?: admin.firestore.DocumentSnapshot | null,
  invoiceSnapshot?: admin.firestore.DocumentSnapshot | null,
): Promise<ActivationResult> {
  const invoiceId = `${INVOICE_PREFIX}${request.requestId}`;
  const commissionAmount = commissionFor(
    Number(request.monthlyRentAtJoin || 0),
    options.commissionPercentage,
  );

  // -----------------------------------------------------------------------
  // Read everything **before** the first write.
  //
  // Firestore transactions require all reads to happen before all writes.
  // The old helper wrote the invoice and the request first and only then
  // read the room, which made the transaction invalid (and could leave the
  // request active without a room when the read failed).
  // -----------------------------------------------------------------------
  const room =
    roomSnapshot !== undefined
      ? roomSnapshot
      : await db.collection('rooms').doc(request.roomId).get();
  const invoice =
    invoiceSnapshot !== undefined
      ? invoiceSnapshot
      : await db
          .collection('commissionInvoices')
          .doc(invoiceId)
          .get();

  if (!room || !room.exists) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'That room no longer exists',
    );
  }

  const roomData = room.data() || {};
  const occupancy = Number(roomData.occupancy || 1);
  const currentOccupancy = Number(roomData.currentOccupancy || 0);

  if (!Number.isFinite(occupancy) || occupancy <= 0) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'That room has an invalid capacity',
    );
  }
  if (!Number.isFinite(currentOccupancy) || currentOccupancy < 0) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'That room has an invalid occupancy',
    );
  }

  // `admin_reviewed` is the legacy spelling of the active state. It is
  // treated as active as well, so repairing an old document cannot count
  // the tenant a second time.
  const wasAlreadyActive = isActiveBookingStatus(request.status);

  // -----------------------------------------------------------------------
  // The room has to have a **free slot**.
  //
  // A full room aborts the transaction before any write happens. The caller
  // turns this into the user-facing error.
  // -----------------------------------------------------------------------
  if (!wasAlreadyActive && currentOccupancy >= occupancy) {
    return { invoiceId, roomFull: true };
  }

  // -----------------------------------------------------------------------
  // The invoice.
  //
  // An already active booking must not have its invoice overwritten: an
  // admin may have marked the invoice as paid after the activation. A
  // missing invoice for a legacy active request is left alone; a later
  // repair/migration can create it without changing the booking state.
  // -----------------------------------------------------------------------
  if (!wasAlreadyActive && (!invoice || !invoice.exists)) {
    writer.set(
      db.collection('commissionInvoices').doc(invoiceId),
      {
        invoiceId,
        roomId: request.roomId,
        ownerId: request.ownerId,
        tenantId: request.studentId,
        joinRequestId: request.requestId,
        monthlyRent: Number(request.monthlyRentAtJoin || 0),
        commissionPercentage: options.commissionPercentage,
        commissionAmount,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
    );
  }

  // -----------------------------------------------------------------------
  // The request.
  // -----------------------------------------------------------------------
  const requestUpdates: Record<string, any> = {
    status: 'adminReviewed',
    adminReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    invoiceId,
    advancePaid: options.advancePaid,
    advanceAmount: options.advanceAmount,
    advancePaymentReference: options.advancePaymentReference ?? null,
    advancePaymentMethod: options.advancePaymentMethod ?? null,
    advanceUpiTransactionId: options.advanceUpiTransactionId ?? null,
    advancePaymentStatus: options.advancePaymentStatus,
    platformCutTaken: options.platformCutTaken,
    commissionPercentageAtJoin: options.commissionPercentage,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (options.paidAt !== undefined) {
    requestUpdates.advancePaidAt = options.paidAt;
  }
  writer.update(db.collection('joinRequests').doc(request.requestId), requestUpdates);

  // -----------------------------------------------------------------------
  // The room takes the new tenant into account.
  //
  // The activation is idempotent: an already active booking is not counted
  // a second time. The counter is server-owned; clients cannot change it.
  // -----------------------------------------------------------------------
  if (!wasAlreadyActive) {
    const newOccupancy = currentOccupancy + 1;
    writer.update(db.collection('rooms').doc(request.roomId), {
      currentOccupancy: newOccupancy,
      status: roomStatusAfterOccupancyChange(
        String(roomData.status || 'available'),
        occupancy,
        newOccupancy,
      ),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  return { invoiceId, roomFull: false };
}
