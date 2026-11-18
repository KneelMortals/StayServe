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
  rejectedPaymentBookingStatus,
  buildPaymentSubmissionRecord,
  buildPaymentSubmissionRequestUpdates,
} = require(path.join(ROOT, 'functions', 'lib', 'bookings.js'));
const {
  ownerHasAccepted,
  paymentAlreadyMade,
  canCreateBookingForRole,
  canBookAsStudent,
  canActAsRoomOwner,
  hasValidBookingParties,
  paymentMatchesBookingRequest,
} = require(path.join(ROOT, 'functions', 'lib', 'bookingAccess.js'));
const {
  canCompleteRegistration,
  canClaimRegistrationRole,
  hasClaimedRegistrationRole,
  resolveRegistrationRole,
} = require(path.join(ROOT, 'functions', 'lib', 'registrationAccess.js'));
const { roleChangeRequestEffect } = require(
  path.join(ROOT, 'functions', 'lib', 'roleChangeAccess.js'),
);
const { appCheckEnforcementRequested } = require(
  path.join(ROOT, 'functions', 'lib', 'appCheck.js'),
);
const {
  parsePlatformFeePercentage,
  resolveAgreedTermsFromData,
} = require(path.join(ROOT, 'functions', 'lib', 'platform.js'));
const {
  decideRoomBookingEligibility,
  isValidCurrentOccupancy,
  isValidMonthlyRent,
  isValidRoomCapacity,
  readRoomCapacityState,
} = require(path.join(ROOT, 'functions', 'lib', 'roomValidation.js'));

// ---------------------------------------------------------------------------
section('the canonical room listing contract');

check('a rent at the lower limit is accepted', isValidMonthlyRent(1000), true);
check('a rent at the upper limit is accepted', isValidMonthlyRent(1000000), true);
check('a rent below the lower limit is refused', isValidMonthlyRent(999), false);
check('a rent above the upper limit is refused', isValidMonthlyRent(1000001), false);
check('a numeric-string rent is refused', isValidMonthlyRent('5000'), false);
check('a non-finite rent is refused', isValidMonthlyRent(Number.NaN), false);
check('a whole-number capacity is accepted', isValidRoomCapacity(2), true);
check('a fractional capacity is refused', isValidRoomCapacity(1.5), false);
check('a capacity above the limit is refused', isValidRoomCapacity(21), false);
check('a negative occupancy is refused', isValidCurrentOccupancy(-1), false);
check('a fractional occupancy is refused', isValidCurrentOccupancy(0.5), false);
check(
  'a missing occupancy counter is refused',
  readRoomCapacityState({ occupancy: 2 }),
  null,
);
check(
  'an occupancy above the capacity is refused',
  readRoomCapacityState({ occupancy: 2, currentOccupancy: 3 }),
  null,
);
check(
  'a valid capacity and occupancy are accepted',
  readRoomCapacityState({ occupancy: 2, currentOccupancy: 1 }),
  { capacity: 2, currentOccupancy: 1 },
);

const eligibleRoom = {
  ownerId: 'owner-1',
  status: 'available',
  isAvailable: true,
  monthlyRent: 5000,
  occupancy: 2,
  currentOccupancy: 0,
};
check(
  'an available room with a free slot is eligible',
  decideRoomBookingEligibility(eligibleRoom, 'owner-1'),
  { allowed: true, capacity: { capacity: 2, currentOccupancy: 0 } },
);
check(
  'a room with another owner is refused',
  decideRoomBookingEligibility(eligibleRoom, 'owner-2').reason,
  'owner-mismatch',
);
check(
  'a room which left the market is refused',
  decideRoomBookingEligibility({ ...eligibleRoom, status: 'inactive' }, 'owner-1')
    .reason,
  'unavailable',
);
check(
  'a room being deleted is refused',
  decideRoomBookingEligibility(
    { ...eligibleRoom, deletionInProgress: true },
    'owner-1',
  ).reason,
  'unavailable',
);
check(
  'a room with a malformed rent is refused',
  decideRoomBookingEligibility({ ...eligibleRoom, monthlyRent: '5000' }, 'owner-1')
    .reason,
  'invalid-rent',
);
check(
  'a full room is refused',
  decideRoomBookingEligibility(
    { ...eligibleRoom, currentOccupancy: 2 },
    'owner-1',
  ).reason,
  'full',
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
section('the role that may create a booking');

check('a student may book a room', canCreateBookingForRole('student'), true);
check('an owner may not book a room', canCreateBookingForRole('owner'), false);
check('an admin may not book a room', canCreateBookingForRole('admin'), false);
check('an unknown role may not book a room', canCreateBookingForRole('unknown'), false);
check('a missing role may not book a room', canCreateBookingForRole(null), false);

const liveStudent = {
  exists: true,
  registrationCompleted: true,
  isActive: true,
  role: 'student',
};
check(
  'a live, registered student may book a room',
  canBookAsStudent(liveStudent),
  true,
);
check(
  'an owner profile may not book a room',
  canBookAsStudent({ ...liveStudent, role: 'owner' }),
  false,
);
check(
  'an inactive student may not book a room',
  canBookAsStudent({ ...liveStudent, isActive: false }),
  false,
);
check(
  'an incomplete student registration may not book a room',
  canBookAsStudent({ ...liveStudent, registrationCompleted: false }),
  false,
);
check(
  'a missing student profile may not book a room',
  canBookAsStudent({ ...liveStudent, exists: false }),
  false,
);

const liveOwner = {
  exists: true,
  registrationCompleted: true,
  isActive: true,
  role: 'owner',
};
check(
  'a live owner may manage an owner-side booking',
  canActAsRoomOwner(liveOwner),
  true,
);
check(
  'a demoted owner may not manage an owner-side booking',
  canActAsRoomOwner({ ...liveOwner, role: 'student' }),
  false,
);
check(
  'a banned owner may not manage an owner-side booking',
  canActAsRoomOwner({ ...liveOwner, isActive: false }),
  false,
);
check(
  'an incomplete owner registration may not manage a booking',
  canActAsRoomOwner({ ...liveOwner, registrationCompleted: false }),
  false,
);

// ---------------------------------------------------------------------------
section('the identities which belong to a booking');

check(
  'a student and a different owner form valid parties',
  hasValidBookingParties({
    studentId: 'student-1',
    ownerId: 'owner-1',
  }),
  true,
);
check(
  'an owner may not be their own tenant',
  hasValidBookingParties({
    studentId: 'owner-1',
    ownerId: 'owner-1',
  }),
  false,
);
check(
  'a missing tenant is not a valid booking party',
  hasValidBookingParties({
    studentId: '',
    ownerId: 'owner-1',
  }),
  false,
);

const matchingPayment = {
  requestId: 'JRQ-1',
  studentId: 'student-1',
  ownerId: 'owner-1',
  roomId: 'room-1',
};
const matchingRequest = {
  requestId: 'JRQ-1',
  studentId: 'student-1',
  ownerId: 'owner-1',
  roomId: 'room-1',
};
check(
  'a payment with all matching identities belongs to the request',
  paymentMatchesBookingRequest(
    matchingPayment,
    matchingRequest,
    'JRQ-1',
  ),
  true,
);
check(
  'a payment for another tenant is refused',
  paymentMatchesBookingRequest(
    { ...matchingPayment, studentId: 'student-2' },
    matchingRequest,
    'JRQ-1',
  ),
  false,
);
check(
  'a payment for another room is refused',
  paymentMatchesBookingRequest(
    { ...matchingPayment, roomId: 'room-2' },
    matchingRequest,
    'JRQ-1',
  ),
  false,
);
check(
  'a payment for another request is refused',
  paymentMatchesBookingRequest(
    { ...matchingPayment, requestId: 'JRQ-2' },
    matchingRequest,
    'JRQ-1',
  ),
  false,
);

// ---------------------------------------------------------------------------
section('whether a profile may still finish registration');

const incompleteStudent = {
  exists: true,
  registrationCompleted: false,
  isActive: true,
  roleClaimed: false,
  role: 'student',
};
check(
  'a trigger-created incomplete profile may finish registration',
  canCompleteRegistration(incompleteStudent),
  true,
);
check(
  'a profile which does not exist yet may finish registration',
  canCompleteRegistration({
    exists: false,
    registrationCompleted: null,
    isActive: null,
    roleClaimed: null,
    role: null,
  }),
  true,
);
check(
  'a completed owner may not claim a role again',
  canCompleteRegistration({
    ...incompleteStudent,
    registrationCompleted: true,
    role: 'owner',
    roleClaimed: true,
  }),
  false,
);
check(
  'an inactive incomplete profile may not finish registration',
  canCompleteRegistration({ ...incompleteStudent, isActive: false }),
  false,
);
check(
  'an incomplete profile without an activation marker may not be reactivated',
  canCompleteRegistration({ ...incompleteStudent, isActive: null }),
  false,
);
check(
  'a legacy profile without the marker may not claim a role again',
  canCompleteRegistration({
    ...incompleteStudent,
    registrationCompleted: null,
  }),
  false,
);
check(
  'an incomplete profile may claim its role once',
  canClaimRegistrationRole(incompleteStudent),
  true,
);
check(
  'an already claimed role may not be claimed again',
  canClaimRegistrationRole({
    ...incompleteStudent,
    role: 'owner',
    roleClaimed: true,
  }),
  false,
);
check(
  'a legacy owner role is treated as already claimed',
  canClaimRegistrationRole({
    ...incompleteStudent,
    role: 'owner',
    roleClaimed: false,
  }),
  false,
);
check(
  'the trigger default student role is not treated as claimed',
  hasClaimedRegistrationRole(incompleteStudent),
  false,
);
check(
  'a selected owner role is treated as claimed',
  hasClaimedRegistrationRole({
    ...incompleteStudent,
    role: 'owner',
    roleClaimed: true,
  }),
  true,
);
check(
  'a selected owner role is preserved when registration completes',
  resolveRegistrationRole(
    {
      ...incompleteStudent,
      role: 'owner',
      roleClaimed: true,
    },
    'student',
  ),
  'owner',
);
check(
  'an unclaimed registration may select the owner role',
  resolveRegistrationRole(incompleteStudent, 'owner'),
  'owner',
);
check(
  'a missing profile may select the owner role',
  resolveRegistrationRole(
    {
      exists: false,
      registrationCompleted: null,
      isActive: null,
      roleClaimed: null,
      role: null,
    },
    'owner',
  ),
  'owner',
);
check(
  'an invalid locked role is not silently overwritten',
  resolveRegistrationRole(
    {
      ...incompleteStudent,
      role: 'invalid',
      roleClaimed: true,
    },
    'student',
  ),
  null,
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
section('how a role change affects an existing booking');

check(
  'an unchanged role leaves an active booking alone',
  roleChangeRequestEffect('student', 'student', {
    status: 'adminReviewed',
  }),
  'keep',
);
check(
  'an active booking blocks a role change',
  roleChangeRequestEffect('student', 'owner', {
    status: 'adminReviewed',
  }),
  'block-active',
);
check(
  'a submitted payment blocks a role change',
  roleChangeRequestEffect('student', 'owner', {
    status: 'studentConfirmed',
    advancePaymentStatus: 'submitted',
  }),
  'block-payment',
);
check(
  'an open request is cancelled when the student is demoted',
  roleChangeRequestEffect('student', 'owner', {
    status: 'pending',
  }),
  'cancel',
);
check(
  'an open request is also cancelled when an owner becomes a student',
  roleChangeRequestEffect('owner', 'student', {
    status: 'ownerConfirmed',
  }),
  'cancel',
);
check(
  'a finished request is not changed by a role update',
  roleChangeRequestEffect('student', 'owner', {
    status: 'rejected',
  }),
  'keep',
);

// ---------------------------------------------------------------------------
section('the payment submission state machine');

const submission = {
  requestId: 'JRQ-1',
  studentId: 'student-1',
  ownerId: 'owner-1',
  roomId: 'room-1',
  monthlyRent: 1000,
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
  bookingStatusAfterRejectedPayment('admin_reviewed', true),
  'studentConfirmed',
);
check(
  'a rejected payment does not resurrect a cancelled booking',
  bookingStatusAfterRejectedPayment('cancelled'),
  null,
);
check(
  'a rejected payment does not resurrect a declined booking',
  bookingStatusAfterRejectedPayment('rejected'),
  null,
);
check(
  'a rejected payment does not change an unknown booking state',
  bookingStatusAfterRejectedPayment('unknown'),
  null,
);
check(
  'a mismatched payment cannot rewrite a payable request',
  rejectedPaymentBookingStatus('studentConfirmed', false, false),
  null,
);
check(
  'a matching payment restores a payable request',
  rejectedPaymentBookingStatus('studentConfirmed', false, true),
  'studentConfirmed',
);
check(
  'a matching payment rolls back an active legacy request',
  rejectedPaymentBookingStatus('adminReviewed', true, true),
  'studentConfirmed',
);

// ---------------------------------------------------------------------------
section('the platform fee configuration');

check('a valid configured fee is accepted', parsePlatformFeePercentage('12.5'), 12.5);
check('a zero configured fee is accepted', parsePlatformFeePercentage('0'), 0);
check('a hundred percent configured fee is accepted', parsePlatformFeePercentage('100'), 100);
check('an empty configured fee uses the default', parsePlatformFeePercentage(''), 30);
check('a non-numeric configured fee uses the default', parsePlatformFeePercentage('NaN'), 30);
check('a negative configured fee uses the default', parsePlatformFeePercentage('-1'), 30);
check('a fee above 100 percent uses the default', parsePlatformFeePercentage('101'), 30);
check(
  'the agreed request terms are preserved',
  resolveAgreedTermsFromData(
    {
      commissionPercentageAtJoin: 18,
      platformFeePayer: 'student',
    },
    { commissionPercentage: 30, feePayer: 'owner' },
  ),
  { percentage: 18, payer: 'student' },
);
check(
  'a legacy request uses the settings snapshot',
  resolveAgreedTermsFromData(
    {},
    { commissionPercentage: 25, feePayer: 'student' },
  ),
  { percentage: 25, payer: 'student' },
);
check(
  'malformed settings fall back to safe defaults',
  resolveAgreedTermsFromData(
    { commissionPercentageAtJoin: 'invalid', platformFeePayer: 'invalid' },
    { commissionPercentage: 101, feePayer: 'invalid' },
  ),
  { percentage: 30, payer: 'owner' },
);

// ---------------------------------------------------------------------------
section('the App Check enforcement switch');

check(
  'App Check is disabled when the switch is missing',
  appCheckEnforcementRequested(undefined),
  false,
);
check(
  'App Check is disabled for an unknown switch value',
  appCheckEnforcementRequested('sometimes'),
  false,
);
check(
  'App Check is enabled by the true value',
  appCheckEnforcementRequested('true'),
  true,
);
check(
  'App Check is enabled by an upper-case true value',
  appCheckEnforcementRequested(' TRUE '),
  true,
);
check(
  'App Check is enabled by the numeric value',
  appCheckEnforcementRequested('1'),
  true,
);

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed checks:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}
