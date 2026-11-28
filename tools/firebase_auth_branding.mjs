#!/usr/bin/env node

// Reports where the name of a message of **Firebase Auth** comes from.
//
// The phone code which the app receives is built by Firebase Auth from its
// own template:
//
//   %LOGIN_CODE% is your verification code for %APP_NAME%.
//
// Google marks that template as **read only** (`"readOnly": true` in the
// discovery document of the Identity Toolkit API) and the console offers no
// editor for it, so the wording cannot be chosen here. What can be seen is
// the value which fills `%APP_NAME%`:
//
//   * an Android app which is installed **from Google Play** gets the name
//     of the Play listing;
//   * every other case (a sideloaded build, the web build without a custom
//     domain) gets the name of the default Hosting site of the project,
//     which is usually the project id.
//
// This tool prints the state of both, so the reason of a message which
// carries the technical name of the project is visible.
//
//   node tools/firebase_auth_branding.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const firebaseToolsAuth = require('firebase-tools/lib/auth');

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  'myfirstapp-fa30f52b';
const IDENTITY_API = 'https://identitytoolkit.googleapis.com/v2';
const ADMIN_API = 'https://identitytoolkit.googleapis.com/admin/v2';
const FIREBASE_API = 'https://firebase.googleapis.com/v1beta1';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

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

/** The wording of the messages which StayServe sends by itself. */
function serverMessages() {
  const file = path.resolve('functions/src/otp.ts');
  if (!fs.existsSync(file)) return [];
  const source = fs.readFileSync(file, 'utf8');
  const found = [];
  const email = source.match(
    /const subject = '([^']*verification[^']*)'[\s\S]{0,200}?const body = `([^`]+)`/,
  );
  if (email) found.push({ channel: 'email', subject: email[1], body: email[2] });
  const mobile = source.match(
    /async function sendMobile[\s\S]{0,1200}?const body = `([^`]+)`/,
  );
  if (mobile) found.push({ channel: 'mobile', body: mobile[1] });
  return found;
}

async function main() {
  const token = await accessToken();
  const auth = { Authorization: `Bearer ${token}` };

  console.log(`--- the messages of Firebase Auth in ${PROJECT_ID} ---`);

  const config = await request(`${ADMIN_API}/projects/${PROJECT_ID}/config`, {
    headers: auth,
  });
  if (config.status !== 200) {
    fail(
      `The Identity Platform config could not be read (HTTP ${config.status}): ` +
        JSON.stringify(config.body).slice(0, 300),
    );
  }

  const sms = config.body?.notification?.sendSms?.smsTemplate?.content ?? '';
  console.log(`the template of the phone code: ${sms || '(empty)'}`);
  console.log(
    'the template is read only in the API of Google: the wording of the ' +
      'code cannot be chosen.',
  );

  const hostingSite = String(config.body?.defaultHostingSite || '').trim();
  console.log(`the name of the default Hosting site: ${hostingSite}`);

  const project = await request(`${FIREBASE_API}/projects/${PROJECT_ID}`, {
    headers: auth,
  });
  const displayName = String(project.body?.displayName || '').trim();
  console.log(`the display name of the project: ${displayName}`);

  console.log('--- where the name of the app comes from ---');
  console.log(
    '  an Android app which is installed from Google Play gets the name of ' +
      'the Play listing;',
  );
  console.log(
    '  every other case (a sideloaded build, the web build without a ' +
      'custom domain) gets the name of the default Hosting site.',
  );
  console.log(
    '  so a code which carries "' +
      hostingSite +
      '" is sent to a build which is not installed from Google Play.',
  );

  console.log('--- the messages of StayServe ---');
  for (const message of serverMessages()) {
    console.log(`the ${message.channel} channel:`);
    if (message.subject) console.log(`  the subject: ${message.subject}`);
    console.log(`  the body:    ${message.body}`);
  }

  console.log('--- what can be done ---');
  console.log(
    '  1. publish the app on Google Play with the title "StayServe": a ' +
      'build which is installed from Play receives the name of the listing.',
  );
  console.log(
    '  2. set the public-facing name of the project to "StayServe" in the ' +
      'console (Authentication, Settings, General): the mail templates of ' +
      'Firebase Auth use it.',
  );
  console.log(
    '  3. let StayServe send the code by itself: the backend supports ' +
      'Twilio, Fast2SMS and MSG91 and sends "' +
      'is your StayServe login OTP.".',
  );
}

main().catch((error) => {
  console.error(`ERROR  ${error.message}`);
  process.exitCode = 1;
});
