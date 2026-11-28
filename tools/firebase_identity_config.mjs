#!/usr/bin/env node

// Repairs and checks the **sign-in configuration** of the Identity Platform.
//
// A `PATCH` of the configuration of the project replaces the parts which the
// update mask names. A mask which does not name every part of `signIn`
// takes the providers with it, and the phone sign-in answers
// `operation-not-allowed` afterwards ("Phone sign-in is not enabled for this
// app yet"). The same happened to the authorized domains, which is what lets
// the browser sign in on the domain of the app.
//
// This tool writes the whole configuration **in one request** with a mask
// which names every part, and it reads the configuration back afterwards —
// the answer of the API is not proof.
//
// Check only (default):
//   node tools/firebase_identity_config.mjs
//
// Repair:
//   node tools/firebase_identity_config.mjs --apply

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const firebaseToolsAuth = require('firebase-tools/lib/auth');

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  'myfirstapp-fa30f52b';
const IDENTITY_API = 'https://identitytoolkit.googleapis.com/v2';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The numbers which sign in without a SIM. */
const TEST_PHONE_NUMBERS = {
  '+16505550100': '123456',
  '+16505550101': '123456',
  '+16505550102': '123456',
  '+16505550103': '123456',
  '+16505550104': '123456',
};

/**
 * The domains which may sign in.
 *
 * The two addresses of the default Hosting site and the two custom domains
 * of the product. `localhost` is needed by the local development.
 */
const AUTHORIZED_DOMAINS = [
  'localhost',
  'myfirstapp-fa30f52b.firebaseapp.com',
  'myfirstapp-fa30f52b.web.app',
  'stayserve.co.in',
  'www.stayserve.co.in',
];

function fail(message) {
  throw new Error(message);
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

/** Everything which has to be in place, with the value it has to have. */
function wanted(config) {
  const signIn = config?.signIn ?? {};
  return [
    {
      name: 'the email provider is enabled',
      ok: signIn.email?.enabled === true,
      actual: String(signIn.email?.enabled ?? 'missing'),
    },
    {
      name: 'the password of the email provider is required',
      ok: signIn.email?.passwordRequired === true,
      actual: String(signIn.email?.passwordRequired ?? 'missing'),
    },
    {
      name: 'the phone provider is enabled',
      ok: signIn.phoneNumber?.enabled === true,
      actual: String(signIn.phoneNumber?.enabled ?? 'missing'),
    },
    {
      name: 'the test phone numbers are stored',
      ok:
        Object.keys(signIn.phoneNumber?.testPhoneNumbers ?? {}).length ===
        Object.keys(TEST_PHONE_NUMBERS).length,
      actual: Object.keys(signIn.phoneNumber?.testPhoneNumbers ?? {}).join(', ') ||
        'missing',
    },
    {
      name: 'the hash configuration is kept',
      ok: Boolean(signIn.hashConfig?.signerKey),
      actual: signIn.hashConfig?.signerKey ? 'present' : 'missing',
    },
    {
      name: 'the authorized domains are stored',
      ok:
        (config?.authorizedDomains ?? []).length ===
        AUTHORIZED_DOMAINS.length,
      actual: (config?.authorizedDomains ?? []).join(', ') || 'missing',
    },
    {
      name: 'the bot protection of the phone provider is off',
      ok: config?.recaptchaConfig?.phoneEnforcementState === 'OFF',
      actual: String(
        config?.recaptchaConfig?.phoneEnforcementState ?? 'missing',
      ),
    },
    {
      name: 'the bot protection of the email provider is off',
      ok:
        config?.recaptchaConfig?.emailPasswordEnforcementState === 'OFF',
      actual: String(
        config?.recaptchaConfig?.emailPasswordEnforcementState ?? 'missing',
      ),
    },
  ];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const json = { 'Content-Type': 'application/json' };

  console.log(`--- the sign-in configuration of ${PROJECT_ID} ---`);

  const current = await request(`${IDENTITY_API}/projects/${PROJECT_ID}/config`, {
    headers: auth,
  });
  if (current.status !== 200) {
    fail(
      `The config could not be read (HTTP ${current.status}): ` +
        JSON.stringify(current.body).slice(0, 300),
    );
  }

  const problems = wanted(current.body).filter((entry) => !entry.ok);
  for (const entry of wanted(current.body)) {
    console.log(
      `  ${entry.ok ? 'ok  ' : 'WRONG'} ${entry.name}: ${entry.actual}`,
    );
  }

  if (problems.length === 0) {
    console.log('PASS  the sign-in configuration is complete.');
    return;
  }

  if (!apply) {
    console.log(
      `FAIL  ${problems.length} part(s) are missing or wrong. Run the tool ` +
        'again with --apply.',
    );
    process.exitCode = 1;
    return;
  }

  const signIn = current.body?.signIn ?? {};
  const recaptcha = current.body?.recaptchaConfig ?? {};

  const body = {
    signIn: {
      email: { enabled: true, passwordRequired: true },
      phoneNumber: {
        enabled: true,
        testPhoneNumbers: TEST_PHONE_NUMBERS,
      },
      anonymous: { enabled: false },
      hashConfig: signIn.hashConfig,
    },
    authorizedDomains: AUTHORIZED_DOMAINS,
    recaptchaConfig: {
      emailPasswordEnforcementState:
        recaptcha.emailPasswordEnforcementState ?? 'OFF',
      phoneEnforcementState: recaptcha.phoneEnforcementState ?? 'OFF',
      useSmsBotScore: recaptcha.useSmsBotScore === true,
      useSmsTollFraudProtection: recaptcha.useSmsTollFraudProtection === true,
    },
  };

  // The mask names **every** part which is written. A mask which leaves one
  // out takes the other providers with it.
  const updateMask = [
    'sign_in.email',
    'sign_in.phone_number',
    'sign_in.anonymous',
    'sign_in.hash_config',
    'authorized_domains',
    'recaptcha_config',
  ];

  console.log('--- the change ---');
  console.log(
    `the phone provider: enabled, ${Object.keys(TEST_PHONE_NUMBERS).length} test numbers`,
  );
  console.log(`the authorized domains: ${AUTHORIZED_DOMAINS.join(', ')}`);

  const patched = await request(
    `${IDENTITY_API}/projects/${PROJECT_ID}/config?updateMask=${updateMask
      .map((field) => encodeURIComponent(field))
      .join(',')}`,
    {
      method: 'PATCH',
      headers: { ...auth, ...json },
      body: JSON.stringify(body),
    },
  );
  if (patched.status !== 200) {
    fail(
      `The config could not be written (HTTP ${patched.status}): ` +
        JSON.stringify(patched.body).slice(0, 400),
    );
  }

  // Read the configuration again: the answer of the patch is not proof.
  const after = await request(`${IDENTITY_API}/projects/${PROJECT_ID}/config`, {
    headers: auth,
  });
  console.log('--- the result ---');
  const remaining = wanted(after.body).filter((entry) => !entry.ok);
  for (const entry of wanted(after.body)) {
    console.log(
      `  ${entry.ok ? 'ok  ' : 'WRONG'} ${entry.name}: ${entry.actual}`,
    );
  }
  if (remaining.length !== 0) {
    fail(
      `${remaining.length} part(s) are still missing: ` +
        remaining.map((entry) => entry.name).join(', '),
    );
  }
  console.log('PASS  the sign-in configuration is complete.');
}

main().catch((error) => {
  console.error(`ERROR  ${error.message}`);
  process.exitCode = 1;
});
