// Verifies the DEPLOYED Firestore rules of myfirstapp-fa30f52b.
//
// The check runs against the real project, so it is careful about what it
// does:
//
//   * it creates a throw-away Firebase Auth account;
//   * it turns that account into a **live owner** through the server-side
//     (Admin SDK equivalent) channel, because the client rules now require
//     `registrationCompleted: true` and `isActive: true`;
//   * it exercises the critical allow/deny paths with the account's own ID
//     token — the same token the Flutter app uses;
//   * it removes every document it created (again through the server-side
//     channel) and deletes the Auth account.
//
// The server-side channel uses the Firebase CLI OAuth token, exactly like
// `tools/backfill_registration.mjs`. Run `firebase login` first.
//
//   node tools/production_rules_check.mjs

import { execFileSync } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = 'AIzaSyDXm8VBnXgwKHajc-0GRwVHb5mk95agIUM';
const PROJ = 'myfirstapp-fa30f52b';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
const AUTH = `https://identitytoolkit.googleapis.com/v1`;

const EMAIL = `rules.check.${Date.now()}@example.com`;
const PASSWORD = 'TmpCheck!2026x';

let token = null; // the throw-away account's ID token (the client)
let adminToken = null; // the Firebase CLI OAuth token (the server)
let uid = null;

let pass = 0;
let fail = 0;

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

/** A request with the throw-away account's ID token (the client channel). */
async function fs(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
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

/**
 * A request with the Firebase CLI OAuth token (the server channel).
 *
 * The OAuth token has the `cloud-platform` scope, so Firestore treats the
 * request like an Admin SDK call: the security rules do not apply. It is
 * used to prepare and clean up the throw-away data — never to assert that
 * a rule allows something.
 */
async function adminFs(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
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

function adminUpdateMask(fields) {
  return Object.keys(fields)
    .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
    .join('&');
}

/**
 * A call **without** an `Authorization` header.
 *
 * Needed for the "readable before signing in" rules (`publicSettings`).
 */
async function fsAnon(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 120) }; }
  return { status: res.status, json };
}

// Runs a structured query (this is what the Flutter SDK sends).
async function runQuery(structuredQuery) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });
  const text = await res.text();
  return { status: res.status, text };
}

function denied(r) {
  return r.status === 403 || r.status === 401 ||
    (r.json && r.json.error && /PERMISSION_DENIED/i.test(r.json.error.status || ''));
}

/** The Firebase CLI OAuth token (server-side access). */
function firebaseCliToken() {
  try {
    execFileSync('firebase', ['projects:list', '--project', PROJ], {
      stdio: 'ignore',
      timeout: 120000,
    });
  } catch {
    // The CLI may not be installed or may not be logged in. The token file
    // is still tried below.
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

/**
 * Makes the throw-away account a live owner.
 *
 * A real account reaches this state through `completeRegistration` (the OTP
 * flow). The check reproduces that server-side transition through the Admin
 * SDK equivalent so the client assertions below run against a genuinely
 * live profile.
 */
async function prepareLiveOwner() {
  const profile = await adminFs('GET', `/users/${uid}`);
  if (profile.status === 404) {
    const created = await adminFs('PATCH', `/users/${uid}`, {
      fields: {
        uid: { stringValue: uid },
        name: { stringValue: 'Rules Check' },
        email: { stringValue: EMAIL },
        role: { stringValue: 'student' },
        isActive: { booleanValue: true },
        registrationCompleted: { booleanValue: false },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    });
    if (created.status >= 400) {
      throw new Error(
        `Could not create the throw-away profile (HTTP ${created.status}): ${JSON.stringify(created.json).slice(0, 300)}`,
      );
    }
  }

  const fields = {
    role: { stringValue: 'owner' },
    isActive: { booleanValue: true },
    registrationCompleted: { booleanValue: true },
  };
  const updated = await adminFs(
    'PATCH',
    `/users/${uid}?${adminUpdateMask(fields)}`,
    { fields },
  );
  if (updated.status >= 400) {
    throw new Error(
      `Could not activate the throw-away profile (HTTP ${updated.status}): ${JSON.stringify(updated.json).slice(0, 300)}`,
    );
  }
}

/** Seeds the notification the client reads (notifications are server-owned). */
async function seedNotification() {
  const fields = {
    userId: { stringValue: uid },
    title: { stringValue: 'rule check' },
    body: { stringValue: 'hello' },
    type: { stringValue: 'general' },
    read: { booleanValue: false },
    createdAt: { timestampValue: new Date().toISOString() },
  };
  const result = await adminFs('PATCH', `/notifications/${uid}-rulecheck`, { fields });
  if (result.status >= 400) {
    throw new Error(
      `Could not seed the throw-away notification (HTTP ${result.status}): ${JSON.stringify(result.json).slice(0, 300)}`,
    );
  }
}

async function cleanup() {
  console.log('\n--- cleanup ---');
  for (const path of [
    `/notifications/${uid}-rulecheck`,
    `/notifications/${uid}-client`,
    `/notifications/${uid}-forged`,
    `/payments/${uid}-rulecheck`,
    `/commissionInvoices/INV-${uid}-rulecheck`,
    `/rooms/${uid}-rulecheck`,
    `/rooms/${uid}-rulecheck-initial`,
    `/rooms/${uid}-rulecheck-status`,
    `/rooms/${uid}-rulecheck-occupied`,
    `/joinRequests/${uid}-rulecheck`,
    `/users/${uid}`,
  ]) {
    const r = await adminFs('DELETE', path);
    console.log(`  deleted ${path.split('/')[1]} -> HTTP ${r.status}`);
  }
  const d = await auth('/accounts:delete', { idToken: token });
  console.log(`  deleted auth account -> HTTP ${d.status}`);
}

async function main() {
  console.log(`--- creating a throw-away account (${EMAIL}) ---`);
  const signUp = await auth('/accounts:signUp', {
    email: EMAIL,
    password: PASSWORD,
    returnSecureToken: true,
  });
  if (signUp.status !== 200) {
    console.error('Could not create the throw-away account:', JSON.stringify(signUp.json));
    process.exit(2);
  }
  token = signUp.json.idToken;
  uid = signUp.json.localId;
  console.log(`  uid = ${uid}`);
  console.log('  (a fresh account has NO custom claims — no `admin` claim)');

  console.log('\n--- preparing a live owner profile (server-side channel) ---');
  adminToken = firebaseCliToken();
  await prepareLiveOwner();
  await seedNotification();
  console.log('  the throw-away account is now a live, registered owner');

  console.log('\n--- joinRequests are server owned ---');
  const fakeCreate = await fs('PATCH', `/joinRequests/${uid}-rulecheck`, {
    fields: {
      requestId: { stringValue: `${uid}-rulecheck` },
      roomId: { stringValue: 'room-x' },
      studentId: { stringValue: uid },
      ownerId: { stringValue: 'owner-x' },
      status: { stringValue: 'pending' },
      monthlyRentAtJoin: { doubleValue: 10000 },
      commissionPercentageAtJoin: { doubleValue: 30 },
      advancePaid: { booleanValue: true },
      advancePaymentStatus: { stringValue: 'verified' },
    },
  });
  check('creating a request with advancePaid=true is denied', denied(fakeCreate), `HTTP ${fakeCreate.status}`);

  const honestCreate = await fs('PATCH', `/joinRequests/${uid}-rulecheck`, {
    fields: {
      requestId: { stringValue: `${uid}-rulecheck` },
      roomId: { stringValue: 'room-x' },
      studentId: { stringValue: uid },
      ownerId: { stringValue: 'owner-x' },
      status: { stringValue: 'pending' },
      monthlyRentAtJoin: { doubleValue: 10000 },
      commissionPercentageAtJoin: { doubleValue: 30 },
      advancePaid: { booleanValue: false },
      advancePaymentStatus: { nullValue: null },
    },
  });
  // The join requests are **server owned**: a client cannot create one at
  // all, not even an honest one. The request is written by the callable
  // `createJoinRequest`, so the rent, the owner and the commission cannot
  // be forged by a modified client.
  check('a client cannot create a join request at all', denied(honestCreate), `HTTP ${honestCreate.status}`);

  console.log('\n--- joinRequests: the status transitions ---');
  // The Flutter SDK sends a merge, which is a PATCH with an update mask.
  const merge = (fields) => {
    const mask = Object.keys(fields)
      .map((k) => `updateMask.fieldPaths=${k}`)
      .join('&');
    return fs('PATCH', `/joinRequests/${uid}-rulecheck?${mask}`, { fields });
  };
  const setStatus = (status) => merge({ status: { stringValue: status } });

  const adminReviewed = await setStatus('adminReviewed');
  check('the student cannot set adminReviewed themselves',
    denied(adminReviewed), `HTTP ${adminReviewed.status}`);
  const studentConfirmed = await setStatus('studentConfirmed');
  check('the student cannot skip the owner approval',
    denied(studentConfirmed), `HTTP ${studentConfirmed.status}`);
  const advancePaid = await merge({ advancePaid: { booleanValue: true } });
  check('the student cannot write advancePaid',
    denied(advancePaid), `HTTP ${advancePaid.status}`);
  const advancePaymentStatus = await merge({ advancePaymentStatus: { stringValue: 'verified' } });
  check('the student cannot write advancePaymentStatus',
    denied(advancePaymentStatus), `HTTP ${advancePaymentStatus.status}`);
  const bookkeeping = await merge({ updatedAt: { timestampValue: new Date().toISOString() } });
  // The documents are **server owned** — a client cannot change anything,
  // not even a harmless bookkeeping field. The cancellation is done by the
  // callable `cancelJoinRequest`.
  check('the student cannot update a join request at all',
    denied(bookkeeping), `HTTP ${bookkeeping.status}`);
  const cancelled = await setStatus('cancelled');
  check('the student cannot cancel the request from the client',
    denied(cancelled), `HTTP ${cancelled.status}`);
  const deleteRequest = await fs('DELETE', `/joinRequests/${uid}-rulecheck`);
  check('the student cannot delete a join request from the client',
    denied(deleteRequest), `HTTP ${deleteRequest.status}`);

  console.log('\n--- payments collection ---');
  const writePayment = await fs('PATCH', `/payments/${uid}-rulecheck`, {
    fields: {
      requestId: { stringValue: 'x' },
      studentId: { stringValue: uid },
      amount: { doubleValue: 3000 },
      status: { stringValue: 'verified' },
    },
  });
  check('a client cannot write a payment', denied(writePayment), `HTTP ${writePayment.status}`);
  check('a client cannot list all payments', denied(await fs('GET', `/payments`)));
  const ownPayments = await runQuery({
    from: [{ collectionId: 'payments' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'studentId' },
        op: 'EQUAL',
        value: { stringValue: uid },
      },
    },
    orderBy: [{ field: { fieldPath: 'submittedAt' }, direction: 'DESCENDING' }],
  });
  check('a student may list their own payments (filtered)', ownPayments.status === 200,
    `HTTP ${ownPayments.status}`);
  const otherPayments = await runQuery({
    from: [{ collectionId: 'payments' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'studentId' },
        op: 'EQUAL',
        value: { stringValue: 'somebody-else' },
      },
    },
    orderBy: [{ field: { fieldPath: 'submittedAt' }, direction: 'DESCENDING' }],
  });
  check('a client cannot list payments filtered to somebody else',
    denied(otherPayments), `HTTP ${otherPayments.status}`);

  console.log('\n--- otpCodes are server only ---');
  check('a client cannot read otpCodes', denied(await fs('GET', `/otpCodes`)));
  const writeOtp = await fs('PATCH', `/otpCodes/email_probe`, {
    fields: { verified: { booleanValue: true } },
  });
  check('a client cannot write otpCodes', denied(writeOtp), `HTTP ${writeOtp.status}`);

  console.log('\n--- notifications are server owned ---');
  const createNotification = await fs('PATCH', `/notifications/${uid}-client`, {
    fields: {
      userId: { stringValue: uid },
      title: { stringValue: 'forged' },
      body: { stringValue: 'forged' },
      type: { stringValue: 'general' },
      read: { booleanValue: false },
      createdAt: { timestampValue: new Date().toISOString() },
    },
  });
  check('creating a notification is denied (the backend owns the content)',
    denied(createNotification), `HTTP ${createNotification.status}`);
  const ownNotification = await fs('GET', `/notifications/${uid}-rulecheck`);
  check('reading own notification is allowed', ownNotification.status === 200,
    `HTTP ${ownNotification.status}`);
  const ownNotifs = await runQuery({
    from: [{ collectionId: 'notifications' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'userId' },
        op: 'EQUAL',
        value: { stringValue: uid },
      },
    },
    orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
  });
  check('listing own notifications (the query the app uses) is allowed',
    ownNotifs.status === 200, `HTTP ${ownNotifs.status}`);
  check('listing notifications without a filter is denied',
    denied(await fs('GET', `/notifications`)));
  const markRead = await fs('PATCH', `/notifications/${uid}-rulecheck?updateMask.fieldPaths=read`, {
    fields: { read: { booleanValue: true } },
  });
  check('marking own notification read is allowed', markRead.status === 200, `HTTP ${markRead.status}`);
  const tamper = await fs('PATCH', `/notifications/${uid}-rulecheck?updateMask.fieldPaths=title`, {
    fields: { title: { stringValue: 'tampered' } },
  });
  check('changing the content of a notification is denied', denied(tamper), `HTTP ${tamper.status}`);
  const deleteNotification = await fs('DELETE', `/notifications/${uid}-rulecheck`);
  check('deleting a notification is denied (the backend owns the deletion)',
    denied(deleteNotification), `HTTP ${deleteNotification.status}`);

  console.log('\n--- users and rooms (the rules that mention isAdmin()) ---');
  const updateProfile = await fs('PATCH', `/users/${uid}?updateMask.fieldPaths=name`, {
    fields: { name: { stringValue: 'Rule Check One' } },
  });
  check('a user may update their own name', updateProfile.status === 200, `HTTP ${updateProfile.status}`);
  const updatePhone = await fs('PATCH', `/users/${uid}?updateMask.fieldPaths=phone`, {
    fields: { phone: { stringValue: '+919999999999' } },
  });
  check('a user may update their own phone', updatePhone.status === 200, `HTTP ${updatePhone.status}`);
  const escalate = await fs('PATCH', `/users/${uid}?updateMask.fieldPaths=role`, {
    fields: { role: { stringValue: 'admin' } },
  });
  check('a user may NOT promote themselves to admin', denied(escalate), `HTTP ${escalate.status}`);
  // `isActive` is not part of the self-update whitelist. Writing `true`
  // would be a no-op — the diff would not contain the field and the rule
  // would never be evaluated. Writing `false` is a real change and must
  // therefore be denied.
  const reactivate = await fs('PATCH', `/users/${uid}?updateMask.fieldPaths=isActive`, {
    fields: { isActive: { booleanValue: false } },
  });
  check('a user may NOT change their own isActive flag', denied(reactivate), `HTTP ${reactivate.status}`);
  const rewriteSaved = await fs('PATCH', `/users/${uid}?updateMask.fieldPaths=savedRooms`, {
    fields: { savedRooms: { arrayValue: { values: [] } } },
  });
  check('a user may write their own savedRooms', rewriteSaved.status === 200, `HTTP ${rewriteSaved.status}`);
  const deleteProfile = await fs('DELETE', `/users/${uid}`);
  check('a user may NOT delete their own profile directly', denied(deleteProfile), `HTTP ${deleteProfile.status}`);

  const roomId = `${uid}-rulecheck`;
  const createRoom = await fs('PATCH', `/rooms/${roomId}`, {
    fields: {
      roomId: { stringValue: roomId },
      title: { stringValue: 'Rule Check Room' },
      ownerId: { stringValue: uid },
      monthlyRent: { doubleValue: 10000 },
      occupancy: { integerValue: '2' },
    },
  });
  check('an owner may create their own room (without the server-owned fields)',
    createRoom.status === 200, `HTTP ${createRoom.status}`);
  const createRoomWithInitialState = await fs('PATCH', `/rooms/${roomId}-initial`, {
    fields: {
      roomId: { stringValue: `${roomId}-initial` },
      title: { stringValue: 'Rule Check Room' },
      ownerId: { stringValue: uid },
      monthlyRent: { doubleValue: 10000 },
      occupancy: { integerValue: '2' },
      status: { stringValue: 'available' },
      currentOccupancy: { integerValue: '0' },
    },
  });
  check('an owner may send the initial server-owned state on create',
    createRoomWithInitialState.status === 200, `HTTP ${createRoomWithInitialState.status}`);
  const createRoomWithStatus = await fs('PATCH', `/rooms/${roomId}-status`, {
    fields: {
      roomId: { stringValue: `${roomId}-status` },
      title: { stringValue: 'Rule Check Room' },
      ownerId: { stringValue: uid },
      monthlyRent: { doubleValue: 10000 },
      occupancy: { integerValue: '2' },
      status: { stringValue: 'occupied' },
    },
  });
  check('an owner may NOT create a room that is already occupied',
    denied(createRoomWithStatus), `HTTP ${createRoomWithStatus.status}`);
  const updateRoom = await fs('PATCH', `/rooms/${roomId}?updateMask.fieldPaths=title`, {
    fields: { title: { stringValue: 'Rule Check Room (renamed)' } },
  });
  check('an owner may update their own room', updateRoom.status === 200, `HTTP ${updateRoom.status}`);
  const updateStatus = await fs('PATCH', `/rooms/${roomId}?updateMask.fieldPaths=status`, {
    fields: { status: { stringValue: 'occupied' } },
  });
  check('an owner may NOT change the listing status directly',
    denied(updateStatus), `HTTP ${updateStatus.status}`);
  const updateOccupancy = await fs('PATCH', `/rooms/${roomId}?updateMask.fieldPaths=currentOccupancy`, {
    fields: { currentOccupancy: { integerValue: '1' } },
  });
  check('an owner may NOT change the occupancy counter directly',
    denied(updateOccupancy), `HTTP ${updateOccupancy.status}`);
  const deleteRoom = await fs('DELETE', `/rooms/${roomId}`);
  check('an owner may NOT delete a room directly (deleteRoomListing is server-owned)',
    denied(deleteRoom), `HTTP ${deleteRoom.status}`);

  console.log('\n--- publicSettings is readable before signing in ---');
  const anonRead = await fsAnon('GET', '/publicSettings/platform');
  check('publicSettings can be read without a token',
    anonRead.status === 200 || anonRead.status === 404, `HTTP ${anonRead.status}`);
  const anonWrite = await fsAnon('PATCH', '/publicSettings/platform', {
    fields: { maintenanceMode: { booleanValue: true } },
  });
  check('publicSettings cannot be written without a token', denied(anonWrite), `HTTP ${anonWrite.status}`);
  const userWrite = await fs('PATCH', '/publicSettings/platform', {
    fields: { maintenanceMode: { booleanValue: true } },
  });
  check('publicSettings cannot be written by a regular user', denied(userWrite), `HTTP ${userWrite.status}`);

  console.log('\n--- commission invoices are server owned ---');
  const forgeInvoice = await fs('PATCH', `/commissionInvoices/INV-${uid}-rulecheck`, {
    fields: {
      invoiceId: { stringValue: `INV-${uid}-rulecheck` },
      ownerId: { stringValue: uid },
      tenantId: { stringValue: uid },
      commissionAmount: { doubleValue: 3000 },
      status: { stringValue: 'paid' },
    },
  });
  check('a regular user cannot create a commission invoice', denied(forgeInvoice), `HTTP ${forgeInvoice.status}`);

  console.log('\n--- the immutable fields of a join request ---');
  const rewriteRent = await fs('PATCH', `/joinRequests/${uid}-rulecheck?updateMask.fieldPaths=monthlyRentAtJoin`, {
    fields: { monthlyRentAtJoin: { doubleValue: 1 } },
  });
  check('a student cannot rewrite the rent of their request', denied(rewriteRent), `HTTP ${rewriteRent.status}`);
  const rewriteCommission = await fs('PATCH', `/joinRequests/${uid}-rulecheck?updateMask.fieldPaths=commissionPercentageAtJoin`, {
    fields: { commissionPercentageAtJoin: { doubleValue: 0 } },
  });
  check('a student cannot set the commission of their request to 0 %', denied(rewriteCommission), `HTTP ${rewriteCommission.status}`);
  const rewriteOwner = await fs('PATCH', `/joinRequests/${uid}-rulecheck?updateMask.fieldPaths=ownerId`, {
    fields: { ownerId: { stringValue: uid } },
  });
  check('a student cannot make themselves the owner of the request', denied(rewriteOwner), `HTTP ${rewriteOwner.status}`);

  console.log('\n--- notifications for other users are server only ---');
  const forgeNotification = await fs('PATCH', `/notifications/${uid}-forged`, {
    fields: {
      userId: { stringValue: 'somebody-else' },
      title: { stringValue: 'forged' },
      body: { stringValue: 'forged' },
      type: { stringValue: 'adminReview' },
    },
  });
  check('a client cannot create a notification for somebody else', denied(forgeNotification), `HTTP ${forgeNotification.status}`);

  console.log('\n--- the rooms collection is clean ---');
  // The client may not delete a room any more, so both throw-away listings
  // are removed through the server-side channel before the collection is
  // inspected.
  for (const path of [`/rooms/${roomId}`, `/rooms/${roomId}-status`]) {
    const removed = await adminFs('DELETE', path);
    console.log(`  removed ${path} (server channel) -> HTTP ${removed.status}`);
  }
  const rooms = await fs('GET', `/rooms?pageSize=300`);
  const roomDocs = rooms.json.documents || [];
  // The database holds the **real** listings of the real users — only the
  // throw-away listing of this very run must be gone. A check that counts
  // every room would fail as soon as a real user has a room.
  const leftovers = roomDocs.filter((doc) =>
    doc.name.includes(`${uid}-rulecheck`) ||
    doc.name.includes('-rulecheck') ||
    doc.name.includes('-demo') ||
    doc.name.includes('-test'),
  );
  check('there are no demo rooms in Firestore', leftovers.length === 0,
    `${leftovers.length} leftover(s) of ${roomDocs.length} room(s)`);

  await cleanup();

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('ERROR:', e);
  try { await cleanup(); } catch (_) { /* ignore */ }
  process.exit(2);
});
