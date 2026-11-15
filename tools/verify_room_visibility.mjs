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
//      (the same state `completeRegistration` produces);
//   3. the owner creates one listing **without** the server-owned fields
//      (what the old app did) and one listing **with** the initial values
//      (what the app does now);
//   4. it waits for the `onRoomCreated` trigger to normalize the first one;
//   5. the student runs the query the app uses (`status == available`) and
//      both listings have to be in the result;
//   6. everything it created is removed again.
//
//   node tools/verify_room_visibility.mjs

import { execFileSync } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = 'AIzaSyDXm8VBnXgwKHajc-0GRwVHb5mk95agIUM';
const PROJ = 'myfirstapp-fa30f52b';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const AUTH = `https://identitytoolkit.googleapis.com/v1`;
const PASSWORD = 'TmpVerify!2026x';

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
  return { token: signUp.json.idToken, uid: signUp.json.localId, email };
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

function fieldOf(document, name) {
  const value = document?.fields?.[name];
  if (!value) return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  return undefined;
}

async function cleanup() {
  console.log('\n--- cleanup ---');
  for (const roomId of created.roomIds) {
    const r = await adminFs('DELETE', `/rooms/${roomId}`);
    console.log(`  deleted room ${roomId} -> HTTP ${r.status}`);
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

async function main() {
  adminToken = firebaseCliToken();
  console.log(`--- project ${PROJ} ---`);

  const owner = await createAccount('owner');
  const student = await createAccount('student');
  tokens.set(owner.uid, owner.token);
  tokens.set(student.uid, student.token);

  await makeLive(owner, 'owner');
  await makeLive(student, 'student');

  // -----------------------------------------------------------------------
  // 1. The listing of the **old** app: no server-owned fields at all.
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
    'an owner may create a listing without the server-owned fields',
    legacyCreate.status === 200,
    `HTTP ${legacyCreate.status}`,
  );

  // -----------------------------------------------------------------------
  // 2. The listing of the **current** app: the initial values are stated.
  // -----------------------------------------------------------------------
  const currentRoomId = `${owner.uid}-current`;
  created.roomIds.push(currentRoomId);
  const currentCreate = await clientFs(owner.token, 'PATCH', `/rooms/${currentRoomId}`, {
    fields: {
      roomId: { stringValue: currentRoomId },
      ownerId: { stringValue: owner.uid },
      title: { stringValue: 'Visibility check (current payload)' },
      monthlyRent: { doubleValue: 7000 },
      occupancy: { integerValue: '2' },
      status: { stringValue: 'available' },
      currentOccupancy: { integerValue: '0' },
      createdAt: { timestampValue: new Date().toISOString() },
    },
  });
  check(
    'an owner may create a listing with the initial server-owned state',
    currentCreate.status === 200,
    `HTTP ${currentCreate.status}`,
  );

  // -----------------------------------------------------------------------
  // 3. The `onRoomCreated` trigger has to normalize the legacy listing.
  // -----------------------------------------------------------------------
  let legacyDocument = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const read = await adminFs('GET', `/rooms/${legacyRoomId}`);
    if (read.status === 200) {
      legacyDocument = read.json;
      if (
        fieldOf(legacyDocument, 'status') !== undefined &&
        fieldOf(legacyDocument, 'currentOccupancy') !== undefined
      ) {
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check(
    'the trigger gives the legacy listing a status',
    fieldOf(legacyDocument, 'status') === 'available',
    `status=${fieldOf(legacyDocument, 'status')}`,
  );
  check(
    'the trigger gives the legacy listing an occupancy counter',
    fieldOf(legacyDocument, 'currentOccupancy') === 0,
    `currentOccupancy=${fieldOf(legacyDocument, 'currentOccupancy')}`,
  );

  // -----------------------------------------------------------------------
  // 4. The student has to see **both** listings.
  // -----------------------------------------------------------------------
  let visible = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    visible = await studentQuery(student.token);
    if (visible.includes(legacyRoomId) && visible.includes(currentRoomId)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check(
    'the student sees the listing that was created without the fields',
    visible.includes(legacyRoomId),
    `${visible.length} listing(s) in the result`,
  );
  check(
    'the student sees the listing that was created with the initial state',
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
  console.error('ERROR:', error);
  try { await cleanup(); } catch (_) { /* ignore */ }
  process.exit(2);
});
