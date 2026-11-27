// Focused tests for the pure account-deletion safety predicates.
//
//   npm run build
//   node test/account_deletion_safety_unit_test.mjs
//
// The helpers are loaded from the compiled output, so these checks run
// against exactly the code that is deployed.
//
// The regression they protect: a booking request which was **cancelled**
// after its payment had already been settled used to block the deletion of
// the account forever. The admin panel then showed the account as "blocked"
// although nothing live was left to protect, and the deleted account kept
// appearing in the user list.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const {
  paymentAlreadyMade,
  paymentBlocksAccountDeletion,
  requestBlocksAccountDeletion,
} = require(path.join(HERE, '..', 'lib', 'bookingAccess.js'));

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

console.log('\n=== a live booking still blocks the deletion ===');
check(
  'an active booking blocks the deletion',
  requestBlocksAccountDeletion({ status: 'adminReviewed' }),
  true,
);
check(
  'the legacy spelling of an active booking blocks the deletion',
  requestBlocksAccountDeletion({ status: 'admin_reviewed' }),
  true,
);
check(
  'an active booking blocks the deletion even without payment fields',
  requestBlocksAccountDeletion({
    status: 'adminReviewed',
    advancePaid: false,
    platformCutTaken: false,
  }),
  true,
);

console.log('\n=== a cancelled booking with a settled payment is history ===');
check(
  'a cancelled request with a verified advance does not block the deletion',
  requestBlocksAccountDeletion({
    status: 'cancelled',
    advancePaid: true,
    platformCutTaken: true,
    advancePaymentStatus: 'verified',
  }),
  false,
);
check(
  'a cancelled request with a rejected payment does not block the deletion',
  requestBlocksAccountDeletion({
    status: 'cancelled',
    advancePaid: false,
    platformCutTaken: false,
    advancePaymentStatus: 'rejected',
  }),
  false,
);
check(
  'a declined request with a settled payment does not block the deletion',
  requestBlocksAccountDeletion({
    status: 'rejected',
    advancePaid: true,
    platformCutTaken: true,
    advancePaymentStatus: 'verified',
  }),
  false,
);
check(
  'a cancelled request without any payment does not block the deletion',
  requestBlocksAccountDeletion({ status: 'cancelled' }),
  false,
);

console.log('\n=== a payment which still waits for its settlement blocks ===');
check(
  'a cancelled request with a submitted payment blocks the deletion',
  requestBlocksAccountDeletion({
    status: 'cancelled',
    advancePaid: false,
    platformCutTaken: false,
    advancePaymentStatus: 'submitted',
  }),
  true,
);
check(
  'an open request with a submitted payment blocks the deletion',
  requestBlocksAccountDeletion({
    status: 'ownerConfirmed',
    advancePaid: false,
    platformCutTaken: false,
    advancePaymentStatus: 'submitted',
  }),
  true,
);
check(
  'an open request with a verified payment blocks the deletion',
  requestBlocksAccountDeletion({
    status: 'studentConfirmed',
    advancePaid: true,
    platformCutTaken: true,
    advancePaymentStatus: 'verified',
  }),
  true,
);
check(
  'an open request without payment activity does not block the deletion',
  requestBlocksAccountDeletion({ status: 'pending' }),
  false,
);

console.log('\n=== the payment record ===');
check(
  'a submitted payment blocks the deletion',
  paymentBlocksAccountDeletion({ status: 'submitted' }),
  true,
);
check(
  'a verified payment is settled and does not block the deletion',
  paymentBlocksAccountDeletion({ status: 'verified' }),
  false,
);
check(
  'a rejected payment does not block the deletion',
  paymentBlocksAccountDeletion({ status: 'rejected' }),
  false,
);
check(
  'a payment without a status does not block the deletion',
  paymentBlocksAccountDeletion({}),
  false,
);

console.log('\n=== the unchanged payment helper ===');
check(
  'a settled advance still counts as a payment which was made',
  paymentAlreadyMade({
    advancePaid: true,
    platformCutTaken: true,
    advancePaymentStatus: 'verified',
  }),
  true,
);
check(
  'a request without payment activity does not count',
  paymentAlreadyMade({ status: 'cancelled' }),
  false,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed checks:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
