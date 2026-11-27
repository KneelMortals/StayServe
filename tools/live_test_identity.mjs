// Helpers for disposable live-test identities.
//
// StayServe treats Firebase Auth as the authority for a verified phone, and
// the server only accepts a number which the account owner proved with
// Firebase's own phone challenge (`PhoneAuthProvider`).
//
// The Admin SDK can attach a phone number to an account **without** that
// challenge, so this helper never uses it for a phone number. It performs the
// same flow as the Flutter app instead:
//
//   1. `accounts:sendVerificationCode` asks Firebase to send the SMS.
//   2. `accounts:signInWithPhoneNumber` links the number to the account and
//      returns a session which was authenticated by the phone provider.
//
// The second call is the endpoint behind `PhoneAuthProvider` +
// `linkWithCredential`. Firebase issues such a token only after the SMS
// challenge was completed, which is exactly the proof the server records.
//
// The SMS code has to be supplied by the operator who owns the test number:
//
//   STAYSERVE_LIVE_PHONE_CODE           the six digit code from the SMS
//   STAYSERVE_LIVE_PHONE_SESSION_INFO   the session of an earlier code request
//   STAYSERVE_LIVE_PHONE_CAPTCHA        an optional reCAPTCHA response
//
// `node tools/live_test_identity.mjs request-code --phone +919876543210`
// sends a fresh code and stores the session which belongs to it in a
// private file. The session handle is a bearer credential for the pending
// SMS challenge, so it is never written to stdout.

import {
  maskPhoneNumber,
  maskSensitiveText,
} from './mask_pii.mjs';

import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1';

async function jsonRequest(url, options = {}) {
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

/** Decodes the payload of a Firebase ID token (the server verifies it). */
function decodeIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether the token was minted by a phone-provider session.
 *
 * `firebase.sign_in_provider` is `phone` only when Firebase authenticated the
 * session with the phone provider, which it does only after the SMS challenge
 * was completed.
 */
export function isPhoneProviderToken(idToken) {
  const claims = decodeIdToken(idToken);
  if (!claims) return false;
  const provider = String(claims.firebase?.sign_in_provider || '')
    .trim()
    .toLowerCase();
  return provider === 'phone' && String(claims.phone_number || '').trim() !== '';
}

/** The phone number which the token carries. */
export function phoneOfToken(idToken) {
  const claims = decodeIdToken(idToken);
  return String(claims?.phone_number || '').trim();
}

/**
 * Links a genuinely verified phone number to a disposable live-test account.
 *
 * The helper fails closed when no SMS code is available. It never falls back
 * to an Admin-provisioned number, because such a number is not a proof and
 * the server must reject it.
 */
export async function attachVerifiedPhone({
  projectId,
  apiKey,
  uid,
  email,
  password,
  phoneNumber,
  verificationCode = process.env.STAYSERVE_LIVE_PHONE_CODE || '',
  verificationSessionInfo =
    process.env.STAYSERVE_LIVE_PHONE_SESSION_INFO || '',
  captchaResponse = process.env.STAYSERVE_LIVE_PHONE_CAPTCHA || '',
}) {
  if (!projectId || !apiKey || !uid || !email || !password || !phoneNumber) {
    throw new Error('The disposable live identity is missing required fields.');
  }

  // The linking session is the account's current password session. Firebase
  // links the verified number to that account and returns a phone-provider
  // token for it.
  const signIn = await jsonRequest(
    `${AUTH_BASE}/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (signIn.status !== 200 || !signIn.body?.idToken) {
    throw new Error(
      `Could not sign the disposable live identity in: HTTP ${signIn.status} ` +
        maskSensitiveText(JSON.stringify(signIn.body)),
    );
  }
  if (signIn.body.localId && signIn.body.localId !== uid) {
    throw new Error(
      'The signed-in live identity does not belong to the expected account.',
    );
  }

  let sessionInfo = String(verificationSessionInfo || '').trim();
  if (!sessionInfo) {
    const sent = await jsonRequest(
      `${AUTH_BASE}/accounts:sendVerificationCode?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber,
          ...(captchaResponse ? { captchaResponse } : {}),
        }),
      },
    );
    if (sent.status !== 200 || !sent.body?.sessionInfo) {
      throw new Error(
        `Could not request the phone verification code: HTTP ${sent.status} ` +
          maskSensitiveText(JSON.stringify(sent.body)),
      );
    }
    sessionInfo = String(sent.body.sessionInfo);
  }

  const code = String(verificationCode || '').trim();
  if (!code) {
    // The session handle is a bearer credential for the pending SMS
    // challenge. It is never part of an error message: the operator reads it
    // from the private file which `request-code` writes.
    throw new Error(
      'The live probe needs the SMS code of the test number. ' +
        `A verification code was requested for ${maskPhoneNumber(phoneNumber)}; ` +
        're-run with STAYSERVE_LIVE_PHONE_SESSION_INFO=<session> ' +
        'and STAYSERVE_LIVE_PHONE_CODE=<code>.',
    );
  }

  const linked = await jsonRequest(
    `${AUTH_BASE}/accounts:signInWithPhoneNumber?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionInfo,
        code,
        idToken: signIn.body.idToken,
      }),
    },
  );
  if (linked.status !== 200 || !linked.body?.idToken) {
    throw new Error(
      `Could not link the verified phone identity: HTTP ${linked.status} ` +
        maskSensitiveText(JSON.stringify(linked.body)),
    );
  }

  if (!isPhoneProviderToken(linked.body.idToken)) {
    throw new Error(
      'The linked identity is not a phone-provider session. ' +
        'The server would not accept it as a verified phone.',
    );
  }
  if (phoneOfToken(linked.body.idToken) !== phoneNumber) {
    throw new Error(
      'The linked identity carries a different phone number than requested.',
    );
  }

  return {
    uid: linked.body.localId || uid,
    idToken: linked.body.idToken,
    refreshToken: linked.body.refreshToken || '',
    phoneNumber,
  };
}

/**
 * Signs a live-test identity in again.
 *
 * The server publishes its role and verified-phone claims after the profile
 * was prepared. A fresh sign-in picks them up; the custom claims stay in the
 * token even though the session itself was opened with the password.
 */
export async function refreshIdentityToken({ apiKey, email, password }) {
  if (!apiKey || !email || !password) {
    throw new Error('The disposable live identity is missing required fields.');
  }
  const signIn = await jsonRequest(
    `${AUTH_BASE}/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  if (signIn.status !== 200 || !signIn.body?.idToken) {
    throw new Error(
      `Could not refresh the disposable live identity: HTTP ${signIn.status} ` +
        maskSensitiveText(JSON.stringify(signIn.body)),
    );
  }
  return {
    uid: signIn.body.localId || '',
    idToken: signIn.body.idToken,
    refreshToken: signIn.body.refreshToken || '',
  };
}

/**
 * Records the verified-phone proof on the server.
 *
 * The server keeps its own proof of the completed SMS challenge: it is
 * written when a client presents a phone-provider ID token. The
 * `syncAuthProfile` callable is the route the Flutter app uses after the
 * challenge, so the probe uses it as well.
 *
 * The probe must never write the durable proof or the signed
 * `stayServeVerifiedPhone` claim itself — a claim which an administrator
 * invented is exactly what the server has to distrust.
 */
export async function syncVerifiedPhoneProfile({
  functionsBase,
  idToken,
  appCheckToken = process.env.STAYSERVE_APP_CHECK_TOKEN || '',
}) {
  if (!functionsBase || !idToken) {
    throw new Error(
      'The functions endpoint and a phone-backed token are required.',
    );
  }
  const headers = {
    Authorization: `Bearer ${idToken}`,
    'Content-Type': 'application/json',
  };
  if (appCheckToken) headers['X-Firebase-AppCheck'] = appCheckToken;

  const response = await jsonRequest(`${functionsBase}/syncAuthProfile`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: {} }),
  });
  if (response.status !== 200) {
    throw new Error(
      `Could not record the verified-phone proof: HTTP ${response.status} ` +
        maskSensitiveText(JSON.stringify(response.body)),
    );
  }
  const result = response.body?.result || {};
  if (result.phoneVerified !== true) {
    throw new Error(
      'The server did not accept the phone number as verified. ' +
        'The account has to complete the SMS challenge first.',
    );
  }
  return result;
}

/**
 * Prepares a disposable live identity with a genuinely verified phone.
 *
 * The flow is the one of the app:
 *
 *   1. the account signs in with its password,
 *   2. the phone challenge is completed (the SMS code comes from the
 *      operator who owns the test number),
 *   3. the server records the proof and publishes the signed claims,
 *   4. the account signs in again, so the returned token carries the
 *      `stayServeVerifiedPhone` claim which the Firestore and Storage rules
 *      evaluate.
 */
export async function prepareVerifiedPhoneIdentity({
  projectId,
  apiKey,
  functionsBase,
  uid,
  email,
  password,
  phoneNumber,
  verificationCode = process.env.STAYSERVE_LIVE_PHONE_CODE || '',
  verificationSessionInfo =
    process.env.STAYSERVE_LIVE_PHONE_SESSION_INFO || '',
  captchaResponse = process.env.STAYSERVE_LIVE_PHONE_CAPTCHA || '',
  appCheckToken = process.env.STAYSERVE_APP_CHECK_TOKEN || '',
}) {
  const live = await attachVerifiedPhone({
    projectId,
    apiKey,
    uid,
    email,
    password,
    phoneNumber,
    verificationCode,
    verificationSessionInfo,
    captchaResponse,
  });

  await syncVerifiedPhoneProfile({
    functionsBase,
    idToken: live.idToken,
    appCheckToken,
  });

  const refreshed = await refreshIdentityToken({ apiKey, email, password });
  return {
    uid: live.uid || refreshed.uid,
    idToken: refreshed.idToken,
    refreshToken: refreshed.refreshToken || live.refreshToken,
    phoneNumber: live.phoneNumber,
  };
}

/**
 * Requests a fresh verification code for a test number.
 *
 * It is the first half of the live phone flow. The session which belongs to
 * the code has to be passed to the probe as
 * `STAYSERVE_LIVE_PHONE_SESSION_INFO`.
 */
export async function requestPhoneVerificationCode({
  apiKey,
  phoneNumber,
  captchaResponse = process.env.STAYSERVE_LIVE_PHONE_CAPTCHA || '',
}) {
  if (!apiKey || !phoneNumber) {
    throw new Error('A project API key and a test phone number are required.');
  }
  const sent = await jsonRequest(
    `${AUTH_BASE}/accounts:sendVerificationCode?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phoneNumber,
        ...(captchaResponse ? { captchaResponse } : {}),
      }),
    },
  );
  if (sent.status !== 200 || !sent.body?.sessionInfo) {
    throw new Error(
      `Could not request the phone verification code: HTTP ${sent.status} ` +
        maskSensitiveText(JSON.stringify(sent.body)),
    );
  }
  return { sessionInfo: String(sent.body.sessionInfo) };
}

// ---------------------------------------------------------------------------
// Command line helper: request a verification code.
// ---------------------------------------------------------------------------
if (
  process.argv[1] &&
  process.argv[1].endsWith('live_test_identity.mjs') &&
  process.argv[2] === 'request-code'
) {
  const args = process.argv.slice(3);
  let phoneNumber = '';
  let apiKey = process.env.STAYSERVE_LIVE_API_KEY || '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--phone') phoneNumber = String(args[++i] || '');
    else if (args[i] === '--api-key') apiKey = String(args[++i] || '');
  }
  requestPhoneVerificationCode({ apiKey, phoneNumber })
    .then(({ sessionInfo }) => {
      // The session handle is a bearer credential for the pending SMS
      // challenge. It is written to a private file instead of stdout, so it
      // never reaches a shell history, a pipe or a CI log.
      const target = path.join(
        os.tmpdir(),
        `stayserve-live-phone-session-${process.pid}`,
      );
      nodeFs.writeFileSync(target, sessionInfo, { mode: 0o600 });
      try {
        nodeFs.chmodSync(target, 0o600);
      } catch {
        // A file system which does not support the mode is still better than
        // printing the handle into a log.
      }
      console.log(`STAYSERVE_LIVE_PHONE_SESSION_INFO_FILE=${target}`);
      console.log(
        'Read the session from that file and export it as ' +
          'STAYSERVE_LIVE_PHONE_SESSION_INFO, then enter the code from the ' +
          'SMS as STAYSERVE_LIVE_PHONE_CODE=<code>.',
      );
    })
    .catch((error) => {
      console.error(maskSensitiveText(String(error?.message || error)));
      process.exit(1);
    });
}
