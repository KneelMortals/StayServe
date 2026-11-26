import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appCheckHeaders,
  assertAppCheckConfigured,
} from './app_check.mjs';

test('live callable headers preserve the caller headers', () => {
  const headers = appCheckHeaders(
    {
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    },
    '',
  );
  assert.equal(headers.Authorization, 'Bearer token');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['X-Firebase-AppCheck'], undefined);
});

test('live callable headers carry the configured App Check token', () => {
  const headers = appCheckHeaders(
    { Authorization: 'Bearer token' },
    'app-check-token',
  );
  assert.equal(headers.Authorization, 'Bearer token');
  assert.equal(headers['X-Firebase-AppCheck'], 'app-check-token');
});

test('required App Check fails before a probe can create data', () => {
  assert.throws(
    () => assertAppCheckConfigured('', true),
    /STAYSERVE_APP_CHECK_TOKEN is missing/,
  );
  assert.doesNotThrow(() => assertAppCheckConfigured('token', true));
  assert.doesNotThrow(() => assertAppCheckConfigured('', false));
});
