// Probe: what does the deployed server answer when the **student** opens
// the payment sheet for a room with a small rent?
//
// It creates a throw-away student and owner, a listing with a rent of 444
// (the same rent the real listing has), runs the booking up to the payment
// and prints the **whole** answer of `createUpiPayment` — the UPI intent
// included. Everything it creates is removed again.
//
//   node tools/payment_probe.mjs

import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';

const KEY = 'AIzaSyDXm8VBnXgwKHajc-0GRwVHb5mk95agIUM';
const PROJ = 'myfirstapp-fa30f52b';
const REGION = 'us-central1';
const AUTH = `https://identitytoolkit.googleapis.com/v1`;
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const FN = `https://${REGION}-${PROJ}.cloudfunctions.net`;

const STAMP = Date.now();
const STUDENT_EMAIL = `probe.student.${STAMP}@example.com`;
const OWNER_EMAIL = `probe.owner.${STAMP}@example.com`;
const PASSWORD = 'TmpProbe!2026x';

function firebaseToken() {
  try {
    execFileSync('firebase', ['projects:list', '--project', PROJ], {
      stdio: 'ignore',
      timeout: 120000,
    });
  } catch {
    /* the stored token may still work */
  }
  const p = path.join(os.homedir(), '.config/configstore/firebase-tools.json');
  const store = JSON.parse(fs.readFileSync(p, 'utf8'));
  return store.tokens?.access_token;
}

async function identity(pathname, body) {
  const res = await fetch(`${AUTH}${pathname}?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function signUp(email) {
  const res = await identity('/accounts:signUp', {
    email,
    password: PASSWORD,
    returnSecureToken: true,
  });
  if (res.status !== 200) throw new Error(`signUp: ${JSON.stringify(res.json)}`);
  return { uid: res.json.localId, idToken: res.json.idToken };
}

async function call(fnName, idToken, data) {
  const res = await fetch(`${FN}/${fnName}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function fsWrite(oauth, docPath, fields) {
  const res = await fetch(`${BASE}/${docPath}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${oauth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return { status: res.status };
}

async function fsDelete(oauth, docPath) {
  const res = await fetch(`${BASE}/${docPath}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${oauth}` },
  });
  return res.status;
}

async function fsList(oauth, collection) {
  const res = await fetch(`${BASE}/${collection}?pageSize=300`, {
    headers: { Authorization: `Bearer ${oauth}` },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = {}; }
  return json.documents || [];
}

function field(doc, key) {
  const v = (doc.fields || {})[key] || {};
  for (const kind of ['stringValue', 'doubleValue', 'booleanValue', 'integerValue']) {
    if (kind in v) return v[kind];
  }
  return null;
}

async function deleteUser(uid) {
  const token = firebaseToken();
  // The project has to be part of the path.
  //
  // The endpoint without it (`/v1/accounts:delete`) belongs to the
  // **Identity Toolkit** of the consumer projects — it answered "400" and
  // the probe accounts stayed in the project after every run.
  const res = await fetch(`${AUTH}/projects/${PROJ}/accounts:delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ localId: uid }),
  });
  return res.status;
}

let oauth;
let student;
let owner;
const roomId = `PROBE-ROOM-${STAMP}`;
let requestId = null;

async function main() {
  oauth = firebaseToken();

  student = await signUp(STUDENT_EMAIL);
  owner = await signUp(OWNER_EMAIL);
  console.log('student', student.uid, 'owner', owner.uid);

  const now = new Date().toISOString();
  await fsWrite(oauth, `rooms/${roomId}`, {
    roomId: { stringValue: roomId },
    ownerId: { stringValue: owner.uid },
    title: { stringValue: 'Probe listing' },
    description: { stringValue: 'throw away' },
    monthlyRent: { doubleValue: 444 },
    securityDeposit: { doubleValue: 500 },
    location: {
      mapValue: {
        fields: {
          address: { stringValue: 'MG Road' },
          city: { stringValue: 'Bengaluru' },
          state: { stringValue: 'Karnataka' },
          pincode: { stringValue: '560001' },
          latitude: { doubleValue: 12.9716 },
          longitude: { doubleValue: 77.5946 },
        },
      },
    },
    roomType: { stringValue: 'single' },
    furnishing: { stringValue: 'semi' },
    availableFrom: { timestampValue: now },
    amenities: { arrayValue: { values: [{ stringValue: 'WiFi' }] } },
    occupancy: { integerValue: '2' },
    currentOccupancy: { integerValue: '0' },
    genderPreference: { stringValue: 'any' },
    images: { arrayValue: {} },
    status: { stringValue: 'available' },
    createdAt: { timestampValue: now },
    updatedAt: { timestampValue: now },
  });

  const created = await call('createJoinRequest', student.idToken, { roomId });
  console.log('createJoinRequest', created.status, JSON.stringify(created.json).slice(0, 300));
  requestId = created.json?.result?.requestId || created.json?.requestId || null;

  const approved = await call('respondToJoinRequest', owner.idToken, {
    requestId,
    approve: true,
  });
  console.log('respondToJoinRequest', approved.status, JSON.stringify(approved.json).slice(0, 200));

  const confirmed = await call('confirmJoinAsStudent', student.idToken, { requestId });
  console.log('confirmJoinAsStudent', confirmed.status, JSON.stringify(confirmed.json).slice(0, 200));

  const intent = await call('createUpiPayment', student.idToken, { joinRequestId: requestId });
  console.log('\n=== createUpiPayment (student) ===');
  console.log('HTTP', intent.status);
  console.log(JSON.stringify(intent.json, null, 2));

  const ownerIntent = await call('createUpiPayment', owner.idToken, { joinRequestId: requestId });
  console.log('\n=== createUpiPayment (owner) ===');
  console.log('HTTP', ownerIntent.status);
  console.log(JSON.stringify(ownerIntent.json, null, 2));
}

async function cleanup() {
  console.log('\n--- cleanup ---');
  if (requestId) {
    await fsDelete(oauth, `joinRequests/${requestId}`);
    await fsDelete(oauth, `payments/${requestId}`);
  }
  await fsDelete(oauth, `rooms/${roomId}`);
  const notifs = await fsList(oauth, 'notifications');
  for (const doc of notifs) {
    const uid = field(doc, 'userId');
    if (uid === student?.uid || uid === owner?.uid) {
      await fsDelete(oauth, `notifications/${doc.name.split('/').pop()}`);
    }
  }
  if (student?.uid) console.log('delete student', await deleteUser(student.uid));
  if (owner?.uid) console.log('delete owner', await deleteUser(owner.uid));
}

main()
  .catch((e) => console.error('probe failed:', e.message))
  .finally(cleanup);
