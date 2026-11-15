// Live end-to-end test of the StayServe booking / payment / notification /
// account-deletion flow against the DEPLOYED backend.
//
// It creates two throw-away accounts (a student and an owner), runs the
// whole flow and removes everything it created again.
//
//   node e2e_live.mjs
//
// Nothing of the real users is touched.

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
const STUDENT_EMAIL = `e2e.student.${STAMP}@example.com`;
const OWNER_EMAIL = `e2e.owner.${STAMP}@example.com`;
const PASSWORD = 'TmpE2E!2026x';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? '  (' + detail + ')' : ''}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firebaseToken() {
  try {
    execFileSync('firebase', ['projects:list', '--project', PROJ], {
      stdio: 'ignore',
      timeout: 120000,
    });
  } catch {
    // The CLI may not be on PATH — try the stored token anyway.
  }
  const p = path.join(os.homedir(), '.config/configstore/firebase-tools.json');
  const store = JSON.parse(fs.readFileSync(p, 'utf8'));
  const tok = store.tokens?.access_token;
  if (!tok) throw new Error('No firebase-tools OAuth token found');
  return tok;
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

/** The admin endpoints of the Identity Toolkit — they need the OAuth token. */
async function adminIdentity(pathname, body) {
  const res = await fetch(`${AUTH}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${firebaseToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

/** The claims of an ID token. */
function claimsOf(idToken) {
  try {
    return JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'),
    );
  } catch {
    return {};
  }
}

async function signUp(email) {
  const res = await identity('/accounts:signUp', {
    email,
    password: PASSWORD,
    returnSecureToken: true,
  });
  if (res.status !== 200) {
    throw new Error(`signUp failed: ${JSON.stringify(res.json).slice(0, 300)}`);
  }
  return { uid: res.json.localId, idToken: res.json.idToken };
}

async function signIn(email) {
  const res = await identity('/accounts:signInWithPassword', {
    email,
    password: PASSWORD,
    returnSecureToken: true,
  });
  if (res.status !== 200) {
    throw new Error(`signIn failed: ${JSON.stringify(res.json).slice(0, 300)}`);
  }
  return { uid: res.json.localId, idToken: res.json.idToken };
}

async function call(fnName, idToken, data) {
  const res = await fetch(`${FN}/${fnName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function fsRead(oauth, docPath) {
  const res = await fetch(`${BASE}/${docPath}`, {
    headers: { Authorization: `Bearer ${oauth}` },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function fsWrite(oauth, docPath, fields) {
  const res = await fetch(`${BASE}/${docPath}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${oauth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function fsList(oauth, collection) {
  const res = await fetch(`${BASE}/${collection}?pageSize=300`, {
    headers: { Authorization: `Bearer ${oauth}` },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, docs: json.documents || [] };
}

/** Reads a field out of a Firestore REST document. */
function field(doc, key) {
  if (!doc) return null;
  const v = (doc.fields || {})[key] || {};
  for (const kind of [
    'stringValue',
    'doubleValue',
    'booleanValue',
    'integerValue',
    'timestampValue',
  ]) {
    if (kind in v) return v[kind];
  }
  return null;
}

/** The error message of a callable that refused to run. */
function errorOf(res) {
  return (
    res.json?.error?.message ||
    res.json?.error?.status ||
    res.json?.raw ||
    JSON.stringify(res.json).slice(0, 200)
  );
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

let oauth;
let student;
let owner;
let roomId = `E2E-ROOM-${STAMP}`;
let roomId2 = `E2E-ROOM2-${STAMP}`;
let roomId3 = `E2E-ROOM3-${STAMP}`;
let requestId = null;

/**
 * Who settles the platform fee.
 *
 * The admin can switch between "the owner pays" and "the student pays" in
 * Admin → Settings. The test used to assume "the owner pays" — so it
 * failed as soon as the switch was flipped in the production settings. The
 * setting is read now and the test follows it.
 */
async function readFeePayer() {
  const res = await fsRead(oauth, 'settings/platform');
  const payer = field(res.json, 'feePayer');
  return payer === 'student' ? 'student' : 'owner';
}

/**
 * Writes a throw-away listing of the owner.
 *
 * The test needs more than one room: the booking of the main room runs all
 * the way to an active booking, and the cancellation after the approval
 * needs a booking of its own.
 */
async function createRoom(id) {
  const now = new Date().toISOString();
  const write = await fsWrite(oauth, `rooms/${id}`, {
    roomId: { stringValue: id },
    ownerId: { stringValue: owner.uid },
    title: { stringValue: `E2E test listing ${id}` },
    description: { stringValue: 'A throw-away listing for the end-to-end test' },
    monthlyRent: { doubleValue: 10000 },
    securityDeposit: { doubleValue: 20000 },
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
  return write;
}

async function main() {
  oauth = firebaseToken();

  const feePayer = await readFeePayer();
  section(`the platform fee is paid by the ${feePayer}`);

  section('the throw-away accounts');
  student = await signUp(STUDENT_EMAIL);
  owner = await signUp(OWNER_EMAIL);
  check('the student account was created', !!student.uid, student.uid);
  check('the owner account was created', !!owner.uid, owner.uid);

  // The student account is promoted to admin so that the admin-only
  // callables can be exercised. It is demoted again in the cleanup.
  console.log('  ... promoting the student account to admin');
  const promotion = execFileSync(
    'node',
    [path.join(process.cwd(), 'tools', 'make_admin.mjs'), '--uid', student.uid, '--role', 'admin'],
    { encoding: 'utf8', timeout: 180000 },
  );
  console.log(
    promotion
      .split('\n')
      .filter((line) => line.trim().startsWith('custom claims'))
      .join('\n'),
  );

  // The claim needs a moment: a token that is minted right after the write
  // still carries the old claims. Sign in again until the admin claim is
  // really in the token.
  //
  // The `onUserCreate` trigger of the server writes the claims of a fresh
  // account as well — and it may run *after* the promotion (the trigger is
  // asynchronous). It then takes the admin claim away again, so the
  // promotion is repeated until it sticks.
  let adminClaim = false;
  let lastClaims = {};
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    student = await signIn(STUDENT_EMAIL);
    const claims = claimsOf(student.idToken);
    lastClaims = claims;
    if (claims.admin === true) {
      adminClaim = true;
      break;
    }

    // The claim was taken away again — promote the account once more.
    execFileSync(
      'node',
      [path.join(process.cwd(), 'tools', 'make_admin.mjs'), '--uid', student.uid, '--role', 'admin'],
      { encoding: 'utf8', timeout: 180000 },
    );
  }
  check(
    'the student account is an admin now',
    adminClaim,
    `claims: ${JSON.stringify(lastClaims).slice(0, 200)}`,
  );

  section('the listing of the owner');
  const write = await createRoom(roomId);
  check('the listing was written', write.status === 200, `HTTP ${write.status}`);

  const write2 = await createRoom(roomId2);
  check('the second listing was written', write2.status === 200, `HTTP ${write2.status}`);

  const write3 = await createRoom(roomId3);
  check('the third listing was written', write3.status === 200, `HTTP ${write3.status}`);

  section('the booking request');
  const created = await call('createJoinRequest', student.idToken, { roomId });
  check('the student could request to join', created.status === 200, errorOf(created));
  requestId = created.json?.result?.requestId || created.json?.requestId || null;
  check('the request has an id', !!requestId, requestId || '');

  // The owner must not be able to book their own room.
  const ownRoom = await call('createJoinRequest', owner.idToken, { roomId });
  check(
    'the owner cannot book their own room',
    ownRoom.status !== 200,
    errorOf(ownRoom),
  );

  section('the review and the address are locked before the approval');
  // The request is still `pending` — the owner has not accepted it yet.
  const earlyReview = await call('submitRoomReview', student.idToken, {
    roomId,
    rating: 5,
    comment: 'Too early',
  });
  check(
    'a student cannot review a room before the approval',
    earlyReview.status !== 200,
    errorOf(earlyReview),
  );

  const earlyVisit = await call('getRoomVisitDetails', student.idToken, { roomId });
  check(
    'a student cannot see the address before the approval',
    earlyVisit.status !== 200,
    errorOf(earlyVisit),
  );

  const ownerReview = await call('submitRoomReview', owner.idToken, {
    roomId,
    rating: 1,
    comment: 'My own room',
  });
  check(
    'the owner cannot review their own room',
    ownerReview.status !== 200,
    errorOf(ownerReview),
  );

  section('the notifications of the request');
  let notifs = await fsList(oauth, 'notifications');
  const forOwner = notifs.docs.filter((d) => field(d, 'userId') === owner.uid);
  const forStudent = notifs.docs.filter((d) => field(d, 'userId') === student.uid);
  check('the owner was notified', forOwner.length > 0, `${forOwner.length} notification(s)`);
  check('the student was notified', forStudent.length > 0, `${forStudent.length} notification(s)`);

  section('the approval of the owner');
  const approved = await call('respondToJoinRequest', owner.idToken, {
    requestId,
    approve: true,
  });
  check('the owner could approve', approved.status === 200, errorOf(approved));

  let request = (await fsRead(oauth, `joinRequests/${requestId}`)).json;
  check(
    'the request is owner confirmed',
    field(request, 'status') === 'ownerConfirmed',
    field(request, 'status'),
  );
  check(
    'the fee is not paid yet',
    field(request, 'advancePaid') === false,
    String(field(request, 'advancePaid')),
  );
  check(
    `the platform fee is paid by the ${feePayer}`,
    field(request, 'platformFeePayer') === feePayer,
    field(request, 'platformFeePayer'),
  );

  section('the address and the review after the approval');
  // The owner accepted the request — from now on the student knows where
  // the room is and may review it.
  const visit = await call('getRoomVisitDetails', student.idToken, { roomId });
  check('the student gets the address', visit.status === 200, errorOf(visit));
  const visitData = visit.json?.result || visit.json || {};
  check(
    'the address is the one of the listing',
    String(visitData.address || '').includes('MG Road'),
    String(visitData.address),
  );
  check(
    'the full address is made up of all the parts',
    String(visitData.fullAddress || '').includes('Bengaluru') &&
      String(visitData.fullAddress || '').includes('560001'),
    String(visitData.fullAddress),
  );
  check(
    'the coordinates come with the address',
    Number(visitData.latitude) === 12.9716 &&
      Number(visitData.longitude) === 77.5946,
    `${visitData.latitude},${visitData.longitude}`,
  );

  const ownerVisit = await call('getRoomVisitDetails', owner.idToken, { roomId });
  check(
    'the owner does not need the visit details',
    ownerVisit.status !== 200,
    errorOf(ownerVisit),
  );

  const review = await call('submitRoomReview', student.idToken, {
    roomId,
    rating: 5,
    comment: 'The room is bright and the rent is fair',
  });
  check('the student can review the room now', review.status === 200, errorOf(review));

  const reviewId = `REV-${roomId}-${student.uid}`;
  let reviewDoc = (await fsRead(oauth, `roomReviews/${reviewId}`)).json;
  check('the review was written', !!field(reviewDoc, 'reviewId'), field(reviewDoc, 'reviewId'));
  check('the rating was stored', Number(field(reviewDoc, 'rating')) === 5, String(field(reviewDoc, 'rating')));
  check(
    'the review belongs to the student',
    field(reviewDoc, 'studentId') === student.uid,
    field(reviewDoc, 'studentId'),
  );
  check(
    // The id of the booking request is the internal bookkeeping of the
    // booking — it is not part of the public review.
    'the review does not leak the booking request',
    !field(reviewDoc, 'joinRequestId'),
    field(reviewDoc, 'joinRequestId'),
  );

  const ownerReviews = await call('submitRoomReview', owner.idToken, {
    roomId,
    rating: 1,
    comment: 'My own room',
  });
  check(
    'the owner cannot review their own room',
    ownerReviews.status !== 200,
    errorOf(ownerReviews),
  );

  const badRating = await call('submitRoomReview', student.idToken, {
    roomId,
    rating: 9,
    comment: 'Too good to be true',
  });
  check('a rating out of range is refused', badRating.status !== 200, errorOf(badRating));

  const longComment = await call('submitRoomReview', student.idToken, {
    roomId,
    rating: 4,
    comment: 'x'.repeat(501),
  });
  check('a comment that is too long is refused', longComment.status !== 200, errorOf(longComment));

  // A second review **replaces** the first one — a student has one review
  // per room.
  const secondReview = await call('submitRoomReview', student.idToken, {
    roomId,
    rating: 4,
    comment: 'Still a good room',
  });
  check('the review can be changed', secondReview.status === 200, errorOf(secondReview));
  reviewDoc = (await fsRead(oauth, `roomReviews/${reviewId}`)).json;
  check(
    'there is still only one review of the student',
    Number(field(reviewDoc, 'rating')) === 4,
    String(field(reviewDoc, 'rating')),
  );

  const reviewNotifs = (await fsList(oauth, 'notifications')).docs.filter(
    (d) => field(d, 'userId') === owner.uid && field(d, 'type') === 'review',
  );
  check(
    'the owner was told about the review',
    reviewNotifs.length > 0,
    `${reviewNotifs.length} notification(s)`,
  );

  const deletedReview = await call('deleteRoomReview', student.idToken, { roomId });
  check('the student can take the review back', deletedReview.status === 200, errorOf(deletedReview));
  const goneReview = await fsRead(oauth, `roomReviews/${reviewId}`);
  check('the review is gone', goneReview.status === 404, `HTTP ${goneReview.status}`);

  section('the payment option on both sides');
  const ownerIntent = await call('createUpiPayment', owner.idToken, {
    joinRequestId: requestId,
  });
  check('the owner can open the payment sheet', ownerIntent.status === 200, errorOf(ownerIntent));
  const ownerData = ownerIntent.json?.result || ownerIntent.json || {};
  check(
    `the owner ${feePayer === 'owner' ? 'has to pay' : 'does not have to pay'}`,
    ownerData.youPay === (feePayer === 'owner'),
    String(ownerData.youPay),
  );
  check(
    `the student ${feePayer === 'student' ? 'has to pay' : 'does not have to pay'}`,
    ownerData.studentPays === (feePayer === 'student'),
    String(ownerData.studentPays),
  );
  check(
    'the payee is the platform UPI',
    ownerData.payeeVpa === 'shauryaprataprai461-2@oksbi',
    ownerData.payeeVpa,
  );
  check(
    'the amount is 30% of the rent',
    Number(ownerData.amount) === 3000,
    String(ownerData.amount),
  );

  const studentIntent = await call('createUpiPayment', student.idToken, {
    joinRequestId: requestId,
  });
  check('the student can open the payment sheet too', studentIntent.status === 200, errorOf(studentIntent));
  const studentData = studentIntent.json?.result || studentIntent.json || {};
  check(
    `the student ${feePayer === 'student' ? 'has to pay' : 'does not have to pay'}`,
    studentData.youPay === (feePayer === 'student'),
    String(studentData.youPay),
  );

  // The UPI intent has to stay **within the limits of the UPI
  // specification** — an intent that is too long is refused by the UPI app
  // with a misleading "the amount exceeds the limit".
  if (studentData.uri) {
    const params = new URLSearchParams(studentData.uri.split('?')[1] || '');
    const note = params.get('tn') || '';
    const ref = params.get('tr') || '';
    check(
      'the transaction note of the intent is not too long',
      note.length > 0 && note.length <= 50,
      `"${note}" (${note.length} characters)`,
    );
    check(
      'the transaction reference of the intent is not too long',
      ref.length > 0 && ref.length <= 40,
      `"${ref}" (${ref.length} characters)`,
    );
    check(
      'the intent carries the right amount',
      params.get('am') === '3000.00',
      String(params.get('am')),
    );
    check(
      'the intent carries the platform UPI',
      params.get('pa') === 'shauryaprataprai461-2@oksbi',
      String(params.get('pa')),
    );
  }

  section('the payment books the room');
  // The party that settles the fee is the one that pays it.
  const payerSession = feePayer === 'owner' ? owner : student;
  const paid = await call('submitPayment', payerSession.idToken, {
    requestId,
    reference: `E2E${STAMP}`,
    method: 'upi',
  });
  check('the payment was accepted', paid.status === 200, errorOf(paid));

  request = (await fsRead(oauth, `joinRequests/${requestId}`)).json;
  check(
    'the booking is confirmed right away',
    field(request, 'status') === 'adminReviewed',
    field(request, 'status'),
  );
  check(
    'the advance is marked as paid',
    field(request, 'advancePaid') === true,
    String(field(request, 'advancePaid')),
  );
  check(
    'the platform cut was taken once',
    field(request, 'platformCutTaken') === true,
    String(field(request, 'platformCutTaken')),
  );
  check(
    'the invoice was created',
    !!field(request, 'invoiceId'),
    field(request, 'invoiceId'),
  );

  const invoices = await fsList(oauth, 'commissionInvoices');
  const invoice = invoices.docs.find((d) => field(d, 'joinRequestId') === requestId);
  check('the commission invoice exists', !!invoice, invoice ? field(invoice, 'invoiceId') : 'missing');
  if (invoice) {
    check(
      'the invoice is for 30%',
      Number(field(invoice, 'commissionAmount')) === 3000,
      String(field(invoice, 'commissionAmount')),
    );
  }

  const room = (await fsRead(oauth, `rooms/${roomId}`)).json;
  check(
    'the room took the tenant into account',
    Number(field(room, 'currentOccupancy')) === 1,
    String(field(room, 'currentOccupancy')),
  );

  const payments = await fsList(oauth, 'payments');
  const payment = payments.docs.find((d) => field(d, 'requestId') === requestId);
  check('the payment was recorded', !!payment, payment ? field(payment, 'reference') : 'missing');
  check(
    'the payment waits for the admin',
    field(payment, 'status') === 'submitted',
    field(payment, 'status'),
  );

  section('a booking with money in it cannot be cancelled');
  const paidCancel = await call('cancelJoinRequest', student.idToken, { requestId });
  check(
    'the student cannot cancel a booking that was paid for',
    paidCancel.status !== 200,
    errorOf(paidCancel),
  );
  const paidOwnerCancel = await call('cancelJoinRequest', owner.idToken, { requestId });
  check(
    'the owner cannot cancel a booking that was paid for',
    paidOwnerCancel.status !== 200,
    errorOf(paidOwnerCancel),
  );
  request = (await fsRead(oauth, `joinRequests/${requestId}`)).json;
  check(
    'the booking is still alive',
    field(request, 'status') === 'adminReviewed',
    field(request, 'status'),
  );

  section('the notifications of the payment');
  notifs = await fsList(oauth, 'notifications');
  const ownerAfterPay = notifs.docs.filter((d) => field(d, 'userId') === owner.uid);
  const studentAfterPay = notifs.docs.filter((d) => field(d, 'userId') === student.uid);
  check(
    'the owner has more than one notification',
    ownerAfterPay.length > 1,
    `${ownerAfterPay.length} notification(s)`,
  );
  check(
    'the student has more than one notification',
    studentAfterPay.length > 1,
    `${studentAfterPay.length} notification(s)`,
  );
  check(
    'a notification mentions the booking',
    ownerAfterPay.some((d) =>
      String(field(d, 'title') || '').toLowerCase().includes('booking'),
    ),
    ownerAfterPay.map((d) => field(d, 'title')).join(' | '),
  );

  section('the type of the notifications');
  // The push message has to carry the type of the notification — without it
  // the app cannot tell which screen the notification belongs to and the
  // tap on the push message does nothing.
  const types = new Set(
    [...ownerAfterPay, ...studentAfterPay].map((d) => String(field(d, 'type') || '')),
  );
  check(
    'the notifications carry a type',
    types.size > 0 && ![...types].some((t) => t === ''),
    [...types].join(' | '),
  );
  check(
    'the notifications are not all "general"',
    ![...types].every((t) => t === 'general'),
    [...types].join(' | '),
  );

  section('the verification by the admin');
  const verified = await call('verifyPayment', student.idToken, {
    requestId,
    approve: true,
    note: 'E2E',
  });
  check('the admin could verify the payment', verified.status === 200, errorOf(verified));

  const paymentsAfter = await fsList(oauth, 'payments');
  const verifiedPayment = paymentsAfter.docs.find((d) => field(d, 'requestId') === requestId);
  check(
    'the payment is verified',
    field(verifiedPayment, 'status') === 'verified',
    field(verifiedPayment, 'status'),
  );

  section('the second payment goes straight to the owner');
  const second = await call('createUpiPayment', owner.idToken, {
    joinRequestId: requestId,
  });
  const secondData = second.json?.result || second.json || {};
  check(
    'the cut is not taken a second time',
    secondData.alreadySettled === true,
    String(secondData.alreadySettled),
  );
  check(
    'nobody has to pay the platform again',
    secondData.youPay === false,
    String(secondData.youPay),
  );

  section('the student cancels a booking the owner accepted');
  // A second booking — the first one is already active and cannot be
  // cancelled any more.
  const created2 = await call('createJoinRequest', student.idToken, { roomId: roomId2 });
  check('the student could request the second room', created2.status === 200, errorOf(created2));
  const requestId2 = created2.json?.result?.requestId || created2.json?.requestId || null;

  const approved2 = await call('respondToJoinRequest', owner.idToken, {
    requestId: requestId2,
    approve: true,
  });
  check('the owner could approve the second request', approved2.status === 200, errorOf(approved2));

  let request2 = (await fsRead(oauth, `joinRequests/${requestId2}`)).json;
  check(
    'the second request is owner confirmed',
    field(request2, 'status') === 'ownerConfirmed',
    field(request2, 'status'),
  );

  const cancelled2 = await call('cancelJoinRequest', student.idToken, {
    requestId: requestId2,
    reason: 'Found something closer',
  });
  check(
    'the student can cancel a booking the owner accepted',
    cancelled2.status === 200,
    errorOf(cancelled2),
  );

  request2 = (await fsRead(oauth, `joinRequests/${requestId2}`)).json;
  check(
    'the request is cancelled',
    field(request2, 'status') === 'cancelled',
    field(request2, 'status'),
  );
  check(
    'the cancellation is recorded',
    !!field(request2, 'cancelledAt'),
    String(field(request2, 'cancelledAt')),
  );
  check(
    'the reason of the cancellation is recorded',
    field(request2, 'cancellationReason') === 'Found something closer',
    String(field(request2, 'cancellationReason')),
  );

  const cancelNotifs = (await fsList(oauth, 'notifications')).docs.filter(
    (d) => field(d, 'userId') === owner.uid &&
      String(field(d, 'title') || '').toLowerCase().includes('cancelled'),
  );
  check(
    'the owner was told about the cancellation',
    cancelNotifs.length > 0,
    `${cancelNotifs.length} notification(s)`,
  );

  const cancelledAgain = await call('cancelJoinRequest', student.idToken, {
    requestId: requestId2,
  });
  check(
    'the booking cannot be cancelled twice',
    cancelledAgain.status !== 200,
    errorOf(cancelledAgain),
  );

  const paidCancelled = await call('submitPayment', student.idToken, {
    requestId: requestId2,
    reference: `E2E${STAMP}X`,
    method: 'upi',
  });
  check(
    'a cancelled booking cannot be paid for',
    paidCancelled.status !== 200,
    errorOf(paidCancelled),
  );

  section('the owner cancels a booking they accepted');
  const created3 = await call('createJoinRequest', student.idToken, { roomId: roomId3 });
  check('the student could request the third room', created3.status === 200, errorOf(created3));
  const requestId3 = created3.json?.result?.requestId || created3.json?.requestId || null;

  const approved3 = await call('respondToJoinRequest', owner.idToken, {
    requestId: requestId3,
    approve: true,
  });
  check('the owner could approve the third request', approved3.status === 200, errorOf(approved3));

  const cancelled3 = await call('cancelJoinRequest', owner.idToken, {
    requestId: requestId3,
    reason: 'The room is taken',
  });
  check(
    'the owner can cancel a booking they accepted',
    cancelled3.status === 200,
    errorOf(cancelled3),
  );

  const request3 = (await fsRead(oauth, `joinRequests/${requestId3}`)).json;
  check(
    'the third request is cancelled',
    field(request3, 'status') === 'cancelled',
    field(request3, 'status'),
  );

  const strangerCancel = await call('cancelJoinRequest', owner.idToken, {
    requestId: requestId,
  });
  check(
    'the owner cannot cancel the booking that has money in it',
    strangerCancel.status !== 200,
    errorOf(strangerCancel),
  );

  section('the account deletion needs the admin');
  const denied = await call('scheduleUserDeletion', owner.idToken, {
    uid: owner.uid,
    days: 7,
  });
  check(
    'a normal user cannot delete an account',
    denied.status !== 200,
    errorOf(denied),
  );

  section('the seven day delay');
  const scheduled = await call('scheduleUserDeletion', student.idToken, {
    uid: owner.uid,
    days: 7,
  });
  check('the admin scheduled the deletion', scheduled.status === 200, errorOf(scheduled));

  const scheduledData = scheduled.json?.result || scheduled.json || {};
  const deleteAfter = new Date(scheduledData.deleteAfter || 0);
  const days = Math.round((deleteAfter.getTime() - Date.now()) / (24 * 3600 * 1000));
  check('the account is deleted in seven days', days === 7, `${days} day(s)`);

  let ownerProfile = (await fsRead(oauth, `users/${owner.uid}`)).json;
  check(
    'the profile is marked for deletion',
    field(ownerProfile, 'deletionScheduled') === true,
    String(field(ownerProfile, 'deletionScheduled')),
  );
  check(
    'the profile says when it is deleted',
    !!field(ownerProfile, 'deleteAfter'),
    field(ownerProfile, 'deleteAfter'),
  );
  check(
    'the account is disabled right away',
    field(ownerProfile, 'isActive') === false,
    String(field(ownerProfile, 'isActive')),
  );

  const accounts = await adminIdentity(`/projects/${PROJ}/accounts:lookup`, {
    localId: [owner.uid],
  });
  check(
    'the Auth account is disabled',
    accounts.json?.users?.[0]?.disabled === true,
    String(accounts.json?.users?.[0]?.disabled),
  );

  notifs = await fsList(oauth, 'notifications');
  const deletionNotices = notifs.docs.filter(
    (d) => field(d, 'userId') === owner.uid &&
      String(field(d, 'title') || '').includes('deleted'),
  );
  check(
    'the user was told about the deletion',
    deletionNotices.length > 0,
    `${deletionNotices.length} notification(s)`,
  );

  section('the cancellation of the deletion');
  const cancelled = await call('cancelUserDeletion', student.idToken, {
    uid: owner.uid,
  });
  check('the admin cancelled the deletion', cancelled.status === 200, errorOf(cancelled));

  ownerProfile = (await fsRead(oauth, `users/${owner.uid}`)).json;
  check(
    'the profile is not marked for deletion any more',
    field(ownerProfile, 'deletionScheduled') === false,
    String(field(ownerProfile, 'deletionScheduled')),
  );
  check(
    'the account is active again',
    field(ownerProfile, 'isActive') === true,
    String(field(ownerProfile, 'isActive')),
  );

  section('the review of the admin');
  const reviewed = await call('adminReviewRequest', student.idToken, {
    requestId,
    approve: true,
  });
  check('the admin could review the request', reviewed.status === 200, errorOf(reviewed));

  const reviewedByNormalUser = await call('adminReviewRequest', owner.idToken, {
    requestId,
    approve: true,
  });
  check(
    'a normal user cannot review a request',
    reviewedByNormalUser.status !== 200,
    errorOf(reviewedByNormalUser),
  );

  section('the cleanup');
  const deletedOwner = await call('deleteUserCompletely', student.idToken, {
    uid: owner.uid,
  });
  check('the owner account was deleted', deletedOwner.status === 200, errorOf(deletedOwner));

  const gone = await fsRead(oauth, `users/${owner.uid}`);
  check('the profile of the owner is gone', gone.status === 404, `HTTP ${gone.status}`);

  const goneRoom = await fsRead(oauth, `rooms/${roomId}`);
  check('the listing of the owner is gone', goneRoom.status === 404, `HTTP ${goneRoom.status}`);

  const selfDelete = await call('deleteUserCompletely', student.idToken, {
    uid: student.uid,
  });
  check(
    'the admin cannot delete their own account',
    selfDelete.status !== 200,
    errorOf(selfDelete),
  );

  // The last test account is removed with the REST API.
  await adminIdentity(`/projects/${PROJ}/accounts:delete`, {
    localId: student.uid,
  });
  const studentProfile = await fsRead(oauth, `users/${student.uid}`);
  if (studentProfile.status === 200) {
    // The trigger may not have run yet — wait a moment and look again.
    await new Promise((r) => setTimeout(r, 8000));
    const again = await fsRead(oauth, `users/${student.uid}`);
    if (again.status === 200) {
      // Remove it with the CLI, which ignores the rules.
      try {
        execFileSync(
          'firebase',
          ['firestore:delete', `users/${student.uid}`, '--project', PROJ, '--force', '--quiet'],
          { stdio: 'ignore', timeout: 180000 },
        );
      } catch {
        // Not fatal — the report shows what is left.
      }
    }
  }
  console.log('  ... the test accounts are gone');
}

// ---------------------------------------------------------------------------
// The cleanup runs even when the test fails halfway through.
// ---------------------------------------------------------------------------
async function cleanup() {
  console.log('\n=== the emergency cleanup ===');
  try {
    const accounts = await adminIdentity(`/projects/${PROJ}/accounts:query`, {
      returnUserInfo: true,
      maxResults: 1000,
    });
    const mine = (accounts.json?.userInfo || []).filter((u) =>
      (u.email || '').startsWith('e2e.student.') ||
      (u.email || '').startsWith('e2e.owner.'),
    );
    for (const account of mine) {
      // The delete of the Auth account triggers the cleanup of the data.
      const res = await adminIdentity(`/projects/${PROJ}/accounts:delete`, {
        localId: account.localId,
      });
      console.log(`  deleted ${account.email} -> HTTP ${res.status}`);
    }
    // The documents the trigger may have missed.
    for (const collection of [
      'rooms',
      'joinRequests',
      'payments',
      'commissionInvoices',
      'notifications',
      'roomReviews',
    ]) {
      const listed = await fsList(oauth, collection);
      for (const doc of listed.docs) {
        const id = doc.name.split('/').pop();
        const data = doc.fields || {};
        const isMine =
          JSON.stringify(data).includes('E2E') ||
          field(doc, 'ownerId') === owner?.uid ||
          field(doc, 'studentId') === student?.uid ||
          field(doc, 'userId') === owner?.uid ||
          field(doc, 'userId') === student?.uid ||
          field(doc, 'roomId') === roomId ||
          field(doc, 'roomId') === roomId2 ||
          field(doc, 'roomId') === roomId3;
        if (!isMine) continue;
        await fetch(`${BASE}/${collection}/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${oauth}` },
        });
        console.log(`  deleted ${collection}/${id}`);
      }
    }
  } catch (error) {
    console.log('  the cleanup failed:', error.message);
  }
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) {
      console.log('failed checks:');
      for (const f of failures) console.log('  -', f);
      process.exit(1);
    }
  })
  .catch(async (error) => {
    console.error('\nFAILED:', error.message);
    await cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  });
