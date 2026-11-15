// Prints the real content of the production Firestore.
//
// It uses the OAuth token of the Firebase CLI (it has the
// `cloud-platform` scope), so it sees the whole database — the same view
// the admin console has.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROJ = 'myfirstapp-fa30f52b';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;

async function cliToken() {
  const raw = await readFile(
    join(homedir(), '.config/configstore/firebase-tools.json'),
    'utf8',
  );
  const store = JSON.parse(raw);
  const tokens = store.tokens || {};
  return tokens.refresh_token ? tokens : null;
}

const tokens = await cliToken();
if (!tokens) {
  console.log('No Firebase CLI token found — run `firebase login` first.');
  process.exit(2);
}

// The CLI stores an OAuth access token — it has the `cloud-platform`
// scope and therefore sees the whole database.
const token = tokens.access_token;
if (!token) {
  console.log('No Firebase CLI access token found — run `firebase login` first.');
  process.exit(2);
}

async function list(path) {
  const r = await fetch(`${BASE}${path}?pageSize=300`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const j = await r.json().catch(() => ({}));
  return j.documents || [];
}

function field(doc, name) {
  const v = doc.fields?.[name];
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) return v.mapValue.fields;
  return v;
}

for (const collection of [
  'users',
  'rooms',
  'joinRequests',
  'payments',
  'commissionInvoices',
  'notifications',
  'conversations',
  'roomReviews',
  'settings',
  'otpCodes',
  'otpSendQuota',
  'paymentReferences',
  'joinRequestLocks',
]) {
  const docs = await list(`/${collection}`);
  console.log(`\n=== ${collection}: ${docs.length} document(s) ===`);
  for (const doc of docs) {
    const id = doc.name.split('/').pop();
    if (collection === 'users') {
      console.log(
        `  ${id}  role=${field(doc, 'role')} email=${field(doc, 'email')} phone=${field(doc, 'phone')} isActive=${field(doc, 'isActive')} deleteAfter=${field(doc, 'deleteAfter')}`,
      );
    } else if (collection === 'rooms') {
      console.log(
        `  ${id}  title=${field(doc, 'title')} owner=${field(doc, 'ownerId')} rent=${field(doc, 'monthlyRent')} status=${field(doc, 'status')} currentOccupancy=${field(doc, 'currentOccupancy')} occupancy=${field(doc, 'occupancy')}`,
      );
    } else if (collection === 'joinRequests') {
      console.log(
        `  ${id}  room=${field(doc, 'roomId')} student=${field(doc, 'studentId')} owner=${field(doc, 'ownerId')} status=${field(doc, 'status')} advancePaid=${field(doc, 'advancePaid')} advancePaymentStatus=${field(doc, 'advancePaymentStatus')} cancelledBy=${field(doc, 'cancelledBy')}`,
      );
    } else if (collection === 'notifications') {
      console.log(
        `  ${id}  user=${field(doc, 'userId')} type=${field(doc, 'type')} title=${field(doc, 'title')}`,
      );
    } else if (collection === 'settings') {
      console.log(`  ${id}  ${JSON.stringify(doc.fields).slice(0, 400)}`);
    } else {
      console.log(`  ${id}  ${JSON.stringify(doc.fields).slice(0, 260)}`);
    }
  }
}
