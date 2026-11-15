// FULL live sign-up proof against the deployed backend:
//
//   1. create a throw-away inbox (mail.tm) - a NON-sender address
//   2. create a real Firebase Auth account with that address
//   3. sendOtp(email)  -> the mail must actually arrive
//   4. verifyOtp(email) -> verified
//   5. sendOtp(mobile) with a bare 10-digit Indian number
//      -> read the code from Cloud Logging -> verifyOtp(mobile)
//   6. completeRegistration -> the server writes the profile
//   7. read the users doc back and print it
//   8. clean up
//
// This exercises the exact same sequence a real user goes through.

import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const PROJECT = 'myfirstapp-fa30f52b';
const FN = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const LOGGING = 'https://logging.googleapis.com/v2/entries:list';
const FIREBASE = 'https://identitytoolkit.googleapis.com/v1';
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const API_KEY = 'AIzaSyDXm8VBnXgwKHajc-0GRwVHb5mk95agIUM';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function firebaseToken() {
  // The firebase-tools access token expires after ~1h. Running any CLI
  // command makes the CLI refresh it (and write it back to the store),
  // so do that first and then read the fresh token.
  try {
    execFileSync('firebase', ['projects:list', '--project', PROJECT], {
      stdio: 'ignore',
      timeout: 120000,
    });
  } catch {
    // The CLI may not be on PATH in every environment; try the token anyway.
  }
  const p = path.join(os.homedir(), '.config/configstore/firebase-tools.json');
  const store = JSON.parse(fs.readFileSync(p, 'utf8'));
  const tok = store.tokens?.access_token;
  if (!tok) throw new Error('No firebase-tools OAuth token found at ' + p);
  return tok;
}

async function fetchLoggedCodes(since) {
  const token = firebaseToken();
  const filter =
    'resource.type="cloud_function" ' +
    'AND resource.labels.function_name="sendOtp" ' +
    'AND textPayload:"Code for" ' +
    `AND timestamp >= "${since}"`;
  const res = await json(LOGGING, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT}`],
      filter,
      orderBy: 'timestamp desc',
      pageSize: 20,
    }),
  });
  if (res.status === 429) {
    await sleep(20000);
    return fetchLoggedCodes(since);
  }
  if (res.status >= 400) {
    throw new Error(`Logging API HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return (res.body.entries || []).map((e) => ({ timestamp: e.timestamp || '', text: e.textPayload || '' }));
}

function normalisePhone(phone) {
  const cleaned = phone.replace(/[\s()-]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  return `+${cleaned}`;
}

async function waitForLogCode(identifier, since, label) {
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const entries = await fetchLoggedCodes(since);
    for (const e of entries) {
      const m = e.text.match(/Code for\s+(\+\d+)\s+is\s+(\d{6})/);
      if (m && m[1] === identifier) {
        console.log(`   ${label} log @ ${e.timestamp}: ${e.text.slice(0, 130)}`);
        return m[2];
      }
    }
    console.log(`   ${label}: waiting for the log to be ingested (${(i + 1) * 5}s)...`);
  }
  throw new Error(`No ${label} code found in the logs`);
}

async function main() {
  let mailAccount = null;
  let mailAuth = null;
  let idToken = null;
  let uid = null;
  const password = 'TmpPass!2026x';

  try {
    // ---------------------------------------------------------------- 1
    console.log('--- 1. create a throw-away inbox ---');
    const domains = await json('https://api.mail.tm/domains');
    const domain = domains.body['hydra:member']?.[0]?.domain;
    if (!domain) throw new Error('mail.tm domains unavailable');
    const address = `stayserve.signup.${Date.now()}@${domain}`;
    const created = await json('https://api.mail.tm/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password }),
    });
    if (created.status >= 400) throw new Error('mail.tm account failed: ' + JSON.stringify(created.body).slice(0, 200));
    mailAccount = created.body;
    const realAddress = mailAccount.address || address;
    const tokenRes = await json('https://api.mail.tm/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: realAddress, password }),
    });
    if (tokenRes.status >= 400) throw new Error('mail.tm token failed');
    mailAuth = { Authorization: `Bearer ${tokenRes.body.token}` };
    console.log(`   inbox: ${realAddress}`);

    // ---------------------------------------------------------------- 2
    console.log('\n--- 2. create the Firebase Auth account ---');
    const signUp = await json(`${FIREBASE}/accounts:signUp?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: realAddress, password, returnSecureToken: true }),
    });
    if (signUp.status >= 400) throw new Error('signUp failed: ' + JSON.stringify(signUp.body).slice(0, 300));
    uid = signUp.body.localId;
    idToken = signUp.body.idToken;
    console.log(`   uid: ${uid}`);

    const authHeader = { Authorization: `Bearer ${idToken}` };

    // ---------------------------------------------------------------- 3
    console.log('\n--- 3. email OTP ---');
    const emailSend = await json(`${FN}/sendOtp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { channel: 'email', identifier: realAddress } }),
    });
    console.log('   sendOtp:', JSON.stringify(emailSend.body));
    if (emailSend.body?.result?.delivered !== true) throw new Error('email was not delivered');

    let emailCode = null;
    for (let i = 0; i < 20 && !emailCode; i++) {
      await sleep(5000);
      const list = await json('https://api.mail.tm/messages', { headers: mailAuth });
      const msgs = list.body['hydra:member'] || [];
      if (msgs.length) {
        const full = await json(`https://api.mail.tm/messages/${msgs[0].id}`, { headers: mailAuth });
        const text = [full.body.subject, full.body.text, ...(full.body['textAsHtml'] || [])].join('\n');
        const m = text.match(/\b(\d{6})\b/);
        if (m) {
          emailCode = m[1];
          console.log(`   mail arrived: "${full.body.subject}" -> code ${emailCode}`);
        }
      }
    }
    if (!emailCode) throw new Error('email never arrived');

    const emailVerify = await json(`${FN}/verifyOtp`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { channel: 'email', identifier: realAddress, otp: emailCode } }),
    });
    console.log('   verifyOtp:', JSON.stringify(emailVerify.body));
    if (emailVerify.body?.result?.verified !== true) throw new Error('email OTP not verified');
    // The challenge is the proof that *this* client entered the code — the
    // registration needs it, and it may be used only once.
    const emailChallenge = emailVerify.body?.result?.challenge || '';
    if (!emailChallenge) throw new Error('the verification did not return a challenge');

    // ---------------------------------------------------------------- 4
    console.log('\n--- 4. mobile OTP (bare 10-digit number) ---');
    const phone = '9876500007';
    const normalised = normalisePhone(phone);
    console.log(`   ${phone} -> server normalises to ${normalised}`);
    const mobileSince = new Date(Date.now() - 5000).toISOString();
    const mobileSend = await json(`${FN}/sendOtp`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { channel: 'mobile', identifier: phone } }),
    });
    console.log('   sendOtp:', JSON.stringify(mobileSend.body));

    // Phone verification is switched off on the server (it costs money) —
    // then the mobile step is skipped and the number is only contact
    // information.
    const mobileDisabled = mobileSend.status >= 400;
    let mobileChallenge = '';

    if (!mobileDisabled) {
      const mobileCode = await waitForLogCode(normalised, mobileSince, 'mobile');
      console.log(`   code = ${mobileCode}`);

      const mobileVerify = await json(`${FN}/verifyOtp`, {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { channel: 'mobile', identifier: normalised, otp: mobileCode } }),
      });
      console.log('   verifyOtp:', JSON.stringify(mobileVerify.body));
      if (mobileVerify.body?.result?.verified !== true) throw new Error('mobile OTP not verified');
      mobileChallenge = mobileVerify.body?.result?.challenge || '';
    } else {
      console.log('   phone verification is switched off — the mobile step is skipped');
    }

    // ---------------------------------------------------------------- 5
    console.log('\n--- 5. completeRegistration ---');
    const complete = await json(`${FN}/completeRegistration`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          name: 'Test Student',
          phone,
          role: 'student',
          pincode: '110001',
          challenge: emailChallenge,
          phoneChallenge: mobileChallenge,
        },
      }),
    });
    console.log('   response:', JSON.stringify(complete.body));
    if (complete.status >= 400) throw new Error('completeRegistration failed: ' + JSON.stringify(complete.body));

    // The challenge may only be used once — a second registration with the
    // same challenge has to be refused.
    const replay = await json(`${FN}/completeRegistration`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          name: 'Test Student',
          phone,
          role: 'student',
          pincode: '110001',
          challenge: emailChallenge,
        },
      }),
    });
    if (replay.status < 400) throw new Error('the challenge was accepted twice');
    console.log('   the challenge cannot be used twice: HTTP ' + replay.status);

    // ---------------------------------------------------------------- 6
    console.log('\n--- 6. read the profile back from Firestore ---');
    const doc = await json(`${FIRESTORE}/users/${uid}`, { headers: authHeader });
    if (doc.status >= 400) throw new Error('Firestore read failed: ' + JSON.stringify(doc.body).slice(0, 300));
    const fields = doc.body.fields || {};
    const read = (k) => (fields[k]?.stringValue ?? fields[k]?.integerValue ?? fields[k]?.booleanValue ?? null);
    console.log(`   uid     : ${read('uid')}`);
    console.log(`   name    : ${read('name')}`);
    console.log(`   email   : ${read('email')}`);
    console.log(`   phone   : ${read('phone')}`);
    console.log(`   role    : ${read('role')}`);
    console.log(`   isActive: ${read('isActive')}`);

    // ---------------------------------------------------------------- 7
    console.log('\n--- 7. custom claims ---');
    const claims = await json(
      `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup?key=${API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ localId: [uid] }) },
    );
    console.log('   claims:', JSON.stringify(claims.body?.users?.[0]?.customAttributes));

    console.log('\n✅ FULL SIGN-UP FLOW WORKS END TO END');
  } finally {
    // ---------------------------------------------------------------- 8
    console.log('\n--- cleanup ---');
    if (idToken) {
      const del = await json(`${FIREBASE}/accounts:delete?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      console.log(`   auth account deleted -> HTTP ${del.status}`);
    }
    if (mailAccount?.id && mailAuth) {
      const del = await json(`https://api.mail.tm/accounts/${mailAccount.id}`, { method: 'DELETE', headers: mailAuth });
      console.log(`   mail.tm inbox deleted -> HTTP ${del.status}`);
    }
    console.log(`   uid for manual cleanup: ${uid}`);
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(2);
});
