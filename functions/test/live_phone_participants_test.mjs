// Focused integration regressions for live Firebase phone enforcement on
// student/owner participants and durable room-deletion cleanup.
//
//   node functions/test/live_phone_participants_test.mjs <firestore-port> <project>

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const PORT = process.argv[2] || '8181';
const PROJECT = process.argv[3] || 'demo-stayserve-live-phone-participants';

process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORT}`;
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GCLOUD_PROJECT_ID = PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT });
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

const firestore = require('firebase-admin/firestore');
const authSdk = require('firebase-admin/auth');
const storageSdk = require('firebase-admin/storage');

const {
  canActAsRoomOwner,
  canBookAsStudent,
} = require(path.join(ROOT, 'lib', 'bookingAccess.js'));
const {
  confirmJoinAsStudent,
  createJoinRequest,
  notifyUser,
  openConversation,
  respondToJoinRequest,
} = require(path.join(ROOT, 'lib', 'requests.js'));
const {
  createUpiPayment,
  submitPayment,
  verifyPayment,
} = require(path.join(ROOT, 'lib', 'payments.js'));
const {
  blockUser,
  getBookingInteractionDetails,
  getConversationInteractionDetails,
  getRoomContactDetails,
} = require(path.join(ROOT, 'lib', 'interactions.js'));
const {
  deleteRoomListing,
  processRoomPhotoCleanupJobs,
} = require(path.join(ROOT, 'lib', 'rooms.js'));

const db = firestore.getFirestore();
const auth = authSdk.getAuth();

let pass = 0;
let fail = 0;
const failures = [];
const livePhones = new Map();
const liveAuthLookups = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(
      `  FAIL  ${label} expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function expectDenied(label, action, expectedCode = 'permission-denied') {
  try {
    await action();
    check(label, 'allowed', `rejected (${expectedCode})`);
  } catch (error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    const ok = code.includes(expectedCode) || message.includes(expectedCode);
    check(
      label,
      ok ? `rejected (${code || expectedCode})` : `${code}: ${message}`,
      `rejected (${expectedCode})`,
    );
  }
}

auth.getUser = async (uid) => {
  liveAuthLookups.push(uid);
  const phoneNumber = livePhones.has(uid)
    ? livePhones.get(uid)
    : '+919876500000';
  if (phoneNumber === null) {
    const error = new Error(`auth/user-not-found: ${uid}`);
    error.code = 'auth/user-not-found';
    throw error;
  }
  return {
    uid,
    email: `${uid}@example.test`,
    emailVerified: true,
    phoneNumber,
    providerData: [{ providerId: 'password' }, { providerId: 'phone' }],
  };
};

async function invoke(callable, data, uid) {
  return callable.run(data, {
    auth: uid
      ? {
          uid,
          token: {
            email: `${uid}@example.test`,
            email_verified: true,
          },
        }
      : undefined,
    rawRequest: {},
    instanceIdToken: null,
  });
}

function setLivePhone(uid, verified) {
  livePhones.set(
    uid,
    verified
      ? `+9198765${String(uid).replace(/\D/g, '').padStart(5, '0').slice(-5)}`
      : '',
  );
}

function deleteLiveAuthUser(uid) {
  livePhones.set(uid, null);
}

function profile(uid, role, overrides = {}) {
  return {
    uid,
    name: uid,
    role,
    roleClaimed: true,
    registrationCompleted: true,
    isActive: true,
    email: `${uid}@example.test`,
    emailVerified: true,
    phone: `+9198765${String(uid).replace(/\D/g, '').padStart(5, '0').slice(-5)}`,
    phoneVerified: true,
    ...overrides,
  };
}

async function seedUser(uid, role, overrides = {}) {
  await db.collection('users').doc(uid).set(profile(uid, role, overrides));
}

async function seedRoom(id, ownerId, overrides = {}) {
  await db.collection('rooms').doc(id).set({
    roomId: id,
    ownerId,
    title: 'Live phone test room',
    description: 'A room used by the live participant regressions.',
    monthlyRent: 5000,
    securityDeposit: 10000,
    location: {
      address: '12 Live Phone Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
    },
    roomType: 'single',
    furnishing: 'unfurnished',
    availableFrom: firestore.Timestamp.now(),
    amenities: [],
    occupancy: 2,
    currentOccupancy: 0,
    genderPreference: 'any',
    images: [],
    status: 'available',
    createdAt: firestore.Timestamp.now(),
    updatedAt: firestore.Timestamp.now(),
    ...overrides,
  });
}

async function seedRequest(id, values = {}) {
  await db.collection('joinRequests').doc(id).set({
    requestId: id,
    roomId: 'RM-LIVE-PHONE',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'pending',
    monthlyRentAtJoin: 5000,
    commissionPercentageAtJoin: 30,
    platformFeePayer: 'owner',
    platformCutTaken: false,
    advancePaid: false,
    ...values,
  });
}

async function reset() {
  const conversations = await db.collection('conversations').get();
  for (const conversation of conversations.docs) {
    const messages = await conversation.ref.collection('messages').get();
    await Promise.all(messages.docs.map((message) => message.ref.delete()));
  }

  const blocks = await db.collectionGroup('blockedUsers').get();
  await Promise.all(blocks.docs.map((block) => block.ref.delete()));

  const collections = [
    'users',
    'joinRequests',
    'payments',
    'commissionInvoices',
    'joinRequestLocks',
    'notifications',
    'notificationAttributions',
    'paymentReferences',
    'rooms',
    'roomPrivate',
    'roomReviews',
    'cleanupJobs',
    'roomDeletionTombstones',
    'conversations',
    'settings',
  ];
  for (const collection of collections) {
    const snapshot = await db.collection(collection).get();
    await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
  }

  livePhones.clear();
  liveAuthLookups.length = 0;
}

function testBookingStateDoesNotTrustThePhoneCache() {
  section('booking role checks do not trust the stale phone cache');

  const student = {
    exists: true,
    registrationCompleted: true,
    isActive: true,
    role: 'student',
    phoneVerified: false,
  };
  const owner = {
    exists: true,
    registrationCompleted: true,
    isActive: true,
    role: 'owner',
    phoneVerified: false,
  };
  check('a stale false student phone cache is ignored', canBookAsStudent(student), true);
  check('a stale false owner phone cache is ignored', canActAsRoomOwner(owner), true);
}

async function testRequestPeersUseLivePhones() {
  section('booking and conversation peers use live Firebase phones');

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner', { phoneVerified: false });
  await seedRoom('RM-LIVE-PHONE', 'owner-1');
  setLivePhone('owner-1', false);

  await expectDenied(
    'a room owner without a live phone cannot receive a booking request',
    () => invoke(createJoinRequest, { roomId: 'RM-LIVE-PHONE' }, 'student-1'),
  );
  check(
    'the refused booking request was not created',
    (await db.collection('joinRequests').get()).size,
    0,
  );

  setLivePhone('owner-1', true);
  await invoke(createJoinRequest, { roomId: 'RM-LIVE-PHONE' }, 'student-1');
  check(
    'a live owner phone authorizes a request despite the stale cache',
    (await db.collection('joinRequests').get()).size,
    1,
  );

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-LIVE-PHONE', 'owner-1');
  await seedRequest('JRQ-LIVE-RESPOND', { status: 'pending' });
  setLivePhone('student-1', false);

  await expectDenied(
    'an owner cannot approve while the student has no live phone',
    () =>
      invoke(
        respondToJoinRequest,
        { requestId: 'JRQ-LIVE-RESPOND', approve: true },
        'owner-1',
      ),
  );
  check(
    'the refused approval did not advance the request',
    (await db.collection('joinRequests').doc('JRQ-LIVE-RESPOND').get()).get('status'),
    'pending',
  );
  setLivePhone('student-1', true);
  await invoke(
    respondToJoinRequest,
    { requestId: 'JRQ-LIVE-RESPOND', approve: true },
    'owner-1',
  );
  check(
    'a live student phone authorizes the approval',
    (await db.collection('joinRequests').doc('JRQ-LIVE-RESPOND').get()).get('status'),
    'ownerConfirmed',
  );

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-LIVE-PHONE', 'owner-1');
  await seedRequest('JRQ-LIVE-CONFIRM', { status: 'ownerConfirmed' });
  setLivePhone('owner-1', false);

  await expectDenied(
    'a student cannot confirm while the owner has no live phone',
    () =>
      invoke(
        confirmJoinAsStudent,
        { requestId: 'JRQ-LIVE-CONFIRM' },
        'student-1',
      ),
  );
  setLivePhone('owner-1', true);
  await invoke(
    confirmJoinAsStudent,
    { requestId: 'JRQ-LIVE-CONFIRM' },
    'student-1',
  );
  check(
    'a live owner phone authorizes the confirmation',
    (await db.collection('joinRequests').doc('JRQ-LIVE-CONFIRM').get()).get('status'),
    'studentConfirmed',
  );

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-LIVE-PHONE', 'owner-1');
  setLivePhone('owner-1', false);
  await expectDenied(
    'a student cannot open a room chat with an owner without a live phone',
    () =>
      invoke(
        openConversation,
        { otherUserId: 'owner-1', roomId: 'RM-LIVE-PHONE' },
        'student-1',
      ),
  );
  setLivePhone('owner-1', true);
  await invoke(
    openConversation,
    { otherUserId: 'owner-1', roomId: 'RM-LIVE-PHONE' },
    'student-1',
  );
  check(
    'a live owner phone authorizes the room conversation',
    (await db.collection('conversations').get()).size,
    1,
  );

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  const conversationId = ['owner-1', 'student-1'].sort().join('_');
  await db.collection('conversations').doc(conversationId).set({
    conversationId,
    participantIds: ['owner-1', 'student-1'],
    participantNames: { 'owner-1': 'Owner', 'student-1': 'Student' },
    createdByServer: true,
  });
  await db
    .collection('conversations')
    .doc(conversationId)
    .collection('messages')
    .doc('message-1')
    .set({
      messageId: 'message-1',
      conversationId,
      senderId: 'student-1',
      receiverId: 'owner-1',
      content: 'Hello owner',
      type: 'text',
    });
  setLivePhone('owner-1', false);
  await expectDenied(
    'a chat notification cannot target a recipient without a live phone',
    () =>
      invoke(
        notifyUser,
        {
          userId: 'owner-1',
          type: 'newMessage',
          data: { conversationId, messageId: 'message-1' },
        },
        'student-1',
      ),
  );
  setLivePhone('owner-1', true);
  await invoke(
    notifyUser,
    {
      userId: 'owner-1',
      type: 'newMessage',
      data: { conversationId, messageId: 'message-1' },
    },
    'student-1',
  );
  check(
    'a live recipient phone authorizes the chat notification',
    (await db.collection('notifications').get()).size,
    1,
  );
}

async function testPaymentPeersUseLivePhones() {
  section('payment participants use live Firebase phones');

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-LIVE-PHONE', 'owner-1');
  await seedRequest('JRQ-LIVE-UPI', { status: 'studentConfirmed' });
  setLivePhone('student-1', false);

  await expectDenied(
    'a payment intent requires the student peer to have a live phone',
    () =>
      invoke(
        createUpiPayment,
        { joinRequestId: 'JRQ-LIVE-UPI' },
        'owner-1',
      ),
  );
  setLivePhone('student-1', true);
  const paymentIntent = await invoke(
    createUpiPayment,
    { joinRequestId: 'JRQ-LIVE-UPI' },
    'owner-1',
  );
  check(
    'a live student phone authorizes the payment intent',
    paymentIntent.payer,
    'owner',
  );

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-LIVE-PHONE', 'owner-1');
  await seedRequest('JRQ-LIVE-SUBMIT', { status: 'studentConfirmed' });
  setLivePhone('student-1', false);

  await expectDenied(
    'a payment submission requires the student peer to have a live phone',
    () =>
      invoke(
        submitPayment,
        {
          requestId: 'JRQ-LIVE-SUBMIT',
          reference: 'UPI-LIVE-PHONE',
          method: 'upi',
        },
        'owner-1',
      ),
  );
  check(
    'the refused payment was not stored',
    (await db.collection('payments').get()).size,
    0,
  );
  setLivePhone('student-1', true);
  await invoke(
    submitPayment,
    {
      requestId: 'JRQ-LIVE-SUBMIT',
      reference: 'UPI-LIVE-PHONE',
      method: 'upi',
    },
    'owner-1',
  );
  check(
    'a live student phone authorizes the payment submission',
    (await db.collection('payments').get()).size,
    1,
  );

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-LIVE-PHONE', 'owner-1');
  await seedRequest('JRQ-LIVE-VERIFY', { status: 'studentConfirmed' });
  await db.collection('payments').doc('JRQ-LIVE-VERIFY').set({
    requestId: 'JRQ-LIVE-VERIFY',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'RM-LIVE-PHONE',
    amount: 1500,
    feePercentage: 30,
    reference: 'UPI-LIVE-VERIFY',
    method: 'upi',
    payer: 'owner',
    feeWaived: false,
    status: 'submitted',
  });
  setLivePhone('admin-1', false);
  setLivePhone('student-1', false);
  setLivePhone('owner-1', false);
  await expectDenied(
    'payment activation requires live phones for both booking participants',
    () =>
      invoke(
        verifyPayment,
        { requestId: 'JRQ-LIVE-VERIFY', approve: true },
        'admin-1',
      ),
  );
  setLivePhone('student-1', true);
  setLivePhone('owner-1', true);
  await invoke(
    verifyPayment,
    { requestId: 'JRQ-LIVE-VERIFY', approve: true },
    'admin-1',
  );
  check(
    'an administrator without a phone can activate participants with live phones',
    (await db.collection('payments').doc('JRQ-LIVE-VERIFY').get()).get('status'),
    'verified',
  );
}

async function testInteractionPeersUseLivePhones() {
  section('interaction peers use live Firebase phones');

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await seedUser('admin-1', 'admin');
  await seedRoom('RM-LIVE-PHONE', 'owner-1');
  await seedRequest('JRQ-LIVE-INTERACTION', { status: 'pending' });
  setLivePhone('owner-1', false);

  await expectDenied(
    'booking details require the peer owner to have a live phone',
    () =>
      invoke(
        getBookingInteractionDetails,
        { requestId: 'JRQ-LIVE-INTERACTION' },
        'student-1',
      ),
  );
  await expectDenied(
    'room contact details require the peer owner to have a live phone',
    () =>
      invoke(
        getRoomContactDetails,
        { roomId: 'RM-LIVE-PHONE' },
        'student-1',
      ),
  );
  await expectDenied(
    'blocking requires the peer owner to have a live phone',
    () =>
      invoke(
        blockUser,
        { otherUserId: 'owner-1', requestId: 'JRQ-LIVE-INTERACTION' },
        'student-1',
      ),
  );

  setLivePhone('owner-1', true);
  const bookingDetails = await invoke(
    getBookingInteractionDetails,
    { requestId: 'JRQ-LIVE-INTERACTION' },
    'student-1',
  );
  const roomContact = await invoke(
    getRoomContactDetails,
    { roomId: 'RM-LIVE-PHONE' },
    'student-1',
  );
  const blockResult = await invoke(
    blockUser,
    { otherUserId: 'owner-1', requestId: 'JRQ-LIVE-INTERACTION' },
    'student-1',
  );
  check('a live peer phone authorizes booking details', bookingDetails.success, true);
  check('a live peer phone authorizes room contact details', roomContact.success, true);
  check('a live peer phone authorizes blocking', blockResult.blocked, true);

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  const conversationId = ['owner-1', 'student-1'].sort().join('_');
  await db.collection('conversations').doc(conversationId).set({
    conversationId,
    participantIds: ['owner-1', 'student-1'],
    participantNames: { 'owner-1': 'Owner', 'student-1': 'Student' },
    createdByServer: true,
  });
  setLivePhone('owner-1', false);
  await expectDenied(
    'conversation details require the peer owner to have a live phone',
    () =>
      invoke(
        getConversationInteractionDetails,
        { conversationId },
        'student-1',
      ),
  );
  setLivePhone('owner-1', true);
  const conversationDetails = await invoke(
    getConversationInteractionDetails,
    { conversationId },
    'student-1',
  );
  check(
    'a live peer phone authorizes conversation details',
    conversationDetails.success,
    true,
  );

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await seedRequest('JRQ-LIVE-ADMIN', { status: 'pending' });
  setLivePhone('admin-1', false);
  const adminBookingDetails = await invoke(
    getBookingInteractionDetails,
    { requestId: 'JRQ-LIVE-ADMIN' },
    'admin-1',
  );
  check(
    'an administrator remains exempt from the live phone requirement',
    adminBookingDetails.success,
    true,
  );
}

async function testArbitraryPeerPhonesAreNotProbed() {
  section('caller-supplied peer ids are not phone-presence oracles');

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await seedUser('unrelated-user', 'owner');
  await seedRoom('RM-LIVE-PHONE', 'owner-1');
  await seedRequest('JRQ-LIVE-PHONE', {
    roomId: 'RM-LIVE-PHONE',
    status: 'pending',
  });

  const conversationId = ['owner-1', 'student-1'].sort().join('_');
  await db.collection('conversations').doc(conversationId).set({
    conversationId,
    participantIds: ['owner-1', 'student-1'],
    participantNames: { 'owner-1': 'Owner', 'student-1': 'Student' },
    createdByServer: true,
  });
  await db
    .collection('conversations')
    .doc(conversationId)
    .collection('messages')
    .doc('message-1')
    .set({
      messageId: 'message-1',
      conversationId,
      senderId: 'student-1',
      receiverId: 'owner-1',
      content: 'Hello owner',
      type: 'text',
    });

  const unrelatedWasLookedUp = () => liveAuthLookups.includes('unrelated-user');

  setLivePhone('unrelated-user', false);
  const openWithoutPhone = await expectDenied(
    'an unrelated room-conversation peer is rejected before its phone is probed',
    () =>
      invoke(
        openConversation,
        { otherUserId: 'unrelated-user', roomId: 'RM-LIVE-PHONE' },
        'student-1',
      ),
    'permission-denied',
  );
  check(
    'an unrelated room-conversation peer is never read from live Auth',
    unrelatedWasLookedUp(),
    false,
  );

  setLivePhone('unrelated-user', true);
  const openWithPhone = await expectDenied(
    'the room-conversation rejection does not depend on the unrelated phone',
    () =>
      invoke(
        openConversation,
        { otherUserId: 'unrelated-user', roomId: 'RM-LIVE-PHONE' },
        'student-1',
      ),
    'permission-denied',
  );
  check(
    'the room-conversation peer is still never read from live Auth',
    unrelatedWasLookedUp(),
    false,
  );
  check(
    'the room-conversation error is independent of the unrelated phone state',
    openWithPhone,
    openWithoutPhone,
  );

  setLivePhone('unrelated-user', false);
  const notifyWithoutPhone = await expectDenied(
    'an unrelated notification recipient is rejected before its phone is probed',
    () =>
      invoke(
        notifyUser,
        {
          userId: 'unrelated-user',
          type: 'newMessage',
          data: { conversationId, messageId: 'message-1' },
        },
        'student-1',
      ),
    'permission-denied',
  );
  check(
    'an unrelated notification recipient is never read from live Auth',
    unrelatedWasLookedUp(),
    false,
  );

  setLivePhone('unrelated-user', true);
  const notifyWithPhone = await expectDenied(
    'the notification rejection does not depend on the unrelated phone',
    () =>
      invoke(
        notifyUser,
        {
          userId: 'unrelated-user',
          type: 'newMessage',
          data: { conversationId, messageId: 'message-1' },
        },
        'student-1',
      ),
    'permission-denied',
  );
  check(
    'the unrelated notification recipient is still never read from live Auth',
    unrelatedWasLookedUp(),
    false,
  );
  check(
    'the notification error is independent of the unrelated phone state',
    notifyWithPhone,
    notifyWithoutPhone,
  );

  setLivePhone('unrelated-user', false);
  const blockWithoutPhone = await expectDenied(
    'an unrelated block peer is rejected before its phone is probed',
    () =>
      invoke(
        blockUser,
        { otherUserId: 'unrelated-user', requestId: 'JRQ-LIVE-PHONE' },
        'student-1',
      ),
    'failed-precondition',
  );
  check(
    'an unrelated block peer is never read from live Auth',
    unrelatedWasLookedUp(),
    false,
  );

  setLivePhone('unrelated-user', true);
  const blockWithPhone = await expectDenied(
    'the block rejection does not depend on the unrelated phone',
    () =>
      invoke(
        blockUser,
        { otherUserId: 'unrelated-user', requestId: 'JRQ-LIVE-PHONE' },
        'student-1',
      ),
    'failed-precondition',
  );
  check(
    'the unrelated block peer is still never read from live Auth',
    unrelatedWasLookedUp(),
    false,
  );
  check(
    'the block error is independent of the unrelated phone state',
    blockWithPhone,
    blockWithoutPhone,
  );
}

async function testRoomDeletionSeparatesLiveActorFromDurableCleanup() {
  section('room deletion separates live actor authorization from durable cleanup');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-LIVE-DELETE', 'owner-1');
  setLivePhone('owner-1', false);
  await expectDenied(
    'a new room deletion remains gated by the live owner phone',
    () => invoke(deleteRoomListing, { roomId: 'RM-LIVE-DELETE' }, 'owner-1'),
  );
  check(
    'the refused room deletion kept the listing',
    (await db.collection('rooms').doc('RM-LIVE-DELETE').get()).exists,
    true,
  );

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-LIVE-CLEANUP', 'owner-1', {
    listingGeneration: 'generation-live-cleanup',
    status: 'inactive',
    deletionInProgress: true,
    deletionRequestedBy: 'owner-1',
    deletionOperationId: 'operation-live-cleanup',
  });
  await seedRequest('JRQ-LIVE-CLEANUP', {
    roomId: 'RM-LIVE-CLEANUP',
    status: 'pending',
  });
  await db.collection('roomDeletionTombstones').doc('RM-LIVE-CLEANUP').set({
    type: 'roomDeletionTombstone',
    roomId: 'RM-LIVE-CLEANUP',
    ownerId: 'owner-1',
    listingGeneration: 'generation-live-cleanup',
    deletionOperationId: 'operation-live-cleanup',
  });
  await db.collection('cleanupJobs').doc('room-deletion-live-cleanup').set({
    type: 'roomDeletion',
    roomId: 'RM-LIVE-CLEANUP',
    ownerId: 'owner-1',
    listingGeneration: 'generation-live-cleanup',
    deletionOperationId: 'operation-live-cleanup',
    deletionRequestedBy: 'owner-1',
    previousStatus: 'available',
    attempts: 0,
  });

  // The original owner was deleted after the server authorized the operation.
  // Resumed cleanup must rely on the durable server-owned marker, not on the
  // deleted actor's profile or live Auth account.
  await db.collection('users').doc('owner-1').delete();
  deleteLiveAuthUser('owner-1');

  const originalGetStorage = storageSdk.getStorage;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => [[]],
      file: () => ({ delete: async () => undefined }),
    }),
  });
  try {
    await processRoomPhotoCleanupJobs.run({});
  } finally {
    storageSdk.getStorage = originalGetStorage;
  }

  check(
    'resumed cleanup deletes the listing after the actor is deleted',
    (await db.collection('rooms').doc('RM-LIVE-CLEANUP').get()).exists,
    false,
  );
  check(
    'resumed cleanup cancels the open request after the actor is deleted',
    (await db.collection('joinRequests').doc('JRQ-LIVE-CLEANUP').get()).get('status'),
    'cancelled',
  );
  check(
    'resumed cleanup removes the durable deletion job after the actor is deleted',
    (await db.collection('cleanupJobs').doc('room-deletion-live-cleanup').get()).exists,
    false,
  );
}

async function main() {
  testBookingStateDoesNotTrustThePhoneCache();
  await testRequestPeersUseLivePhones();
  await testPaymentPeersUseLivePhones();
  await testInteractionPeersUseLivePhones();
  await testArbitraryPeerPhonesAreNotProbed();
  await testRoomDeletionSeparatesLiveActorFromDurableCleanup();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(`Failed regressions: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
