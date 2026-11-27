#!/usr/bin/env node

// Reads and verifies the **Firebase phone provider** configuration of the
// project: the test phone numbers and the authorized domains.
//
// The app has two independent phone flows:
//
//   1. the **server-owned** OTP of the app (`sendOtp` / `verifyOtp`), which
//      is exercised by `tools/otp_mobile_e2e.mjs`;
//   2. the **Firebase Auth** phone provider, which the phone sign-up screen
//      uses. It is only usable on a real device with a real SIM unless the
//      project carries test phone numbers.
//
// The test phone numbers make the second flow testable without a SIM and
// without a fee: Firebase accepts the configured code for the number
// without sending a message.
//
// Check only (default):
//   node tools/firebase_phone_test_numbers.mjs
//
// Prove that a test number can really sign in (creates a disposable account
// and deletes it again):
//   node tools/firebase_phone_test_numbers.mjs --probe [+16505550100]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const firebaseToolsAuth = require('firebase-tools/lib/auth');

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  'myfirstapp-fa30f52b';
const IDENTITY_API = 'https://identitytoolkit.googleapis.com/v2';
const IDENTITY_V1 = 'https://identitytoolkit.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

function fail(message) {
  throw new Error(message);
}

/** The web API key of the app; the public key of the project. */
function webApiKey() {
  const file = path.resolve('lib/firebase/firebase_config.dart');
  if (!fs.existsSync(file)) {
    fail(`The Firebase options are missing: ${file} was not found.`);
  }
  const source = fs.readFileSync(file, 'utf8');
  // The web key is the one which is not bound to a package name or a bundle
  // id. The Android and iOS keys are restricted, so a plain HTTP call with
  // them is refused with "unregistered callers".
  const web = source.match(/static const FirebaseOptions web[\s\S]*?apiKey:\s*'([^']+)'/);
  if (web) return web[1];
  const match = source.match(/apiKey:\s*'([^']+)'/);
  if (!match) fail('No apiKey was found in lib/firebase/firebase_config.dart.');
  return match[1];
}

async function accessToken() {
  const account = firebaseToolsAuth.getGlobalDefaultAccount();
  if (!account?.tokens?.refresh_token) {
    fail('No Firebase CLI refresh token. Run firebase login first.');
  }
  const token = await firebaseToolsAuth.getAccessToken(
    account.tokens.refresh_token,
    [SCOPE],
  );
  if (!token?.access_token) {
    fail('Could not refresh the Firebase CLI access token.');
  }
  return token.access_token;
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  return { status: response.status, body };
}

async function main() {
  const probeIndex = process.argv.indexOf('--probe');
  const probe = probeIndex !== -1;

  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const json = { 'Content-Type': 'application/json' };

  console.log(`--- the phone provider of ${PROJECT_ID} ---`);
  const config = await request(`${IDENTITY_API}/projects/${PROJECT_ID}/config`, {
    headers: auth,
  });
  if (config.status !== 200) {
    fail(
      `The Identity Platform config could not be read (HTTP ${config.status}): ` +
        JSON.stringify(config.body).slice(0, 300),
    );
  }

  const phone = config.body.signIn?.phoneNumber || {};
  const testNumbers = phone.testPhoneNumbers || {};
  console.log('  the phone provider is enabled:', phone.enabled === true);
  console.log('  the test phone numbers:');
  for (const [number, code] of Object.entries(testNumbers)) {
    console.log(`    ${number} -> ${code}`);
  }
  if (Object.keys(testNumbers).length === 0) {
    console.log('  (none — the phone sign-in needs a real SIM)');
  }

  console.log('\n--- the authorized domains ---');
  for (const domain of config.body.authorizedDomains || []) {
    console.log(`    ${domain}`);
  }

  if (!probe) {
    console.log(
      '\nUse --probe to prove that a test number can sign in without a SIM.',
    );
    return;
  }

  const number =
    process.argv[probeIndex + 1] || Object.keys(testNumbers)[0] || '+16505550100';
  const code = testNumbers[number];
  if (!code) {
    fail(`${number} is not a configured test phone number.`);
  }

  const apiKey = webApiKey();
  const client = { 'Content-Type': 'application/json' };
  // The API key travels as a query parameter, exactly like the Firebase JS
  // SDK sends it.
  const withKey = (method) => `${IDENTITY_V1}/${method}?key=${apiKey}`;

  console.log(`\n--- the probe with ${number} ---`);
  const sent = await request(withKey('accounts:sendVerificationCode'), {
    method: 'POST',
    headers: client,
    body: JSON.stringify({
      sessionInfo: {
        applicationName: PROJECT_ID,
        apiKey,
        recaptchaAction: 'login',
        recaptchaToken: 'ignored-for-a-test-number',
      },
      phoneNumber: number,
    }),
  });
  console.log('  the code was requested:', sent.status);
  if (sent.status !== 200) {
    fail(
      `The code could not be requested (HTTP ${sent.status}): ` +
        JSON.stringify(sent.body).slice(0, 300),
    );
  }

  const signedIn = await request(withKey('accounts:signInWithPhoneNumber'), {
    method: 'POST',
    headers: client,
    body: JSON.stringify({
      sessionInfo: sent.body.sessionInfo,
      phoneNumber: number,
      code,
    }),
  });
  console.log('  the sign-in:', signedIn.status);
  if (signedIn.status !== 200) {
    fail(
      `The sign-in failed (HTTP ${signedIn.status}): ` +
        JSON.stringify(signedIn.body).slice(0, 300),
    );
  }

  const uid = signedIn.body.localId;
  console.log('  the account:', uid);
  console.log('  the phone of the account:', signedIn.body.phoneNumber);

  const deleted = await request(
    `${IDENTITY_V1}/projects/${PROJECT_ID}/accounts:delete`,
    {
      method: 'POST',
      headers: { ...auth, ...json },
      body: JSON.stringify({ localId: uid }),
    },
  );
  console.log(
    '  the disposable account was removed:',
    deleted.status === 200 ? 'yes' : `no (HTTP ${deleted.status})`,
  );
  if (deleted.status !== 200) {
    console.log(
      '  remove it manually:',
      JSON.stringify(deleted.body).slice(0, 300),
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('ERROR:', error.message);
  process.exit(2);
});
