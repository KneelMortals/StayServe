// Checks that the **built** app really contains the fixes.
//
// A string of the Dart code ends up in the binary either as ASCII (one-byte
// string) or as UTF-16 (when it contains a character that does not fit into
// a byte — an em-dash for example). A search that only looks for ASCII
// gives a false "missing" for the second kind.
//
//   node tools/verify_build.mjs <path-to-libapp.so>

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APK =
  process.argv[2] ||
  '/Users/shauryaprataprai/Desktop/stayserve/build/app/outputs/flutter-apk/app-release.apk';

const dir = mkdtempSync(join(tmpdir(), 'stayserve-verify-'));
execFileSync('unzip', ['-q', '-o', APK, 'lib/arm64-v8a/libapp.so', '-d', dir]);
const data = readFileSync(join(dir, 'lib/arm64-v8a/libapp.so'));
rmSync(dir, { recursive: true, force: true });

function contains(text) {
  return (
    data.indexOf(Buffer.from(text, 'utf8')) >= 0 ||
    data.indexOf(Buffer.from(text, 'utf16le')) >= 0
  );
}

const checks = [
  // --- the three new features -----------------------------------------
  ['feature: the reviews of a room', 'Write a review'],
  ['feature: the button that opens the visit sheet', 'Visit the room'],
  ['feature: the visit button of a request', 'Visit room'],
  ['feature: the title of the visit sheet', 'Where the room is'],
  ['feature: the maps button of the visit sheet', 'Open in Google Maps'],
  ['feature: the maps app button of the visit sheet', 'Open in the maps app'],
  ['feature: the copy button of the visit sheet', 'Copy the address'],
  ['feature: the cancel button of the owner', 'Cancel booking'],
  ['feature: the cancel button of the student', 'Cancel request'],
  ['feature: the cancelled notice', 'Booking cancelled'],

  // --- the bugs the button audit found ---------------------------------
  ['fix: the commission slider saves the dragged value', 'Save Commission Settings'],
  ['fix: the splash screen reports a broken update link', 'Could not open the update link. Please update StayServe from the Play Store.'],
  ['fix: the search screen reports a failed location lookup', 'Could not get your location \u2014 check the location permission and try again'],
  ['fix: the owner dashboard shows the waiting label', 'Awaiting Payment'],
  ['fix: the owner dashboard shows the pending label', 'Pending Requests'],

  // --- the system back button ------------------------------------------
  // The guard of the app: the back button leaves the area through the
  // dashboard and asks before it closes the app.
  ['fix: the back button asks before it closes the app', 'Press back again to leave StayServe'],

  // --- the log out ------------------------------------------------------
  ['fix: the log out explains itself when it fails', 'Could not sign out'],

  // --- the UPI intent ---------------------------------------------------
  // The payee address is written the canonical way — `name@bank` and not
  // `name%40bank`. Several UPI apps read the query by hand and refused
  // the encoded address with a message about the limit.
  ['fix: the UPI intent writes the address without encoding it', 'upi://pay?'],

  // --- the admin dashboard ----------------------------------------------
  ['fix: the admin dashboard shows the headline figures', 'At a glance'],
  ['fix: the admin dashboard shows the recent activity', 'Recent activity'],
  ['fix: the admin dashboard shows the open work', 'Open work'],

  // --- the booking button -----------------------------------------------
  ['fix: the booking button turns into a cancel button', 'Cancel booking'],
  ['fix: the booking explains a request that already exists', 'You have already requested this room'],
  ['fix: the booking can be walked away from', 'Cancel booking?'],

  // --- the shared parts of the app -------------------------------------
  ['app: the platform fee', 'platform fee'],
  ['app: the payee of the platform', 'shauryaprataprai461-2@oksbi'],
  ['app: the name of the platform', 'StayServe'],
];

// Strings that must **not** be in the binary.
//
// The encoded payee address is the one: several UPI apps read the query of
// the intent by hand instead of decoding it. They then see an address they
// do not recognise and refuse the payment with a message that has nothing
// to do with the real reason ("the amount exceeds the limit").
const forbidden = [
  [
    'fix: the UPI intent does not encode the payee address',
    'pa=shauryaprataprai461-2%40oksbi',
  ],
];

let pass = 0;
let fail = 0;

console.log(`=== ${APK} ===`);
console.log(`    ${(data.length / 1024 / 1024).toFixed(1)} MB of arm64 code\n`);

for (const [label, text] of checks) {
  const ok = contains(text);
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}  (${JSON.stringify(text.slice(0, 50))})`);
  }
}

for (const [label, text] of forbidden) {
  const present = contains(text);
  if (!present) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}  (${JSON.stringify(text.slice(0, 50))})`);
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
