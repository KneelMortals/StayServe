// End-to-end proof that the MOBILE OTP path works against the deployed
// backend, using the log fallback (no SMS provider configured yet).
//
//   1. request a code for a mobile number (as the app would)
//   2. read the code out of Cloud Logging via the Logging API (robust -
//      the `firebase functions:log` CLI output contains ANSI/spinner noise)
//   3. verify the code with the deployed verifyOtp
//   4. report
//
// Usage: node mobile_e2e.mjs <phone>

import os from 'os';
import fs from 'fs';
import path from 'path';

import { appCheckHeaders, assertAppCheckConfigured } from './app_check.mjs';

const PROJECT = 'myfirstapp-fa30f52b';
const FN = `https://us-central1-${PROJECT}.cloudfunctions.net`;
const LOGGING = 'https://logging.googleapis.com/v2/entries:list';

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
  const p = path.join(os.homedir(), '.config/configstore/firebase-tools.json');
  const store = JSON.parse(fs.readFileSync(p, 'utf8'));
  const tok = store.tokens?.access_token;
  if (!tok) throw new Error('No firebase-tools OAuth token found at ' + p);
  return tok;
}

/**
 * Pulls the most recent "[OTP] ... Code for <identifier> is <code>" entries
 * that were logged AT OR AFTER `since`.
 *
 * Cloud Logging ingestion is not instant: an entry written now may only
 * become visible through the API 10-60s later.  Without the `since` guard we
 * happily read the PREVIOUS run's code and then verify the wrong one.
 */
async function fetchLoggedCodes(identifier, since) {
  const token = firebaseToken();
  const filter =
    'resource.type="cloud_function" ' +
    'AND resource.labels.function_name="sendOtp" ' +
    'AND textPayload:"Code for" ' +
    `AND timestamp >= "${since}"`;
  const res = await json(LOGGING, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT}`],
      filter,
      orderBy: 'timestamp desc',
      pageSize: 20,
    }),
  });
  if (res.status === 429) {
    // The Logging API has a per-minute read quota; back off and retry.
    await sleep(20000);
    return fetchLoggedCodes(identifier, since);
  }
  if (res.status >= 400) {
    throw new Error(`Logging API HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  const entries = res.body.entries || [];
  return entries.map((e) => ({
    timestamp: e.timestamp || '',
    text: e.textPayload || '',
  }));
}

/** Mirrors the server-side normalisation so we look for the right number. */
function normalisePhone(phone) {
  const cleaned = phone.replace(/[\s()-]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (/^[6-9]\d{9}$/.test(cleaned)) return `+91${cleaned}`;
  return `+${cleaned}`;
}

async function main() {
  assertAppCheckConfigured();
  const phone = process.argv[2];
  if (!phone) throw new Error('usage: node mobile_e2e.mjs <phone>');
  const normalised = normalisePhone(phone);

  console.log(`--- 1. request a mobile OTP for ${phone} ---`);
  console.log(`    (server normalises it to ${normalised})`);
  const sentAt = new Date(Date.now() - 5000).toISOString();
  const send = await json(`${FN}/sendOtp`, {
    method: 'POST',
    headers: appCheckHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: { channel: 'mobile', identifier: phone } }),
  });
  console.log('  response:', JSON.stringify(send.body));

  console.log('\n--- 2. read the code from Cloud Logging ---');
  let code = null;
  let seen = [];
  for (let i = 0; i < 20 && !code; i++) {
    await sleep(6000);
    const entries = await fetchLoggedCodes(normalised, sentAt);
    seen = entries;
    for (const e of entries) {
      // "... Code for +919876543210 is 381849 (expires in 5 min)."
      const m = e.text.match(/Code for\s+(\+\d+)\s+is\s+(\d{6})/);
      if (m && m[1] === normalised) {
        code = m[2];
        console.log(`  log entry at ${e.timestamp}: ${e.text.slice(0, 140)}`);
        break;
      }
    }
    console.log(`  poll ${i + 1}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} since ${sentAt}${code ? ' -> code found ✅' : ''}`);
  }
  if (!code) {
    console.log('  raw entries seen:');
    for (const e of seen.slice(0, 10)) console.log(`    ${e.timestamp} ${e.text}`);
    throw new Error('No code found in the logs');
  }
  console.log(`  code = ${code}`);

  console.log('\n--- 3. verify it ---');
  const verify = await json(`${FN}/verifyOtp`, {
    method: 'POST',
    headers: appCheckHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: { channel: 'mobile', identifier: normalised, otp: code } }),
  });
  console.log('  response:', JSON.stringify(verify.body));
  const ok = verify.body?.result?.verified === true;
  console.log(`  verified: ${ok ? 'YES ✅' : 'NO ❌'}`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(2);
});
