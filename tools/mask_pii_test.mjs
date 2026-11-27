// Tests for the masking of personally identifiable information.
//
// The live probes print their diagnostics to a terminal and into CI logs. A
// phone number, a Firebase API key or an identity token must never end up in
// one of those logs, so every diagnostic message is passed through the
// helpers of `mask_pii.mjs` before it is printed.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  maskPhoneNumber,
  maskPhoneNumbersInText,
  maskSensitiveText,
  safeErrorText,
} from './mask_pii.mjs';

test('a phone number keeps only its last two digits', () => {
  // `+919876543210` has twelve digits, so ten of them are replaced.
  assert.equal(maskPhoneNumber('+919876543210'), '**********10');
  // `+15555550100` has eleven digits.
  assert.equal(maskPhoneNumber('+15555550100'), '*********00');
  assert.equal(maskPhoneNumber(''), '');
  assert.equal(maskPhoneNumber(null), '');

  // A short value is masked completely: there is no safe remainder.
  assert.equal(maskPhoneNumber('+12'), '**');
});

test('every phone number inside a text is masked', () => {
  const masked = maskPhoneNumbersInText(
    'the owner +91 98765 43210 and the student +919876543211 failed',
  );
  assert.ok(!masked.includes('98765'));
  assert.ok(!masked.includes('9876543211'));
  // The last two digits survive, so the operator can still tell the two
  // numbers apart.
  assert.ok(masked.includes('10'));
  assert.ok(masked.includes('11'));
});

test('the Firebase key and the identity token are masked', () => {
  const masked = maskSensitiveText(
    'key=AIzaSyD-ExampleKey1234567890 token=eyJhbGciOiJIUzI1NiJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123signature',
  );
  assert.ok(!masked.includes('AIzaSyD-ExampleKey1234567890'));
  assert.ok(!masked.includes('eyJzdWIiOiIxMjM0NTY3ODkwIn0'));
  assert.ok(masked.includes('AIza***'));
});

test('a phone number is masked even when it follows an API key', () => {
  const masked = maskSensitiveText(
    'AIzaSyD-ExampleKey1234567890 rejected +919876543210',
  );
  assert.ok(!masked.includes('AIzaSyD-ExampleKey1234567890'));
  assert.ok(!masked.includes('9876543210'));
});

test('the safe text of an error never carries the raw message', () => {
  const error = new Error(
    'The request for +919876543210 with key AIzaSyD-ExampleKey1234567890 failed',
  );
  const safe = safeErrorText(error);
  assert.ok(!safe.includes('9876543210'));
  assert.ok(!safe.includes('AIzaSyD-ExampleKey1234567890'));
  assert.ok(safe.includes('failed'));

  // A plain string and an unknown value are handled as well.
  assert.equal(safeErrorText('+919876543210'), '**********10');
  assert.equal(safeErrorText(null), 'Unknown error');
});

test('the safe text of an error never carries the stack', () => {
  const error = new Error('boom');
  error.stack = 'Error: boom\n    at +919876543210';
  const safe = safeErrorText(error);
  assert.ok(!safe.includes('at +919876543210'));
});
