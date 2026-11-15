// Tests for the pure helpers of the backend.
//
// These are the rules that decide whether a booking may be cancelled,
// whether a student may review a room and what happens to a listing whose
// occupancy changed. They are the heart of the booking flow, and they are
// easy to get wrong — so they are tested directly.
//
//   node tools/functions_unit_test.mjs
//
// The helpers are read from the **compiled** output (`functions/lib`), so
// the test runs against exactly the code that is deployed.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(
      `  FAIL  ${label}  expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// The compiled helpers.
const {
  roomStatusAfterOccupancyChange,
  isActiveBookingStatus,
  bookingStatusAfterRejectedPayment,
  buildPaymentSubmissionRecord,
  buildPaymentSubmissionRequestUpdates,
} = require(path.join(ROOT, 'functions', 'lib', 'bookings.js'));
const { ownerHasAccepted, paymentAlreadyMade } = require(
  path.join(ROOT, 'functions', 'lib', 'bookingAccess.js'),
);

// ---------------------------------------------------------------------------
section('the status of a room after its occupancy changed');

check(
  'a room with a free slot stays available',
  roomStatusAfterOccupancyChange('available', 2, 1),
  'available',
);
check(
  'a room whose last slot was taken becomes occupied',
  roomStatusAfterOccupancyChange('available', 2, 2),
  'occupied',
);
check(
  'an inactive listing stays inactive — a booking may not publish it',
  roomStatusAfterOccupancyChange('inactive', 2, 1),
  'inactive',
);
check(
  'an inactive listing stays inactive even when it is full',
  roomStatusAfterOccupancyChange('inactive', 2, 2),
  'inactive',
);
check(
  'an occupied room that frees a slot becomes available',
  roomStatusAfterOccupancyChange('occupied', 2, 1),
  'available',
);

// ---------------------------------------------------------------------------
section('the states in which the owner has accepted the request');

check('a pending request is not an acceptance', ownerHasAccepted('pending'), false);
check(
  'the approval of the owner is an acceptance',
  ownerHasAccepted('ownerConfirmed'),
  true,
);
check(
  'the confirmation of the student is an acceptance',
  ownerHasAccepted('studentConfirmed'),
  true,
);
check(
  'the review of the admin is an acceptance',
  ownerHasAccepted('adminReviewed'),
  true,
);
check(
  'the legacy admin_reviewed spelling is also an acceptance',
  ownerHasAccepted('admin_reviewed'),
  true,
);
check('a declined request is not an acceptance', ownerHasAccepted('rejected'), false);
check('a cancelled request is not an acceptance', ownerHasAccepted('cancelled'), false);
check('an unknown state is not an acceptance', ownerHasAccepted('something'), false);

// ---------------------------------------------------------------------------
section('whether a booking has reached a live payment state');

check('nothing was paid', paymentAlreadyMade({}), false);
check(
  'the advance is paid',
  paymentAlreadyMade({ advancePaid: true }),
  true,
);
check(
  'the platform cut was taken',
  paymentAlreadyMade({ platformCutTaken: true }),
  true,
);
check(
  'the payment was submitted',
  paymentAlreadyMade({ advancePaymentStatus: 'submitted' }),
  true,
);
check(
  'the payment was verified',
  paymentAlreadyMade({ advancePaymentStatus: 'verified' }),
  true,
);
check(
  'the payment was rejected — no money arrived',
  paymentAlreadyMade({ advancePaymentStatus: 'rejected' }),
  false,
);
check(
  'the advance is explicitly not paid',
  paymentAlreadyMade({ advancePaid: false, advancePaymentStatus: null }),
  false,
);

// ---------------------------------------------------------------------------
section('the payment submission state machine');

const submission = {
  requestId: 'JRQ-1',
  studentId: 'student-1',
  ownerId: 'owner-1',
  roomId: 'room-1',
  amount: 300,
  feePercentage: 30,
  reference: 'UPI-1234',
  method: 'upi',
  payer: 'student',
  feeWaived: false,
  payeeVpa: 'platform@upi',
};

check(
  'a submitted payment stays submitted',
  buildPaymentSubmissionRecord(submission).status,
  'submitted',
);
check(
  'a submitted payment is not marked verified',
  buildPaymentSubmissionRecord(submission).verifiedAt,
  null,
);
check(
  'a submission does not activate the request',
  buildPaymentSubmissionRequestUpdates(submission).advancePaid,
  false,
);
check(
  'a submission does not take the platform cut',
  buildPaymentSubmissionRequestUpdates(submission).platformCutTaken,
  false,
);
check(
  'a submission records the submitted state on the request',
  buildPaymentSubmissionRequestUpdates(submission).advancePaymentStatus,
  'submitted',
);
check(
  'a submission does not change the request status',
  Object.prototype.hasOwnProperty.call(
    buildPaymentSubmissionRequestUpdates(submission),
    'status',
  ),
  false,
);
check(
  'a submission does not create an invoice reference',
  Object.prototype.hasOwnProperty.call(
    buildPaymentSubmissionRequestUpdates(submission),
    'invoiceId',
  ),
  false,
);
check(
  'a waived submission has no transaction reference',
  buildPaymentSubmissionRequestUpdates({
    ...submission,
    feeWaived: true,
  }).advancePaymentReference,
  null,
);

check(
  'adminReviewed is an active booking',
  isActiveBookingStatus('adminReviewed'),
  true,
);
check(
  'the legacy admin_reviewed spelling is an active booking',
  isActiveBookingStatus('admin_reviewed'),
  true,
);
check(
  'studentConfirmed is not an active booking',
  isActiveBookingStatus('studentConfirmed'),
  false,
);
check(
  'a rejected payment restores studentConfirmed',
  bookingStatusAfterRejectedPayment('studentConfirmed'),
  'studentConfirmed',
);
check(
  'a rejected payment restores ownerConfirmed when the student had not confirmed',
  bookingStatusAfterRejectedPayment('ownerConfirmed'),
  'ownerConfirmed',
);
check(
  'a rejected legacy active booking returns to studentConfirmed',
  bookingStatusAfterRejectedPayment('admin_reviewed'),
  'studentConfirmed',
);

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed checks:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
