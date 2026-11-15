// Runs the **new** housekeeping queries against production once, to prove
// that they work (the right fields, the right indexes) before the daily
// job ever runs them.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJ = 'myfirstapp-fa30f52b';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;

async function cliAccessToken() {
  const raw = await readFile(
    join(homedir(), '.config/configstore/firebase-tools.json'),
    'utf8',
  );
  const store = JSON.parse(raw);
  return store.tokens?.access_token || null;
}

const token = await cliAccessToken();
if (!token) {
  console.log('No Firebase CLI token — run `firebase login` first.');
  process.exit(2);
}

/** Runs a structured query (the same shape the SDK sends). */
async function query(structuredQuery) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });
  const text = await res.text();
  if (res.status !== 200) {
    console.log(`  query failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    return null;
  }
  // `runQuery` answers with a JSON **array** of result entries.
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [])
    .map((entry) => entry.document)
    .filter(Boolean);
}

function field(doc, name) {
  const v = doc.fields?.[name];
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  return v;
}

function docId(doc) {
  return doc.name.split('/').pop();
}

function ago(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// --- 1. the locks of the transaction references -----------------------
console.log('--- paymentReferences (older than 90 days) ---');
const references = await query({
  from: [{ collectionId: 'paymentReferences' }],
  where: {
    fieldFilter: {
      field: { fieldPath: 'createdAt' },
      op: 'LESS_THAN',
      value: { timestampValue: ago(90) },
    },
  },
  orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' }],
});
console.log(
  `  ${references ? references.length : '?'} document(s) would be deleted`,
);

// --- 2. the quota of the OTP sources ----------------------------------
console.log('--- otpSendQuota (window older than 2 hours) ---');
const quotas = await query({
  from: [{ collectionId: 'otpSendQuota' }],
  where: {
    fieldFilter: {
      field: { fieldPath: 'windowStart' },
      op: 'LESS_THAN',
      value: { timestampValue: hoursAgo(2) },
    },
  },
  orderBy: [{ field: { fieldPath: 'windowStart' }, direction: 'ASCENDING' }],
});
console.log(
  `  ${quotas ? quotas.length : '?'} document(s) would be deleted`,
);
for (const doc of quotas || []) {
  console.log(
    `    ${docId(doc).slice(0, 12)}… windowStart=${field(doc, 'windowStart')} sendCount=${field(doc, 'sendCount')}`,
  );
}

// --- 3. the locks of the booking requests -----------------------------
console.log('--- joinRequestLocks (older than 90 days) ---');
const locks = await query({
  from: [{ collectionId: 'joinRequestLocks' }],
  where: {
    fieldFilter: {
      field: { fieldPath: 'updatedAt' },
      op: 'LESS_THAN',
      value: { timestampValue: ago(90) },
    },
  },
  orderBy: [{ field: { fieldPath: 'updatedAt' }, direction: 'ASCENDING' }],
});
console.log(`  ${locks ? locks.length : '?'} document(s) to inspect`);
for (const doc of locks || []) {
  console.log(
    `    ${docId(doc).slice(0, 12)}… requestId=${field(doc, 'requestId')} status=${field(doc, 'status')} student=${field(doc, 'studentId')}`,
  );
}

// --- 4. the documents that are actually there -------------------------
console.log('--- what is in the collections right now ---');
for (const collection of [
  'paymentReferences',
  'otpSendQuota',
  'joinRequestLocks',
]) {
  const res = await fetch(`${BASE}/${collection}?pageSize=300`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const json = await res.json().catch(() => ({}));
  const docs = json.documents || [];
  console.log(`  ${collection}: ${docs.length} document(s)`);
  for (const doc of docs) {
    console.log(
      `    ${docId(doc).slice(0, 16)}… createdAt=${field(doc, 'createdAt')} windowStart=${field(doc, 'windowStart')} updatedAt=${field(doc, 'updatedAt')}`,
    );
  }
}
