// Focused tests for the pure room-location privacy helpers.
//
//   npm run build
//   node test/room_location_unit_test.mjs
//
// The helpers are loaded from the compiled output, so these checks run
// against exactly the code that is deployed.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const {
  coarseRoomCoordinate,
  hasCompleteExactRoomLocation,
  roomGeoCell,
  roomLocationStage,
} = require(path.join(HERE, '..', 'lib', 'roomLocation.js'));

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

console.log('\n=== room-location stage parsing ===');
check('an empty stage uses the safe dual default', roomLocationStage(''), 'dual');
check('the dual stage is accepted', roomLocationStage('dual'), 'dual');
check('the private stage is accepted', roomLocationStage('private'), 'private');
check(
  'stage parsing ignores harmless surrounding whitespace and case',
  roomLocationStage(' PRIVATE '),
  'private',
);

let invalidStageRejected = false;
try {
  roomLocationStage('garbage');
} catch (error) {
  invalidStageRejected = String(error?.message || '').includes(
    'Expected "dual" or "private"',
  );
}
check('an invalid stage fails closed', invalidStageRejected, true);

console.log('\n=== canonical public coordinate rounding ===');
check('a positive half-cent rounds away from zero', coarseRoomCoordinate(1.005), 1.01);
check('a negative half-cent rounds away from zero', coarseRoomCoordinate(-12.975), -12.98);
check('an ordinary coordinate is rounded down', coarseRoomCoordinate(12.9716), 12.97);
check('an ordinary negative coordinate is rounded down', coarseRoomCoordinate(-12.9716), -12.97);
check('negative zero is normalized', coarseRoomCoordinate(-0.001), 0);
check(
  'the public geo cell uses the same tie rule',
  roomGeoCell({ latitude: 1.005, longitude: -12.975 }),
  '1.01,-12.98',
);

console.log('\n=== exact location completeness ===');
check(
  'a complete location with a coordinate pair is accepted',
  hasCompleteExactRoomLocation({
    address: '42 Exact Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: 77.5946,
  }),
  true,
);
check(
  'a complete location without coordinates is accepted',
  hasCompleteExactRoomLocation({
    address: '42 Exact Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: null,
    longitude: null,
  }),
  true,
);
check(
  'a half coordinate pair is rejected',
  hasCompleteExactRoomLocation({
    address: '42 Exact Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: null,
  }),
  false,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed checks:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
