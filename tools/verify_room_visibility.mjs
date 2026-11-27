// End-to-end proof in the **real** project that a listing an owner uploads
// is visible to a student.
//
// The bug this guards against: a listing that was written without the
// server-owned `status` field was never matched by the student search
// (`status == available`), so the owner saw "Listing saved" and the student
// saw nothing.
//
// The script therefore does exactly what the app does:
//
//   1. it creates a throw-away owner and a throw-away student;
//   2. it makes both of them live accounts through the server-side channel
//      (the same state `completeRegistration` produces) and completes the
//      **real** Firebase phone challenge for them, so their tokens carry the
//      signed `stayServeVerifiedPhone` claim which the rules evaluate;
//   3. the owner creates one listing **without** the server-owned state —
//      which the rules now refuse — and one listing as a **draft** (what the
//      app does now);
//   4. the server publishes the draft through `publishRoomListing`, which
//      verifies that the private exact location exists;
//   5. the student runs the query the app uses (`status == available`) and
//      the published listing has to be in the result;
//   6. everything it created is removed again.
//
//   node tools/verify_room_visibility.mjs

import { execFileSync } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { prepareVerifiedPhoneIdentity } from './live_test_identity.mjs';
import {
  appCheckHeaders,
  assertAppCheckConfigured,
} from './app_check.mjs';
import { safeErrorText } from './mask_pii.mjs';

const KEY = 'AIzaSyDXm8VBnXgwKHajc-0GRwVHb5mk95agIUM';
const PROJ = 'myfirstapp-fa30f52b';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const AUTH = `https://identitytoolkit.googleapis.com/v1`;
const FUNCTIONS_BASE = `https://us-central1-${PROJ}.cloudfunctions.net`;
const PASSWORD = 'TmpVerify!2026x';
const PHONE_OWNER =
  process.env.STAYSERVE_SMOKE_PHONE_OWNER || '+15555550106';
const PHONE_STUDENT =
  process.env.STAYSERVE_SMOKE_PHONE_STUDENT || '+15555550107';

let adminToken = null;
let pass = 0;
let fail = 0;

const created = { uids: [], roomIds: [] };

function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? '  (' + detail + ')' : ''}`);
  }
}

async function auth(path, body) {
  const res = await fetch(`${AUTH}${path}?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

/** A request with the Firebase CLI OAuth token (the server channel). */
async function adminFs(method, fsPath, body) {
  const res = await fetch(`${BASE}${fsPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 120) }; }
  return { status: res.status, json };
}

/** A request with the account's own ID token (the client channel). */
async function clientFs(token, method, fsPath, body) {
  const res = await fetch(`${BASE}${fsPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 120) }; }
  return { status: res.status, json };
}

/** A callable with the account's own ID token (the client channel). */
async function callable(name, token, data) {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: appCheckHeaders({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 120) }; }
  return { status: res.status, json };
}

/** The structured query the Flutter student search sends. */
async function studentQuery(token) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'rooms' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'status' },
            op: 'EQUAL',
            value: { stringValue: 'available' },
          },
        },
        orderBy: [
          { field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' },
        ],
        limit: 300,
      },
    }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = []; }
  if (!Array.isArray(json)) return [];
  return json
    .map((row) => row?.document?.name)
    .filter(Boolean)
    .map((name) => String(name).split('/').pop());
}

function adminUpdateMask(fields) {
  return Object.keys(fields)
    .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
    .join('&');
}

function firebaseCliToken() {
  try {
    execFileSync('firebase', ['projects:list', '--project', PROJ], {
      stdio: 'ignore',
      timeout: 120000,
    });
  } catch {
    // The CLI may not be installed or may not be logged in.
  }

  const stores = [
    path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json'),
    path.join(os.homedir(), '.config', 'firebase', 'config.json'),
  ];

  for (const store of stores) {
    if (!nodeFs.existsSync(store)) continue;
    try {
      const parsed = JSON.parse(nodeFs.readFileSync(store, 'utf8'));
      const value = parsed?.tokens?.access_token;
      if (value) return value;
    } catch {
      // Try the next known location.
    }
  }

  throw new Error(
    'No firebase-tools OAuth token found. Run `firebase login` and try again.',
  );
}

/** Creates a throw-away account and returns its ID token and uid. */
async function createAccount(label) {
  const email = `verify.${label}.${Date.now()}@example.com`;
  const signUp = await auth('/accounts:signUp', {
    email,
    password: PASSWORD,
    returnSecureToken: true,
  });
  if (signUp.status !== 200) {
    throw new Error(
      `Could not create the throw-away ${label} (HTTP ${signUp.status}): ${JSON.stringify(signUp.json).slice(0, 200)}`,
    );
  }
  created.uids.push(signUp.json.localId);
  return {
    token: signUp.json.idToken,
    refreshToken: signUp.json.refreshToken || '',
    uid: signUp.json.localId,
    email,
    password: PASSWORD,
  };
}

/**
 * Brings the profile into the state `completeRegistration` produces.
 *
 * The client rules require `registrationCompleted: true` and
 * `isActive: true`, so a fresh account cannot read or write anything.
 */
async function makeLive(account, role) {
  const profile = await adminFs('GET', `/users/${account.uid}`);
  if (profile.status === 404) {
    const createdProfile = await adminFs('PATCH', `/users/${account.uid}`, {
      fields: {
        uid: { stringValue: account.uid },
        name: { stringValue: `Verify ${role}` },
        email: { stringValue: account.email },
        role: { stringValue: 'student' },
        isActive: { booleanValue: true },
        registrationCompleted: { booleanValue: false },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    });
    if (createdProfile.status >= 400) {
      throw new Error(
        `Could not create the throw-away profile (HTTP ${createdProfile.status})`,
      );
    }
  }

  const fields = {
    role: { stringValue: role },
    isActive: { booleanValue: true },
    registrationCompleted: { booleanValue: true },
  };
  const updated = await adminFs(
    'PATCH',
    `/users/${account.uid}?${adminUpdateMask(fields)}`,
    { fields },
  );
  if (updated.status >= 400) {
    throw new Error(
      `Could not activate the throw-away profile (HTTP ${updated.status})`,
    );
  }
}

/**
 * Completes the real phone challenge of the throw-away account.
 *
 * The phone facts are never written through the Admin channel: a number
 * which an administrator attaches is not a verification proof. The server
 * records the proof itself and publishes the signed claims, so the refreshed
 * token carries `stayServeVerifiedPhone`.
 */
async function prepareVerifiedPhone(account, phoneNumber) {
  const live = await prepareVerifiedPhoneIdentity({
    projectId: PROJ,
    apiKey: KEY,
    functionsBase: FUNCTIONS_BASE,
    uid: account.uid,
    email: account.email,
    password: account.password,
    phoneNumber,
  });
  account.token = live.idToken;
  account.refreshToken = live.refreshToken || account.refreshToken;
}

async function cleanup() {
  console.log('\n--- cleanup ---');
  for (const roomId of created.roomIds) {
    // The listing is removed through the server-owned path, so the exact
    // location, the photos and the request history disappear with it. A
    // direct delete of the public document would leave the private location
    // — and the exact address of the throw-away listing — behind.
    const r = await callable('deleteRoomListing', ownerToken(), { roomId });
    console.log(`  deleted listing ${roomId} -> HTTP ${r.status}`);
    // The defensive fallback removes the private document as well.
    for (const path of [`/rooms/${roomId}`, `/roomPrivate/${roomId}`]) {
      const fallback = await adminFs('DELETE', path);
      console.log(`  deleted ${path} -> HTTP ${fallback.status}`);
    }
  }
  for (const uid of created.uids) {
    const r = await adminFs('DELETE', `/users/${uid}`);
    console.log(`  deleted profile ${uid} -> HTTP ${r.status}`);
    const d = await auth(`/accounts:delete`, {
      idToken: await idTokenOf(uid),
    }).catch(() => ({ status: 0 }));
    console.log(`  deleted auth account ${uid} -> HTTP ${d.status}`);
  }
}

/** Signs the account in again to get a token for the deletion. */
const tokens = new Map();
async function idTokenOf(uid) {
  if (tokens.has(uid)) return tokens.get(uid);
  return null;
}

/** The current ID token of the throw-away owner. */
function ownerToken() {
  for (const uid of created.uids) {
    const token = tokens.get(uid);
    if (token) return token;
  }
  return '';
}

async function main() {
  // The App Check configuration is verified **before** the throw-away
  // accounts are created, so a missing token never leaves test data behind.
  assertAppCheckConfigured();
  adminToken = firebaseCliToken();
  console.log(`--- project ${PROJ} ---`);

  const owner = await createAccount('owner');
  const student = await createAccount('student');
  tokens.set(owner.uid, owner.token);
  tokens.set(student.uid, student.token);

  await makeLive(owner, 'owner');
  await makeLive(student, 'student');

  // The phone challenge is the real one: the server records the proof and
  // publishes the signed claim which the rules evaluate.
  await prepareVerifiedPhone(owner, PHONE_OWNER);
  tokens.set(owner.uid, owner.token);
  await prepareVerifiedPhone(student, PHONE_STUDENT);
  tokens.set(student.uid, student.token);

  // -----------------------------------------------------------------------
  // 1. The **published** collection is server-owned. A client may never put
  //    a document into it, so an unfinished listing can never appear in a
  //    query of the public listings.
  // -----------------------------------------------------------------------
  const legacyRoomId = `${owner.uid}-legacy`;
  created.roomIds.push(legacyRoomId);
  const legacyCreate = await clientFs(owner.token, 'PATCH', `/rooms/${legacyRoomId}`, {
    fields: {
      roomId: { stringValue: legacyRoomId },
      ownerId: { stringValue: owner.uid },
      title: { stringValue: 'Visibility check (legacy payload)' },
      monthlyRent: { doubleValue: 7000 },
      occupancy: { integerValue: '2' },
      createdAt: { timestampValue: new Date().toISOString() },
    },
  });
  check(
    'an owner may NOT write into the published collection',
    legacyCreate.status >= 400,
    `HTTP ${legacyCreate.status}`,
  );

  // -----------------------------------------------------------------------
  // 2. The listing of the **current** app: it is created as a draft in its
  //    own owner-scoped collection.
  // -----------------------------------------------------------------------
  const currentRoomId = `${owner.uid}-current`;
  created.roomIds.push(currentRoomId);
  const currentCreate = await clientFs(
    owner.token,
    'PATCH',
    `/roomDrafts/${currentRoomId}`,
    {
      fields: {
        roomId: { stringValue: currentRoomId },
        ownerId: { stringValue: owner.uid },
        title: { stringValue: 'Visibility check (current payload)' },
        monthlyRent: { doubleValue: 7000 },
        occupancy: { integerValue: '2' },
        status: { stringValue: 'draft' },
        currentOccupancy: { integerValue: '0' },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    },
  );
  check(
    'an owner may create a listing as a draft',
    currentCreate.status === 200,
    `HTTP ${currentCreate.status}`,
  );

  // -----------------------------------------------------------------------
  // 2a. The draft is private to its owner. A student may neither read it
  //     nor list it.
  // -----------------------------------------------------------------------
  const draftRead = await clientFs(
    student.token,
    'GET',
    `/roomDrafts/${currentRoomId}`,
  );
  check(
    'a student may NOT read a foreign draft listing',
    draftRead.status >= 400,
    `HTTP ${draftRead.status}`,
  );
  const draftList = await clientFs(
    student.token,
    'GET',
    '/roomDrafts',
  );
  check(
    'a student may NOT list the draft listings',
    draftList.status >= 400,
    `HTTP ${draftList.status}`,
  );

  // -----------------------------------------------------------------------
  // 3. The draft is not on the market before it is published.
  // -----------------------------------------------------------------------
  const draftVisible = await studentQuery(student.token);
  check(
    'the draft is not offered to the student before the publication',
    !draftVisible.includes(currentRoomId),
    `${draftVisible.length} listing(s) in the result`,
  );

  // -----------------------------------------------------------------------
  // 4. The server publishes the draft once the exact location exists.
  // -----------------------------------------------------------------------
  const privateLocation = await callable('setRoomPrivateLocation', owner.token, {
    roomId: currentRoomId,
    address: '42 Visibility Check Lane',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: 77.5946,
  });
  check(
    'the owner stores the exact location privately',
    privateLocation.status === 200 && privateLocation.json?.result?.success === true,
    `HTTP ${privateLocation.status}`,
  );
  const published = await callable('publishRoomListing', owner.token, {
    roomId: currentRoomId,
  });
  check(
    'the server publishes the finished draft',
    published.status === 200 && published.json?.result?.success === true,
    `HTTP ${published.status}`,
  );

  // -----------------------------------------------------------------------
  // 5. The student has to see the published listing.
  // -----------------------------------------------------------------------
  let visible = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    visible = await studentQuery(student.token);
    if (visible.includes(currentRoomId)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check(
    'the student sees the published listing',
    visible.includes(currentRoomId),
    `${visible.length} listing(s) in the result`,
  );

  // -----------------------------------------------------------------------
  // 5. The real listings of the project must be visible as well.
  // -----------------------------------------------------------------------
  const real = visible.filter((id) => !id.startsWith(owner.uid));
  check(
    'the listings of the project are in the student search',
    real.length > 0,
    `${real.length} listing(s): ${real.join(', ')}`,
  );

  await cleanup();

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  // The error of a Firebase call can carry the phone number, the API key or
  // an identity token. Only the masked message is printed.
  console.error('ERROR:', safeErrorText(error));
  try { await cleanup(); } catch (_) { /* ignore */ }
  process.exit(2);
});
