// Focused tests for the pure owner listing-availability rules.
//
//   npm run build
//   node test/rooms_unit_test.mjs
//
// The helper is loaded from the compiled output, so these checks run against
// exactly the code that is deployed.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const {
  decideRoomListingAvailability,
  decideRoomDeletion,
  storageObjectPathFromDownloadUrl,
} = require(path.join(HERE, '..', 'lib', 'rooms.js'));

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

console.log('\n=== owner listing availability ===');

check(
  'an empty room may be marked occupied',
  decideRoomListingAvailability(true, 1, 0),
  { allowed: true, status: 'occupied' },
);
check(
  'an empty room may be marked available',
  decideRoomListingAvailability(false, 1, 0),
  { allowed: true, status: 'available' },
);
check(
  'a room with a free slot may be taken off the market',
  decideRoomListingAvailability(true, 2, 1),
  { allowed: true, status: 'occupied' },
);
check(
  'a full room may not be marked occupied by the owner',
  decideRoomListingAvailability(true, 1, 1),
  { allowed: false, reason: 'already-full' },
);
check(
  'a room with an occupant may not be marked available by the owner',
  decideRoomListingAvailability(false, 2, 1),
  { allowed: false, reason: 'has-occupants' },
);
check(
  'an invalid capacity is refused',
  decideRoomListingAvailability(true, 0, 0),
  { allowed: false, reason: 'invalid-capacity' },
);
check(
  'a negative occupancy is refused',
  decideRoomListingAvailability(false, 2, -1),
  { allowed: false, reason: 'invalid-occupancy' },
);
check(
  'an occupancy above the capacity is refused',
  decideRoomListingAvailability(false, 2, 3),
  { allowed: false, reason: 'invalid-occupancy' },
);

console.log('\n=== safe room deletion ===');

check(
  'an empty room without requests may be deleted',
  decideRoomDeletion(0, []),
  { allowed: true },
);
check(
  'an empty room with a pending request may be deleted',
  decideRoomDeletion(0, [{ status: 'pending' }]),
  { allowed: true },
);
check(
  'a room with an occupant may not be deleted',
  decideRoomDeletion(1, []),
  { allowed: false, reason: 'has-occupants' },
);
check(
  'a room with an active booking may not be deleted',
  decideRoomDeletion(0, [{ status: 'adminReviewed' }]),
  { allowed: false, reason: 'active-booking' },
);
check(
  'a legacy active booking may not be deleted',
  decideRoomDeletion(0, [{ status: 'admin_reviewed' }]),
  { allowed: false, reason: 'active-booking' },
);
check(
  'a room with a submitted payment may not be deleted',
  decideRoomDeletion(0, [{ status: 'studentConfirmed', advancePaymentStatus: 'submitted' }]),
  { allowed: false, reason: 'payment-in-progress' },
);
check(
  'a room with a paid legacy request may not be deleted',
  decideRoomDeletion(0, [{ status: 'studentConfirmed', advancePaid: true }]),
  { allowed: false, reason: 'payment-in-progress' },
);
check(
  'an invalid occupancy is refused',
  decideRoomDeletion(Number.NaN, []),
  { allowed: false, reason: 'invalid-occupancy' },
);

console.log('\n=== room-photo Storage cleanup paths ===');

check(
  'a Firebase Storage download URL yields its object path',
  storageObjectPathFromDownloadUrl(
    'https://firebasestorage.googleapis.com/v0/b/stayserve.appspot.com/o/rooms%2Fowner-1%2FRM-1%2Fphoto.jpg?alt=media&token=abc',
  ),
  'rooms/owner-1/RM-1/photo.jpg',
);
check(
  'a legacy Storage download URL yields its object path',
  storageObjectPathFromDownloadUrl(
    'https://storage.googleapis.com/stayserve.appspot.com/rooms/owner-1/RM-1/photo.jpg',
  ),
  'rooms/owner-1/RM-1/photo.jpg',
);
check(
  'an unrelated URL is not treated as a Storage object',
  storageObjectPathFromDownloadUrl('https://example.com/photo.jpg'),
  null,
);
check(
  'a malformed URL is not treated as a Storage object',
  storageObjectPathFromDownloadUrl('not a url'),
  null,
);
check(
  'a missing URL is not treated as a Storage object',
  storageObjectPathFromDownloadUrl(null),
  null,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed checks:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
