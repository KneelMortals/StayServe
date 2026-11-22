// Integration regressions for the server-owned booking transitions.
//
// The test runs against the Firestore emulator and invokes the compiled v1
// callables directly with a synthetic authenticated context. It therefore
// exercises the real transactions, role checks and payment state changes —
// not just the pure helpers.
//
//   node functions/test/backend_callable_test.mjs <firestore-port> <project>

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const PORT = process.argv[2] || '8181';
const PROJECT = process.argv[3] || 'demo-stayserve-backend';

process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORT}`;
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GCLOUD_PROJECT_ID = PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT });
// No Auth request is made by this suite. Point the SDK at the emulator
// protocol so it does not look for application-default credentials while it
// initializes the shared Auth service.
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

const firestore = require('firebase-admin/firestore');
const authSdk = require('firebase-admin/auth');
const messagingSdk = require('firebase-admin/messaging');
const storageSdk = require(path.join(
  ROOT,
  'node_modules',
  'firebase-admin',
  'lib',
  'storage',
  'index.js',
));

const {
  createJoinRequest,
  respondToJoinRequest,
  confirmJoinAsStudent,
  cancelJoinRequest,
  openConversation,
  notifyUser,
} = require(path.join(ROOT, 'lib', 'requests.js'));
const {
  createUpiPayment,
  submitPayment,
  verifyPayment,
} = require(path.join(ROOT, 'lib', 'payments.js'));
const {
  getConversationInteractionDetails,
  getBookingInteractionDetails,
  getRoomContactDetails,
  blockUser,
  unblockUser,
} = require(path.join(ROOT, 'lib', 'interactions.js'));
const {
  setUserRole,
  banUser,
  unbanUser,
  revokeUserTokens,
  deleteUserCompletely,
  runMaintenanceTask,
  onUserDelete,
} = require(path.join(ROOT, 'lib', 'index.js'));
const {
  deleteRoomListing,
  processRoomPhotoCleanupJobs,
  setRoomListingAvailability,
  adminSetRoomListingStatus,
} = require(path.join(ROOT, 'lib', 'rooms.js'));
const { registerUserRole } = require(path.join(ROOT, 'lib', 'otp.js'));
const {
  processRoleClaimPublicationJobs,
} = require(path.join(ROOT, 'lib', 'roleClaims.js'));
const {
  setRoomPrivateLocation,
  migrateRoomPrivateLocations,
  verifyRoomPrivateLocations,
  finalizeRoomLocationPrivacy,
  setClientExactLocationWritesAllowed,
} = require(path.join(ROOT, 'lib', 'privateLocations.js'));
const { getRoomVisitDetails } = require(path.join(ROOT, 'lib', 'visits.js'));
const {
  submitRoomReview,
  deleteRoomReview,
} = require(path.join(ROOT, 'lib', 'reviews.js'));
const {
  deleteNotification,
  notify,
} = require(path.join(ROOT, 'lib', 'notifications.js'));
const batches = require(path.join(ROOT, 'lib', 'batches.js'));
const {
  adminReviewRequest,
  accountDeletionJobId,
  enqueueAccountDeletion,
  processAccountDeletionJob,
  completeAccountDeletionJob,
  claimScheduledAccountDeletion,
  cancelUserDeletion,
  scheduleUserDeletion,
  processAccountDeletionJobs,
  processScheduledDeletions,
  scheduleAccountDeletionJob,
  deleteUserConversations,
} = require(path.join(ROOT, 'lib', 'admin.js'));

// The compiled modules initialize the default Admin app when they are
// loaded. Open Firestore and Auth only after that initialization.
const db = firestore.getFirestore();
const auth = authSdk.getAuth();

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(
      `  FAIL  ${label}  expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function invoke(callable, data, uid) {
  return callable.run(data, {
    auth: uid
      ? {
          uid,
          token: { email: `${uid}@example.test` },
        }
      : undefined,
    rawRequest: {},
    instanceIdToken: null,
  });
}

function emulatorJwt(uid) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    sub: uid,
    user_id: uid,
    role: 'student',
  })}.`;
}

async function createClientMessage({
  uid,
  conversationId,
  messageId,
  senderId,
  receiverId,
}) {
  const host = `http://127.0.0.1:${PORT}/v1/projects/${PROJECT}/databases/(default)/documents`;
  const response = await fetch(
    `${host}/conversations/${conversationId}/messages/${messageId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${emulatorJwt(uid)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          messageId: { stringValue: messageId },
          conversationId: { stringValue: conversationId },
          senderId: { stringValue: senderId },
          receiverId: { stringValue: receiverId },
          content: { stringValue: 'This message raced with deletion' },
          type: { stringValue: 'text' },
          createdAt: { timestampValue: new Date().toISOString() },
        },
      }),
    },
  );
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function expectDenied(label, action, expectedCode = 'permission-denied') {
  try {
    await action();
    check(label, 'allowed', `rejected (${expectedCode})`);
  } catch (error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    const ok = code.includes(expectedCode) || message.includes(expectedCode);
    check(label, ok ? `rejected (${code || expectedCode})` : `${code}: ${message}`,
      `rejected (${expectedCode})`);
  }
}

function profile(uid, role, active = true) {
  return {
    uid,
    role,
    roleClaimed: true,
    registrationCompleted: true,
    isActive: active,
    name: uid,
    email: `${uid}@example.test`,
  };
}

async function seedUser(uid, role, active = true) {
  await db.collection('users').doc(uid).set(profile(uid, role, active));
}

async function seedRequest(id, values) {
  const data = {
    requestId: id,
    roomId: 'RM-1',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'pending',
    monthlyRentAtJoin: 5000,
    commissionPercentageAtJoin: 30,
    platformFeePayer: 'owner',
    platformCutTaken: false,
    advancePaid: false,
    ...values,
  };
  if (values.requestId === undefined) delete data.requestId;
  await db.collection('joinRequests').doc(id).set(data);
}

function roomDeletionJobDocumentId(roomId) {
  const digest = crypto
    .createHash('sha256')
    .update(`room-deletion:${roomId}`)
    .digest('hex');
  return `room-deletion-${digest}`;
}

async function seedRoom(id, ownerId, overrides = {}) {
  await db.collection('rooms').doc(id).set({
    roomId: id,
    ownerId,
    title: 'Location test room',
    description: 'A room used by the location migration tests.',
    monthlyRent: 5000,
    securityDeposit: 10000,
    location: {
      address: '12 Legacy Street',
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

function testOtpDocumentId(channel, identifier) {
  const digest = crypto
    .createHash('sha256')
    .update(identifier.trim().toLowerCase())
    .digest('hex');
  return `${channel}_${digest}`;
}

async function reset() {
  // Firestore does not delete subcollections with their parent document, so
  // the messages have to go before the conversation documents.
  const conversations = await db.collection('conversations').get();
  for (const conversation of conversations.docs) {
    const messages = await conversation.ref.collection('messages').get();
    await Promise.all(messages.docs.map((message) => message.ref.delete()));
    const contexts = await conversation.ref.collection('contexts').get();
    await Promise.all(contexts.docs.map((context) => context.ref.delete()));
  }

  // Personal blocks live in a subcollection whose parent document is never
  // created. A collection-group query is therefore required; listing only
  // `userBlocks` would leave the directional blocks behind and contaminate
  // the next test.
  const blocks = await db.collectionGroup('blockedUsers').get();
  await Promise.all(blocks.docs.map((block) => block.ref.delete()));

  const collections = [
    'users',
    'joinRequests',
    'payments',
    'commissionInvoices',
    'joinRequestLocks',
    'notifications',
    'rooms',
    'roomPrivate',
    'roomReviews',
    'paymentReferences',
    'cleanupJobs',
    'roomDeletionTombstones',
    'roleClaimJobs',
    'accountDeletionJobs',
    'settings',
    'system',
    'otpCodes',
    'otpSendQuota',
    'conversations',
    'userBlocks',
  ];
  for (const collection of collections) {
    const snapshot = await db.collection(collection).get();
    await Promise.all(snapshot.docs.map((doc) => doc.ref.delete()));
  }
}

async function testOwnerApprovalAndCancellationUseLiveRole() {
  section('owner approval and cancellation use the live owner role');

  await reset();
  await seedUser('owner-1', 'student');
  await seedUser('student-1', 'student');
  await seedRoom('RM-1', 'owner-1');
  await seedRequest('JRQ-OWNER-ROLE', { status: 'pending' });

  await expectDenied(
    'a demoted owner cannot approve a request',
    () =>
      invoke(respondToJoinRequest, {
        requestId: 'JRQ-OWNER-ROLE',
        approve: true,
      }, 'owner-1'),
  );
  let request = await db.collection('joinRequests').doc('JRQ-OWNER-ROLE').get();
  check(
    'the demoted owner approval did not change the request',
    request.get('status'),
    'pending',
  );

  await seedUser('owner-1', 'owner');
  await invoke(respondToJoinRequest, {
    requestId: 'JRQ-OWNER-ROLE',
    approve: true,
  }, 'owner-1');
  request = await db.collection('joinRequests').doc('JRQ-OWNER-ROLE').get();
  check(
    'a live owner can approve a request',
    request.get('status'),
    'ownerConfirmed',
  );

  await seedUser('owner-1', 'student');
  await seedRequest('JRQ-OWNER-CANCEL', { status: 'ownerConfirmed' });
  await expectDenied(
    'a demoted owner cannot cancel an owner-side request',
    () =>
      invoke(cancelJoinRequest, {
        requestId: 'JRQ-OWNER-CANCEL',
      }, 'owner-1'),
  );
  request = await db.collection('joinRequests').doc('JRQ-OWNER-CANCEL').get();
  check(
    'the demoted owner cancellation did not change the request',
    request.get('status'),
    'ownerConfirmed',
  );
}

async function testRoleChangeCancelsOwnerSideRequests() {
  section('a role change inspects owner-side requests');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRequest('JRQ-OWNER-SIDE', {
    ownerId: 'owner-1',
    studentId: 'student-1',
    status: 'pending',
  });

  const originalSetClaims = auth.setCustomUserClaims;
  const originalRevoke = auth.revokeRefreshTokens;
  const revokedUids = [];
  auth.setCustomUserClaims = async () => undefined;
  auth.revokeRefreshTokens = async (uid) => {
    revokedUids.push(uid);
  };
  try {
    await invoke(setUserRole, { uid: 'owner-1', role: 'student' }, 'admin-1');
  } finally {
    auth.setCustomUserClaims = originalSetClaims;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const owner = await db.collection('users').doc('owner-1').get();
  const request = await db.collection('joinRequests').doc('JRQ-OWNER-SIDE').get();
  check('the owner role changed', owner.get('role'), 'student');
  check(
    'the owner-side request was cancelled',
    request.get('status'),
    'cancelled',
  );
  check(
    'the demotion revoked the old refresh session',
    revokedUids.includes('owner-1'),
    true,
  );
}

async function testWaivedPaymentStillRequiresAParty() {
  section('a waived payment still requires a booking party');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedUser('outsider-1', 'student');
  await seedRoom('RM-1', 'owner-1');
  await seedRequest('JRQ-WAIVED', {
    status: 'studentConfirmed',
    commissionPercentageAtJoin: 0,
    platformFeePayer: 'owner',
  });

  await expectDenied(
    'an outsider cannot submit a waived booking',
    () =>
      invoke(submitPayment, {
        requestId: 'JRQ-WAIVED',
        reference: '',
        method: 'upi',
      }, 'outsider-1'),
  );
  check(
    'the outsider did not create a payment',
    (await db.collection('payments').doc('JRQ-WAIVED').get()).exists,
    false,
  );

  const result = await invoke(submitPayment, {
    requestId: 'JRQ-WAIVED',
    reference: '',
    method: 'upi',
  }, 'owner-1');
  check('the owner can submit a waived booking', result.status, 'submitted');
  check(
    'the waived payment record exists',
    (await db.collection('payments').doc('JRQ-WAIVED').get()).get('status'),
    'submitted',
  );
}

async function testRejectedPaymentCannotResurrectTerminalRequest() {
  section('a rejected payment cannot resurrect a terminal request');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await db.collection('rooms').doc('RM-1').set({
    roomId: 'RM-1',
    ownerId: 'owner-1',
    title: 'Room',
    monthlyRent: 5000,
    occupancy: 2,
    currentOccupancy: 0,
    status: 'available',
  });
  await seedRequest('JRQ-CANCELLED', { status: 'cancelled' });
  await db.collection('payments').doc('JRQ-CANCELLED').set({
    requestId: 'JRQ-CANCELLED',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'RM-1',
    amount: 1500,
    feePercentage: 30,
    reference: 'UPI-CANCELLED',
    method: 'upi',
    payer: 'owner',
    feeWaived: false,
    status: 'submitted',
  });

  await invoke(verifyPayment, {
    requestId: 'JRQ-CANCELLED',
    approve: false,
    note: 'Money did not arrive',
  }, 'admin-1');

  const request = await db.collection('joinRequests').doc('JRQ-CANCELLED').get();
  const payment = await db.collection('payments').doc('JRQ-CANCELLED').get();
  check('the cancelled request stayed cancelled', request.get('status'), 'cancelled');
  check('the payment was rejected', payment.get('status'), 'rejected');
}

async function testMismatchedPaymentCanBeRejectedWithoutChangingRequest() {
  section('a mismatched payment can be rejected without changing the request');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRequest('JRQ-MISMATCH', { status: 'studentConfirmed' });
  await db.collection('payments').doc('JRQ-MISMATCH').set({
    requestId: 'JRQ-MISMATCH',
    studentId: 'another-student',
    ownerId: 'owner-1',
    roomId: 'RM-1',
    amount: 1500,
    feePercentage: 30,
    reference: 'UPI-MISMATCH',
    method: 'upi',
    payer: 'owner',
    feeWaived: false,
    status: 'submitted',
  });

  await invoke(verifyPayment, {
    requestId: 'JRQ-MISMATCH',
    approve: false,
  }, 'admin-1');

  const request = await db.collection('joinRequests').doc('JRQ-MISMATCH').get();
  const payment = await db.collection('payments').doc('JRQ-MISMATCH').get();
  check('the mismatched payment was rejected', payment.get('status'), 'rejected');
  check(
    'the mismatched payment did not rewrite the request',
    request.get('status'),
    'studentConfirmed',
  );
}

async function testAlreadyActiveApprovalDoesNotRequireStudentRole() {
  section('an already-active legacy booking can be acknowledged idempotently');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'owner');
  await db.collection('rooms').doc('RM-1').set({
    roomId: 'RM-1',
    ownerId: 'owner-1',
    title: 'Room',
    monthlyRent: 5000,
    occupancy: 2,
    currentOccupancy: 1,
    status: 'occupied',
  });
  await seedRequest('JRQ-LEGACY', {
    status: 'adminReviewed',
    requestId: undefined,
  });
  await db.collection('payments').doc('JRQ-LEGACY').set({
    requestId: 'JRQ-LEGACY',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'RM-1',
    amount: 1500,
    feePercentage: 30,
    reference: 'UPI-LEGACY',
    method: 'upi',
    payer: 'owner',
    feeWaived: false,
    status: 'submitted',
  });

  await invoke(verifyPayment, {
    requestId: 'JRQ-LEGACY',
    approve: true,
  }, 'admin-1');

  const request = await db.collection('joinRequests').doc('JRQ-LEGACY').get();
  const room = await db.collection('rooms').doc('RM-1').get();
  check('the active request stayed active', request.get('status'), 'adminReviewed');
  check('the legacy request used its document id', request.get('invoiceId'), 'INV-JRQ-LEGACY');
  check('the occupancy was not counted twice', room.get('currentOccupancy'), 1);
}

async function testBanCommitsFirestoreStateBeforeAuth() {
  section('a ban commits the live Firestore state before Auth');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');

  let activeStateSeenByAuth = null;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.revokeRefreshTokens = async (uid) => {
    const snapshot = await db.collection('users').doc(uid).get();
    activeStateSeenByAuth = snapshot.get('isActive');
    throw new Error('simulated Auth failure');
  };

  try {
    await expectDenied(
      'the ban reports the Auth failure',
      () => invoke(banUser, { uid: 'target-1' }, 'admin-1'),
      'internal',
    );
  } finally {
    auth.revokeRefreshTokens = originalRevoke;
  }

  const target = await db.collection('users').doc('target-1').get();
  check('the live profile was disabled', target.get('isActive'), false);
  check(
    'Auth was called only after the live profile was disabled',
    activeStateSeenByAuth,
    false,
  );
}

async function testConversationCreationIsServerVerified() {
  section('conversation creation is server-verified');

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await db.collection('rooms').doc('RM-1').set({
    roomId: 'RM-1',
    ownerId: 'owner-1',
    title: 'Room',
    monthlyRent: 5000,
    occupancy: 1,
    currentOccupancy: 0,
    status: 'available',
  });

  await expectDenied(
    'a student cannot open a conversation with an arbitrary uid',
    () =>
      invoke(openConversation, {
        otherUserId: 'not-the-owner',
        roomId: 'RM-1',
      }, 'student-1'),
  );

  const result = await invoke(openConversation, {
    otherUserId: 'owner-1',
    roomId: 'RM-1',
  }, 'student-1');
  const conversationId = ['owner-1', 'student-1'].sort().join('_');
  check('the server returned the deterministic conversation id', result.conversationId, conversationId);

  const conversation = await db
    .collection('conversations')
    .doc(conversationId)
    .get();
  check('the server created the conversation', conversation.exists, true);
  check(
    'the conversation is marked as server-verified',
    conversation.get('createdByServer'),
    true,
  );
  check(
    'the conversation contains only the two real parties',
    conversation.get('participantIds'),
    ['owner-1', 'student-1'],
  );
}

async function testConversationCleanupMarksBeforeDeletingMessages() {
  section('conversation cleanup marks the parent before deleting messages');

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  const conversationRef = db.collection('conversations').doc('conversation-1');
  await conversationRef.set({
    conversationId: 'conversation-1',
    participantIds: ['student-1', 'owner-1'],
    roomId: 'RM-1',
    createdByServer: true,
  });
  await conversationRef.collection('messages').doc('message-1').set({
    messageId: 'message-1',
    conversationId: 'conversation-1',
    senderId: 'student-1',
    receiverId: 'owner-1',
    content: 'Hello',
  });

  const originalDeleteWhere = batches.deleteWhere;
  let markerVisibleAtMessageScan = false;
  let lateMessageResponse;
  batches.deleteWhere = async (buildQuery, shouldDelete, guard) => {
    if (!markerVisibleAtMessageScan) {
      markerVisibleAtMessageScan =
        (await conversationRef.get()).get('deletionInProgress') === true;
    }
    if (!lateMessageResponse) {
      // This is a real client request through Firestore security rules. It
      // arrives after the server committed the deletion marker but before the
      // message scan removes the existing messages, which is the narrow race
      // the marker is intended to close.
      lateMessageResponse = await createClientMessage({
        uid: 'student-1',
        conversationId: 'conversation-1',
        messageId: 'message-late',
        senderId: 'student-1',
        receiverId: 'owner-1',
      });
    }
    return originalDeleteWhere(buildQuery, shouldDelete, guard);
  };
  try {
    await deleteUserConversations('student-1');
  } finally {
    batches.deleteWhere = originalDeleteWhere;
  }

  check(
    'the deletion marker was committed before the message scan began',
    markerVisibleAtMessageScan,
    true,
  );
  check(
    'the rules reject a late message during the deletion scan',
    lateMessageResponse?.status >= 400,
    true,
  );
  check(
    'the late-message rejection is reported as PERMISSION_DENIED',
    lateMessageResponse?.body?.error?.status,
    'PERMISSION_DENIED',
  );
  check(
    'the rejected late message was not stored',
    (
      await conversationRef.collection('messages').doc('message-late').get()
    ).exists,
    false,
  );
  check(
    'the conversation parent was deleted',
    (await conversationRef.get()).exists,
    false,
  );
  check(
    'the message subcollection was deleted',
    (await conversationRef.collection('messages').get()).empty,
    true,
  );
}

async function testAuthDeleteCleanupIsDurableAndRetryable() {
  section('an Auth deletion leaves a durable retryable cleanup job');

  await reset();
  await seedUser('target-1', 'student');
  await seedUser('peer-1', 'owner');
  await seedRoom('RM-ACCOUNT-DELETE', 'target-1');

  const cleanupConversationId = ['target-1', 'peer-1'].sort().join('_');
  const cleanupConversationRef = db
    .collection('conversations')
    .doc(cleanupConversationId);
  const cleanupContextRef = cleanupConversationRef
    .collection('contexts')
    .doc('JRQ-CLEANUP-CONTEXT');
  const outgoingBlockRef = db
    .collection('userBlocks')
    .doc('target-1')
    .collection('blockedUsers')
    .doc('peer-1');
  const incomingBlockRef = db
    .collection('userBlocks')
    .doc('peer-1')
    .collection('blockedUsers')
    .doc('target-1');
  const malformedIncomingBlockRef = db
    .collection('userBlocks')
    .doc('malformed-blocker')
    .collection('blockedUsers')
    .doc('target-1');
  await cleanupConversationRef.set({
    conversationId: cleanupConversationId,
    participantIds: ['peer-1', 'target-1'],
    participantNames: {
      'peer-1': 'Peer Owner',
      'target-1': 'Target Student',
    },
    roomId: 'RM-ACCOUNT-DELETE',
    roomTitle: 'Cleanup Room',
    createdByServer: true,
    lastMessage: '',
    lastMessageAt: firestore.Timestamp.now(),
    createdAt: firestore.Timestamp.now(),
    updatedAt: firestore.Timestamp.now(),
    unreadCount: {},
  });
  await cleanupContextRef.set({
    contextId: 'JRQ-CLEANUP-CONTEXT',
    roomId: 'RM-ACCOUNT-DELETE',
    roomTitle: 'Cleanup Room',
    requestId: 'JRQ-CLEANUP-CONTEXT',
    capturedAt: firestore.Timestamp.now(),
  });
  await outgoingBlockRef.set({
    blockerId: 'target-1',
    blockedUserId: 'peer-1',
    scope: 'person',
    blockedAt: firestore.Timestamp.now(),
  });
  await incomingBlockRef.set({
    blockerId: 'peer-1',
    blockedUserId: 'target-1',
    scope: 'person',
    blockedAt: firestore.Timestamp.now(),
  });
  // The canonical document path names the deleted account, while the
  // duplicated field is inconsistent. The rules use the path, so cleanup
  // must remove this record too.
  await malformedIncomingBlockRef.set({
    blockerId: 'malformed-blocker',
    blockedUserId: 'different-user',
    scope: 'person',
    blockedAt: firestore.Timestamp.now(),
  });
  await db.collection('roomPrivate').doc('RM-ACCOUNT-DELETE').set({
    roomId: 'RM-ACCOUNT-DELETE',
    // Deliberately inconsistent: account deletion must remove the private
    // document by the listing's canonical room id, not by this field.
    ownerId: 'wrong-owner',
    address: '12 Account Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: 77.5946,
    updatedAt: firestore.Timestamp.now(),
  });
  await db.collection('users').doc('target-1').update({
    phone: '+919876543210',
  });
  const emailOtpRef = db
    .collection('otpCodes')
    .doc(testOtpDocumentId('email', 'target-1@example.test'));
  const mobileOtpRef = db
    .collection('otpCodes')
    .doc(testOtpDocumentId('mobile', '+919876543210'));
  await emailOtpRef.set({
    channel: 'email',
    identifierHash: 'email-hash',
    verifiedByUid: 'target-1',
  });
  const boundOtpRef = db
    .collection('otpCodes')
    .doc('legacy-bound-otp-target-1');
  await boundOtpRef.set({
    channel: 'email',
    identifierHash: 'legacy-bound-hash',
    verifiedByUid: 'target-1',
  });
  await mobileOtpRef.set({
    channel: 'mobile',
    identifierHash: 'mobile-hash',
  });
  const uidQuotaRef = db
    .collection('otpSendQuota')
    .doc(`uid_${crypto.createHash('sha256').update('target-1').digest('hex')}`);
  await uidQuotaRef.set({ sendCount: 1, windowStart: firestore.Timestamp.now() });

  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  const originalDeleteUser = auth.deleteUser;
  const originalGetStorage = storageSdk.getStorage;
  let failStorage = true;

  auth.updateUser = async () => undefined;
  auth.revokeRefreshTokens = async () => undefined;
  auth.deleteUser = async () => undefined;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => {
        if (failStorage) throw new Error('simulated Storage outage');
        return [[]];
      },
    }),
  });

  try {
    let cleanupError = null;
    try {
      await onUserDelete.run({ uid: 'target-1' });
    } catch (error) {
      cleanupError = error;
    }
    check(
      'the failed trigger reports the cleanup failure',
      String(cleanupError?.message || '').includes('Storage outage'),
      true,
    );

    const jobRef = db
      .collection('accountDeletionJobs')
      .doc(accountDeletionJobId('target-1'));
    const failedJob = await jobRef.get();
    check('the failed cleanup left a pending job', failedJob.get('status'), 'pending');
    check('the pending job kept the uid for a retry', failedJob.get('uid'), 'target-1');
    check(
      'the failed cleanup recorded its error',
      String(failedJob.get('lastError') || '').includes('Storage outage'),
      true,
    );
    check(
      'the failed cleanup has a retry time',
      typeof failedJob.get('nextAttemptAt')?.toMillis === 'function',
      true,
    );
    check(
      'the profile was not falsely reported as deleted',
      (await db.collection('users').doc('target-1').get()).exists,
      true,
    );

    failStorage = false;
    await onUserDelete.run({ uid: 'target-1' });

    const completedJob = await jobRef.get();
    check('the retry completed the deletion job', completedJob.get('status'), 'completed');
    check('the completed tombstone removed the uid', completedJob.exists && completedJob.get('uid'), undefined);
    check(
      'the completed tombstone removed the retry time',
      completedJob.get('nextAttemptAt'),
      undefined,
    );
    check(
      'the profile was removed after the successful cleanup',
      (await db.collection('users').doc('target-1').get()).exists,
      false,
    );
    check(
      'the private room location was removed with the account',
      (await db.collection('roomPrivate').doc('RM-ACCOUNT-DELETE').get()).exists,
      false,
    );
    check(
      'the deterministic email OTP record was removed',
      (await emailOtpRef.get()).exists,
      false,
    );
    check(
      'a non-deterministic OTP record bound to the account was removed',
      (await boundOtpRef.get()).exists,
      false,
    );
    check(
      'the deterministic phone OTP record was removed',
      (await mobileOtpRef.get()).exists,
      false,
    );
    check(
      'the account OTP quota was removed',
      (await uidQuotaRef.get()).exists,
      false,
    );
    check(
      'the outgoing personal block was removed with the account',
      (await outgoingBlockRef.get()).exists,
      false,
    );
    check(
      'the incoming personal block was removed with the account',
      (await incomingBlockRef.get()).exists,
      false,
    );
    check(
      'an incoming block with a malformed field was removed by its canonical path',
      (await malformedIncomingBlockRef.get()).exists,
      false,
    );
    check(
      'the conversation was removed with the account',
      (await cleanupConversationRef.get()).exists,
      false,
    );
    check(
      'the server-owned conversation context was removed with the account',
      (await cleanupContextRef.get()).exists,
      false,
    );
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
    auth.deleteUser = originalDeleteUser;
    storageSdk.getStorage = originalGetStorage;
  }
}

async function testAccountDeletionDoesNotEraseLiveBookings() {
  section('account deletion does not erase a live booking');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRequest('JRQ-LIVE', { status: 'adminReviewed' });

  const jobRef = await enqueueAccountDeletion('student-1', {
    source: 'test',
  });
  let blockedCode = '';
  try {
    await processAccountDeletionJob(jobRef);
  } catch (error) {
    blockedCode = String(error?.code || '');
  }

  check('the live booking blocked the deletion', blockedCode, 'account-deletion-blocked');
  check(
    'the live booking was not deleted',
    (await db.collection('joinRequests').doc('JRQ-LIVE').get()).exists,
    true,
  );
  check(
    'the blocked deletion remains retryable',
    (await jobRef.get()).get('status'),
    'pending',
  );
  check(
    'the blocked deletion has a deferred retry time',
    typeof (await jobRef.get()).get('nextAttemptAt')?.toMillis === 'function',
    true,
  );
  check(
    'the blocked profile was kept',
    (await db.collection('users').doc('student-1').get()).exists,
    true,
  );
}

async function testAdminDeletionDistinguishesBlockedAndTransientFailures() {
  section('the admin deletion response distinguishes blocked and transient failures');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('student-1', 'student');
  await seedRequest('JRQ-BLOCKED', { status: 'adminReviewed' });

  const blocked = await invoke(
    deleteUserCompletely,
    { uid: 'student-1' },
    'admin-1',
  );
  check('a blocked deletion is reported as blocked', blocked.blocked, true);
  check('a blocked deletion is not called retryable', blocked.retryable, false);
  check('a blocked deletion has a blocked state', blocked.state, 'blocked');
  check(
    'a blocked deletion remains queued for a safe later state',
    blocked.queued,
    true,
  );

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('student-1', 'student');

  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  const originalDeleteUser = auth.deleteUser;
  const originalGetStorage = storageSdk.getStorage;
  auth.updateUser = async () => undefined;
  auth.revokeRefreshTokens = async () => undefined;
  auth.deleteUser = async () => undefined;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => {
        throw new Error('simulated transient Storage failure');
      },
    }),
  });

  try {
    const transient = await invoke(
      deleteUserCompletely,
      { uid: 'student-1' },
      'admin-1',
    );
    check('a transient failure is not reported as blocked', transient.blocked, false);
    check('a transient failure is reported as retryable', transient.retryable, true);
    check('a transient failure has a queued state', transient.state, 'queued');
    check(
      'the transient deletion remains durably queued',
      (await db
        .collection('accountDeletionJobs')
        .doc(accountDeletionJobId('student-1'))
        .get()).get('status'),
      'pending',
    );
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
    auth.deleteUser = originalDeleteUser;
    storageSdk.getStorage = originalGetStorage;
  }
}

async function testScheduledCancellationAndClaimRace() {
  section('scheduled cancellation and the due-date claim are serialized');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');
  const userRef = db.collection('users').doc('target-1');
  const jobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'));
  await userRef.update({
    deletionScheduled: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() - 1000),
    isActive: false,
  });
  await jobRef.set({
    type: 'accountDeletion',
    uid: 'target-1',
    status: 'scheduled',
    deletionClaimed: false,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() - 1000),
  });

  const originalUpdateUser = auth.updateUser;
  auth.updateUser = async () => undefined;
  try {
    await invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1');
  } finally {
    auth.updateUser = originalUpdateUser;
  }
  check(
    'the cancellation won before the due-date claim',
    (await userRef.get()).get('deletionScheduled'),
    false,
  );
  check(
    'the cancelled job cannot be claimed for deletion',
    await claimScheduledAccountDeletion(jobRef, 'target-1', Date.now()),
    false,
  );

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');
  await userRef.set({
    uid: 'target-1',
    role: 'student',
    roleClaimed: true,
    registrationCompleted: true,
    isActive: false,
    deletionScheduled: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() - 1000),
  });
  await jobRef.set({
    type: 'accountDeletion',
    uid: 'target-1',
    status: 'scheduled',
    deletionClaimed: false,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() - 1000),
  });

  check(
    'the due-date worker can claim the scheduled deletion',
    await claimScheduledAccountDeletion(jobRef, 'target-1', Date.now()),
    true,
  );
  await expectDenied(
    'a cancellation after the claim is refused',
    () => invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1'),
    'failed-precondition',
  );
  await expectDenied(
    'a new grace period cannot reopen a claimed deletion',
    () =>
      invoke(
        scheduleUserDeletion,
        { uid: 'target-1', days: 7 },
        'admin-1',
      ),
    'failed-precondition',
  );
  check(
    'the claimed account is still marked for deletion',
    (await userRef.get()).get('deletionScheduled'),
    true,
  );

  // Run both operations at the same time. The job document is their common
  // serialization point: exactly one transaction may win.
  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');
  await userRef.set({
    uid: 'target-1',
    role: 'student',
    roleClaimed: true,
    registrationCompleted: true,
    isActive: false,
    deletionScheduled: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() - 1000),
  });
  await jobRef.set({
    type: 'accountDeletion',
    uid: 'target-1',
    status: 'scheduled',
    deletionClaimed: false,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() - 1000),
  });

  const concurrentOriginalUpdateUser = auth.updateUser;
  const concurrentOriginalRevoke = auth.revokeRefreshTokens;
  auth.updateUser = async () => undefined;
  auth.revokeRefreshTokens = async () => undefined;
  let concurrentResults;
  try {
    concurrentResults = await Promise.allSettled([
      invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1'),
      claimScheduledAccountDeletion(jobRef, 'target-1', Date.now()),
    ]);
  } finally {
    auth.updateUser = concurrentOriginalUpdateUser;
    auth.revokeRefreshTokens = concurrentOriginalRevoke;
  }

  const concurrentCancel = concurrentResults[0];
  const concurrentClaim = concurrentResults[1];
  const cancellationWon =
    concurrentCancel.status === 'fulfilled' &&
    concurrentClaim.status === 'fulfilled' &&
    concurrentClaim.value === false;
  const claimWon =
    concurrentClaim.status === 'fulfilled' &&
    concurrentClaim.value === true &&
    concurrentCancel.status === 'rejected';
  check(
    'exactly one concurrent cancellation or claim operation wins',
    cancellationWon || claimWon,
    true,
  );
}

async function testAuthLifecycleTransitionsRemainRetryable() {
  section('Auth disable and restore transitions remain retryable');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');

  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.updateUser = async () => {
    throw new Error('simulated Auth disable failure');
  };
  auth.revokeRefreshTokens = async () => undefined;

  await expectDenied(
    'a failed Auth disable is reported',
    () =>
      invoke(
        scheduleUserDeletion,
        { uid: 'target-1', days: 7 },
        'admin-1',
      ),
    'internal',
  );

  const userRef = db.collection('users').doc('target-1');
  const jobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'));
  check(
    'the live profile is disabled before Auth is updated',
    (await userRef.get()).get('isActive'),
    false,
  );
  check(
    'the durable scheduled job remains pending',
    (await jobRef.get()).get('status'),
    'scheduled',
  );
  check(
    'the failed Auth disable is recorded for retry',
    (await jobRef.get()).get('authDisablePending'),
    true,
  );

  auth.updateUser = async () => undefined;
  try {
    await processAccountDeletionJobs.run({});
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
  }
  check(
    'the worker completes the Auth disable',
    (await jobRef.get()).get('authDisablePending'),
    false,
  );

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');
  await userRef.set({
    uid: 'target-1',
    role: 'student',
    roleClaimed: true,
    registrationCompleted: true,
    isActive: false,
    deletionScheduled: true,
    deletionState: 'scheduled',
    deletionPreviousIsActive: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });
  await jobRef.set({
    type: 'accountDeletion',
    uid: 'target-1',
    status: 'scheduled',
    deletionClaimed: false,
    authDisablePending: false,
    previousIsActive: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });

  auth.updateUser = async () => {
    throw new Error('simulated Auth restore failure');
  };
  try {
    await expectDenied(
      'a failed Auth restore is reported',
      () => invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1'),
      'internal',
    );
  } finally {
    auth.updateUser = originalUpdateUser;
  }
  check(
    'the cancelled job keeps the Auth restore pending',
    (await jobRef.get()).get('status'),
    'cancelled',
  );
  check(
    'the cancelled job records the pending Auth restore',
    (await jobRef.get()).get('authEnablePending'),
    true,
  );
  check(
    'the profile stays inactive while the Auth restore is pending',
    (await userRef.get()).get('isActive'),
    false,
  );

  auth.updateUser = async () => undefined;
  try {
    await processAccountDeletionJobs.run({});
  } finally {
    auth.updateUser = originalUpdateUser;
  }
  check(
    'the worker completes the cancelled Auth restore',
    (await jobRef.get()).exists,
    false,
  );
  check(
    'the worker restores the previous activation state',
    (await userRef.get()).get('isActive'),
    true,
  );
}

async function testInterruptedRoomDeletionIsResumed() {
  section('an interrupted listing deletion is resumed by the durable worker');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-RESUME', 'owner-1', {
    listingGeneration: 'generation-old',
    status: 'inactive',
    deletionInProgress: true,
    deletionRequestedBy: 'owner-1',
    deletionOperationId: 'operation-old',
  });
  await seedRequest('JRQ-RESUME', {
    roomId: 'RM-RESUME',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'pending',
  });
  await db.collection('roomDeletionTombstones').doc('RM-RESUME').set({
    type: 'roomDeletionTombstone',
    roomId: 'RM-RESUME',
    ownerId: 'owner-1',
    listingGeneration: 'generation-old',
    deletionOperationId: 'operation-old',
    createdAt: firestore.Timestamp.now(),
  });
  await db.collection('cleanupJobs').doc('resume-room-deletion').set({
    type: 'roomDeletion',
    roomId: 'RM-RESUME',
    ownerId: 'owner-1',
    listingGeneration: 'generation-old',
    deletionOperationId: 'operation-old',
    deletionRequestedBy: 'owner-1',
    previousStatus: 'available',
    attempts: 0,
  });

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
    'the resumed worker deleted the marked listing',
    (await db.collection('rooms').doc('RM-RESUME').get()).exists,
    false,
  );
  check(
    'the resumed worker cancelled the open request',
    (
      await db
        .collection('joinRequests')
        .doc('JRQ-RESUME')
        .get()
    ).get('status'),
    'cancelled',
  );
  check(
    'the resumed worker removed the deletion job',
    (await db.collection('cleanupJobs').doc('resume-room-deletion').get()).exists,
    false,
  );
  check(
    'the completed cleanup released the room-id tombstone',
    (
      await db.collection('roomDeletionTombstones').doc('RM-RESUME').get()
    ).exists,
    false,
  );
}

async function testMismatchedPrefixCleanupCannotDeleteALaterListing() {
  section('a prefix cleanup for another listing generation deletes no files');

  await reset();
  await db.collection('roomDeletionTombstones').doc('RM-REUSED').set({
    type: 'roomDeletionTombstone',
    roomId: 'RM-REUSED',
    ownerId: 'owner-new',
    listingGeneration: 'generation-new',
    deletionOperationId: 'operation-new',
    createdAt: firestore.Timestamp.now(),
  });
  await db.collection('cleanupJobs').doc('stale-prefix-cleanup').set({
    type: 'roomPhotoPrefix',
    roomId: 'RM-REUSED',
    ownerId: 'owner-old',
    listingGeneration: 'generation-old',
    storagePrefix: 'rooms/owner-old/RM-REUSED/',
    deletionOperationId: 'operation-old',
    attempts: 0,
  });

  const deletedPaths = [];
  const originalGetStorage = storageSdk.getStorage;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => [[]],
      file: (path) => ({
        delete: async () => {
          deletedPaths.push(path);
        },
      }),
    }),
  });

  try {
    await processRoomPhotoCleanupJobs.run({});
  } finally {
    storageSdk.getStorage = originalGetStorage;
  }

  check('the stale prefix cleanup deleted no file', deletedPaths, []);
  check(
    'the stale prefix cleanup was quarantined',
    (
      await db.collection('cleanupJobs').doc('stale-prefix-cleanup').get()
    ).get('type'),
    'quarantinedRoomPhotoCleanup',
  );
  check(
    'the current listing tombstone was preserved',
    (
      await db.collection('roomDeletionTombstones').doc('RM-REUSED').get()
    ).get('deletionOperationId'),
    'operation-new',
  );
}

async function testReviewCleanupKeepsADifferentListingGeneration() {
  section('review cleanup keeps a review from a different listing generation');

  await reset();
  await db.collection('roomDeletionTombstones').doc('RM-REVIEW-GEN').set({
    type: 'roomDeletionTombstone',
    roomId: 'RM-REVIEW-GEN',
    ownerId: 'owner-1',
    listingGeneration: 'generation-old',
    deletionOperationId: 'operation-old',
    createdAt: firestore.Timestamp.now(),
  });
  await db.collection('cleanupJobs').doc('old-review-cleanup').set({
    type: 'roomPhotoPrefix',
    roomId: 'RM-REVIEW-GEN',
    ownerId: 'owner-1',
    listingGeneration: 'generation-old',
    storagePrefix: 'rooms/owner-1/RM-REVIEW-GEN/',
    deletionOperationId: 'operation-old',
    deleteRoomReviews: true,
    reviewCutoff: firestore.Timestamp.now(),
    attempts: 0,
  });
  await db.collection('roomReviews').doc('REV-NEW-GENERATION').set({
    reviewId: 'REV-NEW-GENERATION',
    roomId: 'RM-REVIEW-GEN',
    studentId: 'student-1',
    ownerId: 'owner-1',
    listingGeneration: 'generation-new',
    rating: 5,
    comment: 'Review of the later listing',
    createdAt: firestore.Timestamp.now(),
    updatedAt: firestore.Timestamp.now(),
  });

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
    'the review of the later listing generation survived',
    (
      await db.collection('roomReviews').doc('REV-NEW-GENERATION').get()
    ).exists,
    true,
  );
}

async function testReviewCleanupKeepsAReviewUpdatedAfterTheCutoff() {
  section('review cleanup keeps a legacy review updated after its cutoff');

  await reset();
  const cutoff = firestore.Timestamp.now();
  await db.collection('roomDeletionTombstones').doc('RM-REVIEW-UPDATED').set({
    type: 'roomDeletionTombstone',
    roomId: 'RM-REVIEW-UPDATED',
    ownerId: 'owner-1',
    listingGeneration: 'generation-old',
    deletionOperationId: 'operation-old',
    createdAt: firestore.Timestamp.now(),
  });
  await db.collection('cleanupJobs').doc('updated-review-cleanup').set({
    type: 'roomPhotoPrefix',
    roomId: 'RM-REVIEW-UPDATED',
    ownerId: 'owner-1',
    listingGeneration: 'generation-old',
    storagePrefix: 'rooms/owner-1/RM-REVIEW-UPDATED/',
    deletionOperationId: 'operation-old',
    deleteRoomReviews: true,
    reviewCutoff: cutoff,
    attempts: 0,
  });
  await db.collection('roomReviews').doc('REV-UPDATED-AFTER-CUTOFF').set({
    reviewId: 'REV-UPDATED-AFTER-CUTOFF',
    roomId: 'RM-REVIEW-UPDATED',
    studentId: 'student-1',
    ownerId: 'owner-1',
    rating: 5,
    comment: 'The review was updated after the cleanup decision',
    createdAt: firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
    updatedAt: firestore.Timestamp.fromMillis(Date.now() + 60 * 1000),
  });

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
    'the review updated after the cutoff survived',
    (
      await db
        .collection('roomReviews')
        .doc('REV-UPDATED-AFTER-CUTOFF')
        .get()
    ).exists,
    true,
  );
}

async function testReferencedPathCleanupAlwaysLocksTheRoom() {
  section('room-photo path cleanup locks the room even when every path is referenced');

  await reset();
  const roomId = 'RM-ALWAYS-LOCKED';
  const objectPath = `rooms/owner-1/${roomId}/photo.jpg`;
  const downloadUrl =
    'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/' +
    `${encodeURIComponent(objectPath)}?alt=media&token=abc`;
  await seedRoom(roomId, 'owner-1', {
    listingGeneration: 'generation-lock',
    images: [downloadUrl],
  });
  await db.collection('cleanupJobs').doc('always-locked-path-cleanup').set({
    type: 'roomPhotoPaths',
    roomId,
    ownerId: 'owner-1',
    listingGeneration: 'generation-lock',
    paths: [objectPath],
    attempts: 0,
  });

  let observedCleanupLock = false;
  const originalRunTransaction = db.runTransaction;
  db.runTransaction = async (updateFunction) =>
    originalRunTransaction.call(db, async (transaction) => {
      const originalUpdate = transaction.update.bind(transaction);
      transaction.update = (ref, data, ...rest) => {
        const lock = data?.photoCleanupLock;
        if (
          ref.path === `rooms/${roomId}` &&
          lock &&
          typeof lock === 'object' &&
          typeof lock.token === 'string'
        ) {
          observedCleanupLock = true;
        }
        return originalUpdate(ref, data, ...rest);
      };
      return updateFunction(transaction);
    });

  const deletedPaths = [];
  const originalGetStorage = storageSdk.getStorage;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => [[]],
      file: (path) => ({
        delete: async () => {
          deletedPaths.push(path);
        },
      }),
    }),
  });

  try {
    await processRoomPhotoCleanupJobs.run({});
  } finally {
    db.runTransaction = originalRunTransaction;
    storageSdk.getStorage = originalGetStorage;
  }

  check(
    'the path cleanup installed the room lock',
    observedCleanupLock,
    true,
  );
  check('the referenced file was not deleted', deletedPaths, []);
  check(
    'the completed path cleanup removed its job',
    (
      await db
        .collection('cleanupJobs')
        .doc('always-locked-path-cleanup')
        .get()
    ).exists,
    false,
  );
  check(
    'the completed path cleanup released the room lock',
    (await db.collection('rooms').doc(roomId).get()).get('photoCleanupLock'),
    undefined,
  );
}

async function testAdminCanTakeOverAStrandedListingDeletion() {
  section('only a live administrator can take over a stranded listing deletion');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('owner-2', 'owner');
  await seedRoom('RM-TAKEOVER', 'owner-1', {
    listingGeneration: 'generation-old',
    status: 'inactive',
    deletionInProgress: true,
    deletionRequestedBy: 'owner-1',
    deletionOperationId: 'operation-old',
  });
  await db.collection('roomDeletionTombstones').doc('RM-TAKEOVER').set({
    type: 'roomDeletionTombstone',
    roomId: 'RM-TAKEOVER',
    ownerId: 'owner-1',
    listingGeneration: 'generation-old',
    deletionOperationId: 'operation-old',
    createdAt: firestore.Timestamp.now(),
  });
  await db
    .collection('cleanupJobs')
    .doc(roomDeletionJobDocumentId('RM-TAKEOVER'))
    .set({
      type: 'roomDeletion',
      roomId: 'RM-TAKEOVER',
      ownerId: 'owner-1',
      listingGeneration: 'generation-old',
      deletionOperationId: 'operation-old',
      deletionRequestedBy: 'owner-1',
      previousStatus: 'available',
      attempts: 0,
    });

  await expectDenied(
    'another owner cannot take over the deletion',
    () => invoke(deleteRoomListing, { roomId: 'RM-TAKEOVER' }, 'owner-2'),
    'permission-denied',
  );
  const roomAfterOwnerAttempt = await db
    .collection('rooms')
    .doc('RM-TAKEOVER')
    .get();
  check(
    'the other owner did not replace the deletion marker',
    roomAfterOwnerAttempt.get('deletionOperationId'),
    'operation-old',
  );

  const originalGetStorage = storageSdk.getStorage;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => [[]],
      file: () => ({ delete: async () => undefined }),
    }),
  });
  try {
    await invoke(
      deleteRoomListing,
      { roomId: 'RM-TAKEOVER' },
      'admin-1',
    );
  } finally {
    storageSdk.getStorage = originalGetStorage;
  }

  check(
    'the administrator completed the stranded deletion',
    (await db.collection('rooms').doc('RM-TAKEOVER').get()).exists,
    false,
  );
  check(
    'the administrator takeover released the room-id tombstone',
    (
      await db.collection('roomDeletionTombstones').doc('RM-TAKEOVER').get()
    ).exists,
    false,
  );
  check(
    'the administrator takeover removed the durable deletion job',
    (
      await db
        .collection('cleanupJobs')
        .doc(roomDeletionJobDocumentId('RM-TAKEOVER'))
        .get()
    ).exists,
    false,
  );
}

async function testRoomPhotoCleanupFailureIsDurableAndRetryable() {
  section('room-photo cleanup keeps a failed job durable and retryable');

  await reset();
  const jobRef = db.collection('cleanupJobs').doc('retry-cleanup');
  await jobRef.set({
    type: 'roomPhotoPrefix',
    roomId: 'RM-1',
    ownerId: 'owner-1',
    storagePrefix: 'rooms/owner-1/RM-1/',
    attempts: 0,
  });

  const originalGetStorage = storageSdk.getStorage;
  let failStorage = true;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => {
        if (failStorage) throw new Error('simulated room-photo Storage outage');
        return [[]];
      },
      file: () => ({
        delete: async () => undefined,
      }),
    }),
  });

  try {
    let workerError = null;
    try {
      await processRoomPhotoCleanupJobs.run({});
    } catch (error) {
      workerError = error;
    }
    check(
      'the failed worker reports the aggregate failure',
      String(workerError?.message || '').includes('cleanup job'),
      true,
    );

    const failed = await jobRef.get();
    check('the failed cleanup job is still pending', failed.get('type'), 'roomPhotoPrefix');
    check('the failed cleanup recorded one attempt', failed.get('attempts'), 1);
    check(
      'the failed cleanup has a retry time',
      typeof failed.get('nextAttemptAt')?.toMillis === 'function',
      true,
    );

    failStorage = false;
    await jobRef.update({
      nextAttemptAt: firestore.Timestamp.fromMillis(Date.now() - 1000),
    });
    await processRoomPhotoCleanupJobs.run({});
    check(
      'the retry removed the completed cleanup job',
      (await jobRef.get()).exists,
      false,
    );
  } finally {
    storageSdk.getStorage = originalGetStorage;
  }
}

async function testRoomPhotoCleanupQuarantinesPoisonJobs() {
  section('room-photo cleanup quarantines a job which can never run');

  await reset();
  const invalidRef = db.collection('cleanupJobs').doc('invalid-cleanup');
  await invalidRef.set({
    type: 'roomPhotoPaths',
    roomId: 'RM-1',
    ownerId: '',
    paths: [],
  });

  const originalGetStorage = storageSdk.getStorage;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => [[]],
      file: () => ({
        delete: async () => undefined,
      }),
    }),
  });
  try {
    await processRoomPhotoCleanupJobs.run({});
  } finally {
    storageSdk.getStorage = originalGetStorage;
  }

  const quarantined = await invalidRef.get();
  check(
    'the invalid job was quarantined',
    quarantined.get('type'),
    'quarantinedRoomPhotoCleanup',
  );
  check(
    'the invalid job recorded why it was quarantined',
    String(quarantined.get('lastError') || '').includes('invalid'),
    true,
  );
}

async function testPrivateLocationWriteIsOwnerOnlyAndAtomic() {
  section('the private location is owner-only and keeps one authoritative copy');

  const previousStage = process.env.ROOM_LOCATION_STAGE;
  process.env.ROOM_LOCATION_STAGE = 'dual';

  try {
    await reset();
    await seedUser('owner-1', 'owner');
    await seedUser('owner-2', 'owner');
    await seedUser('student-1', 'student');
    await seedRoom('RM-LOCATION', 'owner-1', {
      location: { city: 'Bengaluru', state: 'Karnataka' },
    });

    const result = await invoke(
      setRoomPrivateLocation,
      {
        roomId: 'RM-LOCATION',
        address: '42 Private Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        latitude: 12.9716,
        longitude: 77.5946,
      },
      'owner-1',
    );
    check('the owner location write succeeded', result.success, true);

    const privateSnapshot = await db
      .collection('roomPrivate')
      .doc('RM-LOCATION')
      .get();
    const publicSnapshot = await db.collection('rooms').doc('RM-LOCATION').get();
    check('the private document exists', privateSnapshot.exists, true);
    check(
      'the private document has the exact address',
      privateSnapshot.get('address'),
      '42 Private Road',
    );
    check(
      'the private owner id came from the live room',
      privateSnapshot.get('ownerId'),
      'owner-1',
    );
    check(
      'the dual stage keeps the legacy public address in sync',
      publicSnapshot.get('location.address'),
      '42 Private Road',
    );
    check(
      'the private and public copies share one location revision',
      publicSnapshot.get('locationRevision'),
      privateSnapshot.get('locationRevision'),
    );

    await expectDenied(
      'a different owner cannot replace the private location',
      () =>
        invoke(
          setRoomPrivateLocation,
          {
            roomId: 'RM-LOCATION',
            address: 'Hijacked Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            pincode: '560001',
          },
          'owner-2',
        ),
      'permission-denied',
    );
    await expectDenied(
      'a student cannot write a private room location',
      () =>
        invoke(
          setRoomPrivateLocation,
          {
            roomId: 'RM-LOCATION',
            address: 'Student Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            pincode: '560001',
          },
          'student-1',
        ),
      'permission-denied',
    );

    await seedUser('owner-1', 'student');
    await expectDenied(
      'a demoted owner cannot replace the private location',
      () =>
        invoke(
          setRoomPrivateLocation,
          {
            roomId: 'RM-LOCATION',
            address: 'Demoted Owner Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            pincode: '560001',
          },
          'owner-1',
        ),
      'permission-denied',
    );

    await seedUser('owner-1', 'owner');
    process.env.ROOM_LOCATION_STAGE = 'private';
    await invoke(
      setRoomPrivateLocation,
      {
        roomId: 'RM-LOCATION',
        address: '42 Private Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        latitude: 12.9716,
        longitude: 77.5946,
      },
      'owner-1',
    );
    const privatePublicRoom = await db
      .collection('rooms')
      .doc('RM-LOCATION')
      .get();
    check(
      'the private stage removes the nested public address',
      privatePublicRoom.get('location.address'),
      undefined,
    );
    check(
      'the private stage removes the flat public coordinates',
      privatePublicRoom.get('latitude'),
      undefined,
    );
    check(
      'the private stage publishes only a coarse geo cell',
      privatePublicRoom.get('geoCell'),
      '12.97,77.59',
    );
    check(
      'the private stage keeps the exact private address',
      (await db.collection('roomPrivate').doc('RM-LOCATION').get()).get('address'),
      '42 Private Road',
    );
  } finally {
    if (previousStage === undefined) delete process.env.ROOM_LOCATION_STAGE;
    else process.env.ROOM_LOCATION_STAGE = previousStage;
  }
}

async function testVisitDetailsUseThePrivateLocation() {
  section('visit details use the private location for an accepted student');

  const previousStage = process.env.ROOM_LOCATION_STAGE;
  process.env.ROOM_LOCATION_STAGE = 'dual';

  try {
    await reset();
    await seedUser('owner-1', 'owner');
    await seedUser('student-1', 'student');
    await seedRoom('RM-VISIT', 'owner-1');
    await db.collection('roomPrivate').doc('RM-VISIT').set({
      roomId: 'RM-VISIT',
      ownerId: 'owner-1',
      address: '99 Private Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
      updatedAt: firestore.Timestamp.now(),
    });
    await seedRequest('JRQ-VISIT', {
      roomId: 'RM-VISIT',
      studentId: 'student-1',
      ownerId: 'owner-1',
      status: 'ownerConfirmed',
    });

    const details = await invoke(
      getRoomVisitDetails,
      { roomId: 'RM-VISIT' },
      'student-1',
    );
    check(
      'the accepted student receives the private address',
      details.address,
      '99 Private Road',
    );
    check(
      'the stale public address is not returned',
      details.address === '12 Legacy Street',
      false,
    );
    check(
      'the visit details contain the exact pincode',
      details.pincode,
      '560001',
    );

    await expectDenied(
      'the owner cannot use the student visit-details path',
      () => invoke(getRoomVisitDetails, { roomId: 'RM-VISIT' }, 'owner-1'),
      'permission-denied',
    );

    await seedUser('student-1', 'owner');
    await expectDenied(
      'a demoted student cannot keep reading visit details',
      () => invoke(getRoomVisitDetails, { roomId: 'RM-VISIT' }, 'student-1'),
      'permission-denied',
    );
    await seedUser('student-1', 'student');

    await seedRoom('RM-PENDING', 'owner-1');
    await seedRequest('JRQ-PENDING', {
      roomId: 'RM-PENDING',
      studentId: 'student-1',
      ownerId: 'owner-1',
      status: 'pending',
    });
    await expectDenied(
      'a student without an accepted request cannot read the address',
      () => invoke(getRoomVisitDetails, { roomId: 'RM-PENDING' }, 'student-1'),
      'failed-precondition',
    );

    await db.collection('roomPrivate').doc('RM-VISIT').delete();
    const fallback = await invoke(
      getRoomVisitDetails,
      { roomId: 'RM-VISIT' },
      'student-1',
    );
    check(
      'the dual stage has a controlled legacy fallback',
      fallback.address,
      '12 Legacy Street',
    );

    process.env.ROOM_LOCATION_STAGE = 'private';
    await expectDenied(
      'the private stage has no legacy public-address fallback',
      () => invoke(getRoomVisitDetails, { roomId: 'RM-VISIT' }, 'student-1'),
      'failed-precondition',
    );
  } finally {
    if (previousStage === undefined) delete process.env.ROOM_LOCATION_STAGE;
    else process.env.ROOM_LOCATION_STAGE = previousStage;
  }
}

async function testPrivateLocationMigrationIsIdempotentAndGated() {
  section('the private-location migration is idempotent and globally gated');

  const previousStage = process.env.ROOM_LOCATION_STAGE;
  process.env.ROOM_LOCATION_STAGE = 'dual';

  try {
    await reset();
    await seedUser('admin-1', 'admin');
    await seedUser('owner-1', 'owner');
    await seedRoom('RM-MIGRATE', 'owner-1');

    const dryRun = await invoke(
      migrateRoomPrivateLocations,
      { limit: 10 },
      'admin-1',
    );
    check('the migration dry run creates nothing', dryRun.created, 0);
    check('the migration dry run reports its candidates', dryRun.candidates, 1);
    check(
      'the migration dry run leaves the private document absent',
      (await db.collection('roomPrivate').doc('RM-MIGRATE').get()).exists,
      false,
    );

    const migrated = await invoke(
      migrateRoomPrivateLocations,
      { dryRun: false, limit: 10 },
      'admin-1',
    );
    check('the migration created the private counterpart', migrated.created, 1);
    check(
      'the migration copied the exact legacy address',
      (await db.collection('roomPrivate').doc('RM-MIGRATE').get()).get('address'),
      '12 Legacy Street',
    );

    const privateRef = db.collection('roomPrivate').doc('RM-MIGRATE');
    await privateRef.update({
      address: '101 Newer Private Road',
      locationRevision: 'owner-newer',
      updatedAt: firestore.Timestamp.now(),
    });
    const repeated = await invoke(
      migrateRoomPrivateLocations,
      { dryRun: false, limit: 10 },
      'admin-1',
    );
    check('a repeated migration creates nothing', repeated.created, 0);
    check('a repeated migration preserves the private copy', repeated.preserved, 1);
    check(
      'a repeated migration does not overwrite a newer private value',
      (await privateRef.get()).get('address'),
      '101 Newer Private Road',
    );

    const mismatch = await invoke(
      verifyRoomPrivateLocations,
      { all: true },
      'admin-1',
    );
    check('verification detects the stale public address', mismatch.publicMismatch, 1);
    check('verification is not ready while values disagree', mismatch.readyToFinalize, false);

    process.env.ROOM_LOCATION_STAGE = 'private';
    await expectDenied(
      'finalization refuses while the public and private values disagree',
      () =>
        invoke(
          finalizeRoomLocationPrivacy,
          { dryRun: false, limit: 10 },
          'admin-1',
        ),
      'failed-precondition',
    );
    check(
      'the refused finalization did not scrub the public address',
      (await db.collection('rooms').doc('RM-MIGRATE').get()).get('location.address'),
      '12 Legacy Street',
    );

    await db.collection('rooms').doc('RM-MIGRATE').update({
      location: {
        address: '101 Newer Private Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        latitude: 12.9716,
        longitude: 77.5946,
      },
      latitude: 12.9716,
      longitude: 77.5946,
    });
    await seedRoom('RM-MISSING', 'owner-1');
    const missing = await invoke(
      verifyRoomPrivateLocations,
      { all: true },
      'admin-1',
    );
    check('verification detects a missing private counterpart', missing.missingPrivate, 1);
    check('verification is not ready with a missing counterpart', missing.readyToFinalize, false);
    await expectDenied(
      'finalization refuses while any room has no private counterpart',
      () =>
        invoke(
          finalizeRoomLocationPrivacy,
          { dryRun: false, limit: 10 },
          'admin-1',
        ),
      'failed-precondition',
    );

    await db.collection('rooms').doc('RM-MISSING').delete();
    const verified = await invoke(
      verifyRoomPrivateLocations,
      { all: true },
      'admin-1',
    );
    check('verification passes after every room is migrated', verified.readyToFinalize, true);

    const finalDryRun = await invoke(
      finalizeRoomLocationPrivacy,
      { dryRun: true, limit: 10 },
      'admin-1',
    );
    check('the finalization dry run changes nothing', finalDryRun.finalized, 0);
    check('the finalization dry run reports its candidates', finalDryRun.wouldFinalize, 1);
    check(
      'the finalization dry run leaves the public address in place',
      (await db.collection('rooms').doc('RM-MIGRATE').get()).get('location.address'),
      '101 Newer Private Road',
    );

    const finalized = await invoke(
      finalizeRoomLocationPrivacy,
      { dryRun: false, limit: 10 },
      'admin-1',
    );
    check('the finalization scrubbed the public room', finalized.finalized, 1);
    const publicRoom = await db.collection('rooms').doc('RM-MIGRATE').get();
    check(
      'the finalized public room has no exact address',
      publicRoom.get('location.address'),
      undefined,
    );
    check(
      'the finalized public room has no exact pincode',
      publicRoom.get('location.pincode'),
      undefined,
    );
    check(
      'the finalized public room has only a coarse geo cell',
      publicRoom.get('geoCell'),
      '12.97,77.59',
    );
    check(
      'the finalized room keeps its exact private address',
      (await privateRef.get()).get('address'),
      '101 Newer Private Road',
    );
    const finalizedUpdateTime = publicRoom.updateTime.toMillis();

    const repeatedFinalization = await invoke(
      finalizeRoomLocationPrivacy,
      { dryRun: false, limit: 10 },
      'admin-1',
    );
    check('a repeated finalization changes nothing', repeatedFinalization.finalized, 0);
    check(
      'a repeated finalization recognizes the already-private room',
      repeatedFinalization.alreadyPrivate,
      1,
    );
    check(
      'a repeated finalization does not rewrite the public room',
      (await db.collection('rooms').doc('RM-MIGRATE').get()).updateTime.toMillis(),
      finalizedUpdateTime,
    );
  } finally {
    if (previousStage === undefined) delete process.env.ROOM_LOCATION_STAGE;
    else process.env.ROOM_LOCATION_STAGE = previousStage;
  }
}

async function testPrivateLocationMigrationValidatesAndRepairsSafely() {
  section('the private-location migration validates data and repairs safely');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-INCOMPLETE', 'owner-1', {
    location: { city: 'Bengaluru', state: 'Karnataka' },
  });
  await seedRoom('RM-WRONG-ID', 'owner-1', { roomId: 'WRONG-LEGACY-ID' });

  const preview = await invoke(
    migrateRoomPrivateLocations,
    { dryRun: true, limit: 10 },
    'admin-1',
  );
  check('the migration rejects an incomplete legacy location', preview.invalidLegacyLocation, 1);
  check('the migration previews only complete candidates', preview.candidates, 1);
  check(
    'the migration previews the canonical room-id repair',
    preview.repairedPublicRoomId,
    1,
  );

  const migrated = await invoke(
    migrateRoomPrivateLocations,
    { dryRun: false, limit: 10 },
    'admin-1',
  );
  check('the migration did not create an invalid private document', migrated.created, 1);
  check(
    'the incomplete legacy location has no private counterpart',
    (await db.collection('roomPrivate').doc('RM-INCOMPLETE').get()).exists,
    false,
  );
  check(
    'the migration repairs the public room id',
    (await db.collection('rooms').doc('RM-WRONG-ID').get()).get('roomId'),
    'RM-WRONG-ID',
  );

  await db.collection('rooms').doc('RM-INCOMPLETE').update({
    location: {
      address: '22 Repaired Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
    },
    latitude: 12.9716,
    longitude: 77.5946,
  });
  const completed = await invoke(
    migrateRoomPrivateLocations,
    { dryRun: false, limit: 10 },
    'admin-1',
  );
  check('the repaired legacy location can now be migrated', completed.created, 1);

  const privateRef = db.collection('roomPrivate').doc('RM-INCOMPLETE');
  await privateRef.set({
    roomId: 'RM-INCOMPLETE',
    ownerId: 'owner-1',
    address: '99 Newer Owner Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    latitude: 12.9716,
    // Deliberately incomplete: the repair must replace the whole legacy
    // coordinate pair instead of preserving a half-pair.
    longitude: null,
    locationRevision: 'migration-v1',
    source: 'migration',
    createdAt: firestore.Timestamp.now(),
    updatedAt: firestore.Timestamp.now(),
  });
  const repaired = await invoke(
    migrateRoomPrivateLocations,
    { dryRun: false, limit: 10 },
    'admin-1',
  );
  check('the migration repairs an invalid migration-owned copy', repaired.repaired, 1);
  check(
    'the repair preserves the newer private address',
    (await privateRef.get()).get('address'),
    '99 Newer Owner Street',
  );
  check(
    'the repair fills the missing private pincode',
    (await privateRef.get()).get('pincode'),
    '560001',
  );
  check(
    'the repair replaces an incomplete private coordinate pair',
    (await privateRef.get()).get('longitude'),
    77.5946,
  );

  // The preserved private value is newer than the public copy. The owner
  // must publish it through the normal location callable before the global
  // audit can pass.
  await db.collection('rooms').doc('RM-INCOMPLETE').update({
    location: {
      address: '99 Newer Owner Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
    },
    latitude: 12.9716,
    longitude: 77.5946,
  });

  await seedRoom('RM-METADATA', 'owner-1');
  const metadataPrivateRef = db.collection('roomPrivate').doc('RM-METADATA');
  await metadataPrivateRef.set({
    // The exact values are complete and owner-authored, but the identity
    // metadata is corrupt. The migration must repair only that metadata.
    ownerId: 'wrong-owner',
    address: '12 Legacy Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: 77.5946,
    source: 'owner',
    locationRevision: 'owner-v1',
    updatedAt: firestore.Timestamp.now(),
  });
  const metadataRepair = await invoke(
    migrateRoomPrivateLocations,
    { dryRun: false, limit: 10 },
    'admin-1',
  );
  check(
    'the migration repairs corrupt private identity metadata',
    metadataRepair.repairedPrivateMetadata,
    1,
  );
  check(
    'the metadata repair uses the canonical private room id',
    (await metadataPrivateRef.get()).get('roomId'),
    'RM-METADATA',
  );
  check(
    'the metadata repair uses the live listing owner',
    (await metadataPrivateRef.get()).get('ownerId'),
    'owner-1',
  );
  check(
    'the metadata repair preserves the exact private address',
    (await metadataPrivateRef.get()).get('address'),
    '12 Legacy Street',
  );

  const verified = await invoke(
    verifyRoomPrivateLocations,
    { all: true },
    'admin-1',
  );
  check('the repaired migration passes global verification', verified.readyToFinalize, true);
  check(
    'global verification has no invalid public room id',
    verified.invalidPublicRoomId,
    0,
  );
}

async function testFinalizationLatchPreventsExactPublicRewrites() {
  section('finalization latches the private format and cannot be reopened');

  const previousStage = process.env.ROOM_LOCATION_STAGE;
  process.env.ROOM_LOCATION_STAGE = 'private';

  try {
    await reset();
    await seedUser('admin-1', 'admin');
    await seedUser('owner-1', 'owner');
    await seedRoom('RM-LATCH', 'owner-1');
    await db.collection('roomPrivate').doc('RM-LATCH').set({
      roomId: 'RM-LATCH',
      ownerId: 'owner-1',
      address: '12 Legacy Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
      source: 'owner',
      locationRevision: 'owner-v1',
      updatedAt: firestore.Timestamp.now(),
    });

    await setClientExactLocationWritesAllowed(true);
    await expectDenied(
      'finalization refuses while the legacy exact-write switch is open',
      () =>
        invoke(
          finalizeRoomLocationPrivacy,
          { dryRun: false, limit: 10 },
          'admin-1',
        ),
      'failed-precondition',
    );
    check(
      'the refused finalization did not set the durable latch',
      (await db.collection('system').doc('locationPrivacy').get()).get('finalized'),
      undefined,
    );

    await setClientExactLocationWritesAllowed(false);
    await invoke(
      finalizeRoomLocationPrivacy,
      { dryRun: false, limit: 10 },
      'admin-1',
    );
    const config = await db.collection('system').doc('locationPrivacy').get();
    check('the applied finalization sets the durable latch', config.get('finalized'), true);
    check(
      'the applied finalization closes the legacy exact-write switch',
      config.get('allowClientExactLocationWrites'),
      false,
    );

    // Simulate a stale Functions deployment which still has the dual-stage
    // environment variable. The durable latch must keep the exact value
    // private even in that deployment.
    process.env.ROOM_LOCATION_STAGE = 'dual';
    const write = await invoke(
      setRoomPrivateLocation,
      {
        roomId: 'RM-LATCH',
        address: '33 Post-Finalization Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        pincode: '560001',
        latitude: 12.9716,
        longitude: 77.5946,
      },
      'owner-1',
    );
    check('the post-finalization owner write uses private mode', write.stage, 'private');
    check(
      'the post-finalization public room has no exact address',
      (await db.collection('rooms').doc('RM-LATCH').get()).get('location.address'),
      undefined,
    );
    check(
      'the post-finalization private address is authoritative',
      (await db.collection('roomPrivate').doc('RM-LATCH').get()).get('address'),
      '33 Post-Finalization Road',
    );

    await expectDenied(
      'the legacy exact-write switch cannot be reopened after finalization',
      () => setClientExactLocationWritesAllowed(true),
      'cannot be reopened',
    );
    check(
      'the refused switch remains closed',
      (await db.collection('system').doc('locationPrivacy').get()).get(
        'allowClientExactLocationWrites',
      ),
      false,
    );
  } finally {
    if (previousStage === undefined) delete process.env.ROOM_LOCATION_STAGE;
    else process.env.ROOM_LOCATION_STAGE = previousStage;
  }
}

async function testPrivateLocationMigrationPaginatesDeterministically() {
  section('the private-location migration paginates by document id');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-A', 'owner-1');
  await seedRoom('RM-B', 'owner-1');
  await seedRoom('RM-C', 'owner-1');

  const first = await invoke(
    migrateRoomPrivateLocations,
    { dryRun: false, limit: 1 },
    'admin-1',
  );
  check('the first migration page created one room', first.created, 1);
  check('the first migration page has another page', first.hasMore, true);
  check(
    'the first migration page has a deterministic cursor',
    first.nextCursor,
    'RM-A',
  );

  const second = await invoke(
    migrateRoomPrivateLocations,
    { dryRun: false, limit: 1, cursor: first.nextCursor },
    'admin-1',
  );
  check('the second migration page created one room', second.created, 1);
  check('the second migration page has another page', second.hasMore, true);
  check(
    'the second migration page has a deterministic cursor',
    second.nextCursor,
    'RM-B',
  );

  const third = await invoke(
    migrateRoomPrivateLocations,
    { dryRun: false, limit: 1, cursor: second.nextCursor },
    'admin-1',
  );
  check('the final migration page created one room', third.created, 1);
  check('the final migration page has no more rooms', third.hasMore, false);

  for (const roomId of ['RM-A', 'RM-B', 'RM-C']) {
    check(
      `the migration created the private counterpart for ${roomId}`,
      (await db.collection('roomPrivate').doc(roomId).get()).exists,
      true,
    );
  }

  await expectDenied(
    'a non-admin cannot run the location migration',
    () =>
      invoke(
        migrateRoomPrivateLocations,
        { dryRun: false, limit: 1 },
        'owner-1',
      ),
    'permission-denied',
  );
}

async function testRoomDeletionRemovesThePrivateLocation() {
  section('deleting a listing removes its private location');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-DELETE', 'owner-1');
  await db.collection('roomPrivate').doc('RM-DELETE').set({
    roomId: 'RM-DELETE',
    ownerId: 'owner-1',
    address: '12 Legacy Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: 77.5946,
    updatedAt: firestore.Timestamp.now(),
  });

  await invoke(deleteRoomListing, { roomId: 'RM-DELETE' }, 'owner-1');
  check(
    'the public listing was deleted',
    (await db.collection('rooms').doc('RM-DELETE').get()).exists,
    false,
  );
  check(
    'the private location was deleted with the listing',
    (await db.collection('roomPrivate').doc('RM-DELETE').get()).exists,
    false,
  );
}

async function testRoomDeletionStopsWhenTheCallerLosesAuthority() {
  section('listing deletion stops when the caller loses live authority');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-REVOKED', 'owner-1');
  await seedRequest('JRQ-REVOKED', {
    roomId: 'RM-REVOKED',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'pending',
  });

  const originalRunTransaction = db.runTransaction;
  let transactionCount = 0;
  db.runTransaction = async (updateFunction) => {
    const result = await originalRunTransaction.call(db, updateFunction);
    transactionCount += 1;
    if (transactionCount === 1) {
      // The owner is demoted after the deletion marker was committed but
      // before the request cancellation and the final listing deletion.
      await db.collection('users').doc('owner-1').update({ role: 'student' });
    }
    return result;
  };

  try {
    await expectDenied(
      'a demoted owner cannot continue the listing deletion',
      () => invoke(deleteRoomListing, { roomId: 'RM-REVOKED' }, 'owner-1'),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }

  const room = await db.collection('rooms').doc('RM-REVOKED').get();
  const request = await db
    .collection('joinRequests')
    .doc('JRQ-REVOKED')
    .get();
  check('the listing was restored', room.get('status'), 'available');
  check(
    'the deletion marker was removed',
    room.get('deletionInProgress'),
    undefined,
  );
  check('the request was not cancelled', request.get('status'), 'pending');
}

async function testPaymentSubmissionUsesTheFreshRequestSnapshot() {
  section('a payment submission uses the fresh request snapshot');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-1', 'owner-1');
  await seedRequest('JRQ-FRESH', {
    status: 'studentConfirmed',
    monthlyRentAtJoin: 5000,
    commissionPercentageAtJoin: 30,
    platformFeePayer: 'owner',
  });

  const requestRef = db.collection('joinRequests').doc('JRQ-FRESH');
  const originalRunTransaction = db.runTransaction;
  let requestUpdated = false;
  db.runTransaction = async (updateFunction) => {
    if (!requestUpdated) {
      requestUpdated = true;
      // This update happens after submitPayment's preliminary read but before
      // the transaction's own read. The committed payment must use these
      // fresh terms rather than the stale preliminary snapshot.
      await requestRef.update({
        monthlyRentAtJoin: 6000,
        commissionPercentageAtJoin: 10,
        platformFeePayer: 'owner',
      });
    }
    return originalRunTransaction.call(db, updateFunction);
  };

  try {
    await invoke(
      submitPayment,
      {
        requestId: 'JRQ-FRESH',
        reference: 'UPI-FRESH-TERMS',
        method: 'upi',
      },
      'owner-1',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }

  const payment = await db.collection('payments').doc('JRQ-FRESH').get();
  const request = await requestRef.get();
  check('the payment records the fresh amount', payment.get('amount'), 600);
  check('the payment records the fresh percentage', payment.get('feePercentage'), 10);
  check('the request records the fresh amount', request.get('advanceAmount'), 600);
  check(
    'the request keeps the fresh agreed percentage',
    request.get('commissionPercentageAtJoin'),
    10,
  );
}

async function testMalformedPaymentCannotBeVerified() {
  section('a malformed payment cannot be verified');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRequest('JRQ-BAD-AMOUNT', { status: 'studentConfirmed' });
  await db.collection('rooms').doc('RM-1').set({
    roomId: 'RM-1',
    ownerId: 'owner-1',
    title: 'Room',
    monthlyRent: 5000,
    occupancy: 2,
    currentOccupancy: 0,
    status: 'available',
  });
  await db.collection('payments').doc('JRQ-BAD-AMOUNT').set({
    requestId: 'JRQ-BAD-AMOUNT',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'RM-1',
    // The amount is malformed and must not be treated as a waived fee.
    amount: 'not-a-number',
    feePercentage: 30,
    reference: 'UPI-BAD-AMOUNT',
    method: 'upi',
    payer: 'owner',
    feeWaived: false,
    status: 'submitted',
  });

  await expectDenied(
    'a malformed payment amount cannot be verified',
    () =>
      invoke(
        verifyPayment,
        { requestId: 'JRQ-BAD-AMOUNT', approve: true },
        'admin-1',
      ),
    'failed-precondition',
  );
  check(
    'the malformed payment stays submitted',
    (await db.collection('payments').doc('JRQ-BAD-AMOUNT').get()).get('status'),
    'submitted',
  );
  check(
    'the malformed payment does not activate the request',
    (await db.collection('joinRequests').doc('JRQ-BAD-AMOUNT').get()).get('status'),
    'studentConfirmed',
  );

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRequest('JRQ-BAD-PERCENT', {
    status: 'studentConfirmed',
    commissionPercentageAtJoin: 'not-a-number',
  });
  await db.collection('rooms').doc('RM-1').set({
    roomId: 'RM-1',
    ownerId: 'owner-1',
    title: 'Room',
    monthlyRent: 5000,
    occupancy: 2,
    currentOccupancy: 0,
    status: 'available',
  });
  await db.collection('payments').doc('JRQ-BAD-PERCENT').set({
    requestId: 'JRQ-BAD-PERCENT',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'RM-1',
    amount: 1500,
    feePercentage: 30,
    reference: 'UPI-BAD-PERCENT',
    method: 'upi',
    payer: 'owner',
    feeWaived: false,
    status: 'submitted',
  });

  await expectDenied(
    'a malformed commission percentage cannot be verified',
    () =>
      invoke(
        verifyPayment,
        { requestId: 'JRQ-BAD-PERCENT', approve: true },
        'admin-1',
      ),
    'failed-precondition',
  );
  check(
    'the malformed percentage does not activate the request',
    (await db.collection('joinRequests').doc('JRQ-BAD-PERCENT').get()).get('status'),
    'studentConfirmed',
  );
}

async function testAdminCannotRejectASubmittedPayment() {
  section('an admin cannot reject a request with a submitted payment');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-1', 'owner-1');
  await seedRequest('JRQ-PAID', {
    status: 'studentConfirmed',
    platformFeePayer: 'owner',
  });

  await invoke(submitPayment, {
    requestId: 'JRQ-PAID',
    reference: 'UPI-PAID',
    method: 'upi',
  }, 'owner-1');

  await expectDenied(
    'the admin review refuses to reject the paid request',
    () =>
      invoke(adminReviewRequest, {
        requestId: 'JRQ-PAID',
        approve: false,
        rejectionReason: 'Rejected by mistake',
      }, 'admin-1'),
    'failed-precondition',
  );

  const request = await db.collection('joinRequests').doc('JRQ-PAID').get();
  const payment = await db.collection('payments').doc('JRQ-PAID').get();
  check(
    'the submitted request was not rejected',
    request.get('status'),
    'studentConfirmed',
  );
  check(
    'the submitted payment is still waiting for verification',
    payment.get('status'),
    'submitted',
  );
}

async function testPaymentPathsRevalidateRoomAvailability() {
  section('payment intent and submission revalidate room availability');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');

  const cases = [
    {
      id: 'RM-INACTIVE',
      label: 'a listing which left the market',
      room: { status: 'inactive' },
    },
    {
      id: 'RM-FULL',
      label: 'a full listing',
      room: { status: 'available', occupancy: 2, currentOccupancy: 2 },
    },
    {
      id: 'RM-DELETING',
      label: 'a listing which is being deleted',
      room: { status: 'available', deletionInProgress: true },
    },
  ];

  for (const testCase of cases) {
    await seedRoom(testCase.id, 'owner-1', testCase.room);
    const requestId = `JRQ-${testCase.id}`;
    await seedRequest(requestId, {
      roomId: testCase.id,
      status: 'studentConfirmed',
      platformFeePayer: 'owner',
    });

    await expectDenied(
      `${testCase.label} cannot create a payment intent`,
      () =>
        invoke(createUpiPayment, { joinRequestId: requestId }, 'owner-1'),
      'failed-precondition',
    );
    await expectDenied(
      `${testCase.label} cannot record a payment`,
      () =>
        invoke(submitPayment, {
          requestId,
          reference: `UPI-${testCase.id}`,
          method: 'upi',
        }, 'owner-1'),
      'failed-precondition',
    );
    check(
      `${testCase.label} did not create a payment record`,
      (await db.collection('payments').doc(requestId).get()).exists,
      false,
    );
  }
}

async function testApprovalAndConfirmationRevalidateTheRoom() {
  section('owner approval and student confirmation revalidate the room');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-INACTIVE', 'owner-1', { status: 'inactive' });
  await seedRequest('JRQ-PENDING', {
    roomId: 'RM-INACTIVE',
    status: 'pending',
  });
  await seedRequest('JRQ-OWNER-CONFIRMED', {
    roomId: 'RM-INACTIVE',
    status: 'ownerConfirmed',
  });

  await expectDenied(
    'the owner cannot approve a request for an unavailable room',
    () =>
      invoke(respondToJoinRequest, {
        requestId: 'JRQ-PENDING',
        approve: true,
      }, 'owner-1'),
    'failed-precondition',
  );
  await expectDenied(
    'the student cannot confirm a request for an unavailable room',
    () =>
      invoke(confirmJoinAsStudent, {
        requestId: 'JRQ-OWNER-CONFIRMED',
      }, 'student-1'),
    'failed-precondition',
  );
  check(
    'the pending request stayed pending',
    (await db.collection('joinRequests').doc('JRQ-PENDING').get()).get('status'),
    'pending',
  );
  check(
    'the owner-confirmed request stayed owner-confirmed',
    (await db.collection('joinRequests').doc('JRQ-OWNER-CONFIRMED').get()).get('status'),
    'ownerConfirmed',
  );
}

async function testAccountDeletionFenceBlocksBookingTransitions() {
  section('the account-deletion fence blocks new booking transitions');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner', false);
  await seedUser('student-1', 'student');
  await seedRoom('RM-1', 'owner-1');
  await seedRoom('RM-NEW', 'owner-1');
  await seedRequest('JRQ-FENCED', {
    status: 'studentConfirmed',
    platformFeePayer: 'student',
  });

  await expectDenied(
    'a deleting owner cannot accept a new booking request',
    () =>
      invoke(createJoinRequest, { roomId: 'RM-NEW' }, 'student-1'),
    'permission-denied',
  );
  const requestsAfterFence = await db
    .collection('joinRequests')
    .where('roomId', '==', 'RM-NEW')
    .where('studentId', '==', 'student-1')
    .get();
  check(
    'the fenced owner did not gain a new request',
    requestsAfterFence.size,
    0,
  );

  await expectDenied(
    'a deleting owner cannot receive a new payment submission',
    () =>
      invoke(submitPayment, {
        requestId: 'JRQ-FENCED',
        reference: 'UPI-FENCED',
        method: 'upi',
      }, 'student-1'),
    'permission-denied',
  );
  check(
    'the fenced owner did not gain a payment record',
    (await db.collection('payments').doc('JRQ-FENCED').get()).exists,
    false,
  );

  await db.collection('payments').doc('JRQ-FENCED').set({
    requestId: 'JRQ-FENCED',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'RM-1',
    amount: 1500,
    feePercentage: 30,
    reference: 'UPI-FENCED',
    method: 'upi',
    payer: 'student',
    feeWaived: false,
    status: 'submitted',
  });

  await expectDenied(
    'a deleting owner cannot activate a submitted payment',
    () =>
      invoke(verifyPayment, {
        requestId: 'JRQ-FENCED',
        approve: true,
      }, 'admin-1'),
    'permission-denied',
  );
  check(
    'the fenced activation did not change the occupancy',
    (await db.collection('rooms').doc('RM-1').get()).get('currentOccupancy'),
    0,
  );
  check(
    'the fenced payment is still submitted',
    (await db.collection('payments').doc('JRQ-FENCED').get()).get('status'),
    'submitted',
  );

  await invoke(verifyPayment, {
    requestId: 'JRQ-FENCED',
    approve: false,
    note: 'Money did not arrive',
  }, 'admin-1');
  check(
    'the payment can still be rejected while the deletion is fenced',
    (await db.collection('payments').doc('JRQ-FENCED').get()).get('status'),
    'rejected',
  );
}

async function testPaymentVerificationChecksTheAdminInsideTheTransaction() {
  section('payment verification checks the live admin inside its transaction');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-1', 'owner-1');
  await seedRequest('JRQ-ADMIN-RACE', { status: 'studentConfirmed' });
  await db.collection('payments').doc('JRQ-ADMIN-RACE').set({
    requestId: 'JRQ-ADMIN-RACE',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'RM-1',
    amount: 1500,
    feePercentage: 30,
    reference: 'UPI-ADMIN-RACE',
    method: 'upi',
    payer: 'owner',
    feeWaived: false,
    status: 'submitted',
  });

  const originalRunTransaction = db.runTransaction;
  let demoted = false;
  db.runTransaction = async (updateFunction) => {
    if (!demoted) {
      demoted = true;
      // The outside pre-check has already succeeded. The demotion commits
      // immediately before the protected transaction reads the admin profile.
      await db.collection('users').doc('admin-1').update({ role: 'student' });
    }
    return originalRunTransaction.call(db, updateFunction);
  };

  try {
    await expectDenied(
      'a demoted admin cannot verify the payment',
      () =>
        invoke(verifyPayment, {
          requestId: 'JRQ-ADMIN-RACE',
          approve: true,
        }, 'admin-1'),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }

  check(
    'the demoted admin did not activate the request',
    (await db.collection('joinRequests').doc('JRQ-ADMIN-RACE').get()).get('status'),
    'studentConfirmed',
  );
  check(
    'the demoted admin did not verify the payment',
    (await db.collection('payments').doc('JRQ-ADMIN-RACE').get()).get('status'),
    'submitted',
  );
  check(
    'the demoted admin did not change the occupancy',
    (await db.collection('rooms').doc('RM-1').get()).get('currentOccupancy'),
    0,
  );
}

async function testPaymentVerificationRejectsAnInvalidRequestRent() {
  section('payment verification rejects an invalid request rent');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-1', 'owner-1');
  await seedRequest('JRQ-BAD-RENT', {
    status: 'studentConfirmed',
    monthlyRentAtJoin: 999,
  });
  await db.collection('payments').doc('JRQ-BAD-RENT').set({
    requestId: 'JRQ-BAD-RENT',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'RM-1',
    amount: 300,
    feePercentage: 30,
    reference: 'UPI-BAD-RENT',
    method: 'upi',
    payer: 'owner',
    feeWaived: false,
    status: 'submitted',
  });

  await expectDenied(
    'an invalid agreed rent cannot be activated',
    () =>
      invoke(verifyPayment, {
        requestId: 'JRQ-BAD-RENT',
        approve: true,
      }, 'admin-1'),
    'failed-precondition',
  );
  check(
    'the invalid-rent request was not activated',
    (await db.collection('joinRequests').doc('JRQ-BAD-RENT').get()).get('status'),
    'studentConfirmed',
  );
  check(
    'the invalid-rent payment stays submitted',
    (await db.collection('payments').doc('JRQ-BAD-RENT').get()).get('status'),
    'submitted',
  );
}

async function testVisitDetailsUseOneFreshTransactionSnapshot() {
  section('visit details use one fresh transaction snapshot');

  const previousStage = process.env.ROOM_LOCATION_STAGE;
  process.env.ROOM_LOCATION_STAGE = 'dual';

  try {
    await reset();
    await seedUser('owner-1', 'owner');
    await seedUser('student-1', 'student');
    await seedRoom('RM-VISIT-RACE', 'owner-1');
    await db.collection('roomPrivate').doc('RM-VISIT-RACE').set({
      roomId: 'RM-VISIT-RACE',
      ownerId: 'owner-1',
      address: '99 Private Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
      updatedAt: firestore.Timestamp.now(),
    });
    await seedRequest('JRQ-VISIT-RACE', {
      roomId: 'RM-VISIT-RACE',
      status: 'ownerConfirmed',
    });

    const requestRef = db.collection('joinRequests').doc('JRQ-VISIT-RACE');
    const originalRunTransaction = db.runTransaction;
    let cancelled = false;
    db.runTransaction = async (updateFunction) => {
      if (!cancelled) {
        cancelled = true;
        // The request is cancelled after the callable's live-account check
        // and before the protected transaction takes its snapshot.
        await requestRef.update({ status: 'cancelled' });
      }
      return originalRunTransaction.call(db, updateFunction);
    };

    try {
      await expectDenied(
        'a cancelled request cannot release the exact address',
        () =>
          invoke(
            getRoomVisitDetails,
            { roomId: 'RM-VISIT-RACE' },
            'student-1',
          ),
        'failed-precondition',
      );
    } finally {
      db.runTransaction = originalRunTransaction;
    }

    check(
      'the cancelled request stayed cancelled',
      (await requestRef.get()).get('status'),
      'cancelled',
    );

    await requestRef.update({ status: 'ownerConfirmed' });
    let demoted = false;
    db.runTransaction = async (updateFunction) => {
      if (!demoted) {
        demoted = true;
        // A role change which commits before the transaction snapshot must
        // also be visible to the authorization decision.
        await db.collection('users').doc('student-1').update({ role: 'owner' });
      }
      return originalRunTransaction.call(db, updateFunction);
    };

    try {
      await expectDenied(
        'a student demoted before the snapshot cannot release the address',
        () =>
          invoke(
            getRoomVisitDetails,
            { roomId: 'RM-VISIT-RACE' },
            'student-1',
          ),
        'permission-denied',
      );
    } finally {
      db.runTransaction = originalRunTransaction;
    }
  } finally {
    if (previousStage === undefined) delete process.env.ROOM_LOCATION_STAGE;
    else process.env.ROOM_LOCATION_STAGE = previousStage;
  }
}

async function testAdminReviewChecksTheAdminInsideTheTransaction() {
  section('admin review checks the live admin inside its transaction');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-1', 'owner-1');
  await seedRequest('JRQ-ADMIN-REVIEW-RACE', {
    status: 'ownerConfirmed',
  });

  const originalRunTransaction = db.runTransaction;
  let demoted = false;
  db.runTransaction = async (updateFunction) => {
    if (!demoted) {
      demoted = true;
      await db.collection('users').doc('admin-1').update({ role: 'student' });
    }
    return originalRunTransaction.call(db, updateFunction);
  };

  try {
    await expectDenied(
      'a demoted admin cannot review the request',
      () =>
        invoke(
          adminReviewRequest,
          {
            requestId: 'JRQ-ADMIN-REVIEW-RACE',
            approve: false,
            rejectionReason: 'Rejected after the demotion',
          },
          'admin-1',
        ),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }

  check(
    'the demoted admin did not reject the request',
    (await db.collection('joinRequests').doc('JRQ-ADMIN-REVIEW-RACE').get()).get('status'),
    'ownerConfirmed',
  );
}

async function testPrivateLocationMigrationChecksTheAdminInsideTheTransaction() {
  section('the location migration checks the live admin inside its transaction');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-MIGRATION-RACE', 'owner-1');

  const originalRunTransaction = db.runTransaction;
  let demoted = false;
  db.runTransaction = async (updateFunction) => {
    if (!demoted) {
      demoted = true;
      await db.collection('users').doc('admin-1').update({ role: 'student' });
    }
    return originalRunTransaction.call(db, updateFunction);
  };

  try {
    await expectDenied(
      'a demoted admin cannot migrate a room location',
      () =>
        invoke(
          migrateRoomPrivateLocations,
          { dryRun: false, limit: 10 },
          'admin-1',
        ),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }

  check(
    'the demoted admin did not create a private location',
    (await db.collection('roomPrivate').doc('RM-MIGRATION-RACE').get()).exists,
    false,
  );
}

async function testLocationFinalizationChecksTheAdminInsideTheTransaction() {
  section('location finalization checks the live admin inside its transaction');

  const previousStage = process.env.ROOM_LOCATION_STAGE;
  process.env.ROOM_LOCATION_STAGE = 'private';

  try {
    await reset();
    await seedUser('admin-1', 'admin');
    await seedUser('owner-1', 'owner');
    await seedRoom('RM-FINAL-RACE', 'owner-1');
    await db.collection('roomPrivate').doc('RM-FINAL-RACE').set({
      roomId: 'RM-FINAL-RACE',
      ownerId: 'owner-1',
      address: '12 Legacy Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
      updatedAt: firestore.Timestamp.now(),
    });
    await db.collection('system').doc('locationPrivacy').set({
      allowClientExactLocationWrites: false,
      finalized: false,
    });

    const originalRunTransaction = db.runTransaction;
    let demoted = false;
    db.runTransaction = async (updateFunction) => {
      if (!demoted) {
        demoted = true;
        await db.collection('users').doc('admin-1').update({ role: 'student' });
      }
      return originalRunTransaction.call(db, updateFunction);
    };

    try {
      await expectDenied(
        'a demoted admin cannot finalize the location format',
        () =>
          invoke(
            finalizeRoomLocationPrivacy,
            { dryRun: false, limit: 10 },
            'admin-1',
          ),
        'permission-denied',
      );
    } finally {
      db.runTransaction = originalRunTransaction;
    }

    const privacyConfig = await db.collection('system').doc('locationPrivacy').get();
    const room = await db.collection('rooms').doc('RM-FINAL-RACE').get();
    check(
      'the demoted admin did not set the finalization latch',
      privacyConfig.get('finalized'),
      false,
    );
    check(
      'the demoted admin did not scrub the public address',
      room.get('location.address'),
      '12 Legacy Street',
    );
  } finally {
    if (previousStage === undefined) delete process.env.ROOM_LOCATION_STAGE;
    else process.env.ROOM_LOCATION_STAGE = previousStage;
  }
}

async function testStudentDeletionFenceIsCheckedInsideTheTransaction() {
  section('the student deletion fence is checked inside the transaction');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-STUDENT-FENCE', 'owner-1');
  await seedRoom('RM-STUDENT-FENCE-NEW', 'owner-1');
  await seedRequest('JRQ-STUDENT-FENCE', {
    roomId: 'RM-STUDENT-FENCE',
    status: 'studentConfirmed',
    platformFeePayer: 'student',
  });

  const originalRunTransaction = db.runTransaction;
  let fenced = false;
  db.runTransaction = async (updateFunction) => {
    if (!fenced) {
      fenced = true;
      // The account-deletion marker commits after the preliminary live check
      // but before the protected transaction reads the student profile.
      await db.collection('users').doc('student-1').update({ isActive: false });
    }
    return originalRunTransaction.call(db, updateFunction);
  };

  try {
    await expectDenied(
      'a deleting student cannot create a booking request',
      () =>
        invoke(
          createJoinRequest,
          { roomId: 'RM-STUDENT-FENCE-NEW' },
          'student-1',
        ),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }

  const requests = await db
    .collection('joinRequests')
    .where('roomId', '==', 'RM-STUDENT-FENCE-NEW')
    .get();
  check(
    'the fenced student did not gain a new request',
    requests.size,
    0,
  );

  await db.collection('users').doc('student-1').update({ isActive: true });
  let fencedAgain = false;
  db.runTransaction = async (updateFunction) => {
    if (!fencedAgain) {
      fencedAgain = true;
      await db.collection('users').doc('student-1').update({ isActive: false });
    }
    return originalRunTransaction.call(db, updateFunction);
  };

  try {
    await expectDenied(
      'a deleting student cannot submit a payment',
      () =>
        invoke(
          submitPayment,
          {
            requestId: 'JRQ-STUDENT-FENCE',
            reference: 'UPI-STUDENT-FENCE',
            method: 'upi',
          },
          'student-1',
        ),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }

  check(
    'the fenced student did not gain a payment record',
    (await db.collection('payments').doc('JRQ-STUDENT-FENCE').get()).exists,
    false,
  );
}

async function testRoleChangeChecksTheAdminInsideTheTransaction() {
  section('a role change checks the live admin inside its transaction');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');

  const originalRunTransaction = db.runTransaction;
  let demoted = false;
  db.runTransaction = async (updateFunction) => {
    if (!demoted) {
      demoted = true;
      await db.collection('users').doc('admin-1').update({ role: 'student' });
    }
    return originalRunTransaction.call(db, updateFunction);
  };

  try {
    await expectDenied(
      'a demoted admin cannot change another account role',
      () => invoke(setUserRole, { uid: 'target-1', role: 'owner' }, 'admin-1'),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }

  check(
    'the demoted admin did not change the target role',
    (await db.collection('users').doc('target-1').get()).get('role'),
    'student',
  );
}

async function testAdminCallablesCheckTheLiveAdminInsideTheTransaction() {
  section('admin callables check the live admin inside their transaction');

  const cases = [
    {
      label: 'revoke the tokens of a user',
      callable: revokeUserTokens,
      data: { uid: 'target-1' },
      prepare: async () => {
        await seedUser('target-1', 'student');
      },
    },
    {
      label: 'ban a user',
      callable: banUser,
      data: { uid: 'target-1' },
      prepare: async () => {
        await seedUser('target-1', 'student');
      },
    },
    {
      label: 'unban a user',
      callable: unbanUser,
      data: { uid: 'target-1' },
      prepare: async () => {
        await seedUser('target-1', 'student', false);
      },
    },
    {
      label: 'delete a user immediately',
      callable: deleteUserCompletely,
      data: { uid: 'target-1' },
      prepare: async () => {
        await seedUser('target-1', 'student');
      },
    },
    {
      label: 'schedule the deletion of a user',
      callable: scheduleUserDeletion,
      data: { uid: 'target-1', days: 7 },
      prepare: async () => {
        await seedUser('target-1', 'student');
      },
    },
    {
      label: 'cancel the deletion of a user',
      callable: cancelUserDeletion,
      data: { uid: 'target-1' },
      prepare: async () => {
        await seedUser('target-1', 'student', false);
        await db.collection('users').doc('target-1').update({
          deletionScheduled: true,
          deletionState: 'scheduled',
          deletionPreviousIsActive: true,
        });
        await db
          .collection('accountDeletionJobs')
          .doc(accountDeletionJobId('target-1'))
          .set({
            type: 'accountDeletion',
            uid: 'target-1',
            status: 'scheduled',
            deletionClaimed: false,
            previousIsActive: true,
            deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
          });
      },
    },
  ];

  for (const testCase of cases) {
    await reset();
    await seedUser('admin-1', 'admin');
    await testCase.prepare();

    const originalRunTransaction = db.runTransaction;
    let demoted = false;
    db.runTransaction = async (updateFunction) => {
      if (!demoted) {
        demoted = true;
        await db.collection('users').doc('admin-1').update({ role: 'student' });
      }
      return originalRunTransaction.call(db, updateFunction);
    };

    try {
      await expectDenied(
        `a demoted admin cannot ${testCase.label}`,
        () => invoke(testCase.callable, testCase.data, 'admin-1'),
        'permission-denied',
      );
    } finally {
      db.runTransaction = originalRunTransaction;
    }
  }
}

async function testAdminCallablesRefuseSelfTargeting() {
  section('admin callables refuse self-targeting');

  await reset();
  await seedUser('admin-1', 'admin');

  await expectDenied(
    'an administrator cannot ban their own account',
    () => invoke(banUser, { uid: 'admin-1' }, 'admin-1'),
    'failed-precondition',
  );
  await expectDenied(
    'an administrator cannot revoke their own session',
    () => invoke(revokeUserTokens, { uid: 'admin-1' }, 'admin-1'),
    'failed-precondition',
  );
  check(
    'the administrator account is still active',
    (await db.collection('users').doc('admin-1').get()).get('isActive'),
    true,
  );
}

async function testUnbanRefusesAnAccountWhichIsBeingDeleted() {
  section('unban refuses an account whose deletion has started');

  const cases = [
    {
      label: 'scheduled',
      deletionState: 'scheduled',
      deletionScheduled: true,
      jobStatus: 'scheduled',
    },
    {
      label: 'pending',
      deletionState: 'pending',
      deletionScheduled: false,
      jobStatus: 'pending',
    },
    {
      label: 'deleting',
      deletionState: 'deleting',
      deletionScheduled: false,
      jobStatus: 'processing',
    },
    {
      label: 'restoring',
      deletionState: 'restoring',
      deletionScheduled: false,
      jobStatus: 'cancelled',
    },
  ];

  for (const testCase of cases) {
    await reset();
    await seedUser('admin-1', 'admin');
    await seedUser('target-1', 'student', false);
    await db.collection('users').doc('target-1').update({
      deletionState: testCase.deletionState,
      deletionScheduled: testCase.deletionScheduled,
      isActive: false,
    });
    await db
      .collection('accountDeletionJobs')
      .doc(accountDeletionJobId('target-1'))
      .set({
        type: 'accountDeletion',
        uid: 'target-1',
        status: testCase.jobStatus,
        deletionClaimed: false,
      });

    await expectDenied(
      `a ${testCase.label} account cannot be unbanned`,
      () => invoke(unbanUser, { uid: 'target-1' }, 'admin-1'),
      'failed-precondition',
    );
    check(
      `the ${testCase.label} account is still inactive`,
      (await db.collection('users').doc('target-1').get()).get('isActive'),
      false,
    );
  }
}

async function testUnbanKeepsTheProfileInactiveWhenAuthFails() {
  section('unban keeps the profile inactive when Auth cannot be enabled');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student', false);

  const originalUpdateUser = auth.updateUser;
  auth.updateUser = async () => {
    throw new Error('simulated Auth enable failure');
  };

  try {
    await expectDenied(
      'a failed Auth enable is reported',
      () => invoke(unbanUser, { uid: 'target-1' }, 'admin-1'),
      'internal',
    );
  } finally {
    auth.updateUser = originalUpdateUser;
  }

  check(
    'the profile stays inactive after the failed Auth enable',
    (await db.collection('users').doc('target-1').get()).get('isActive'),
    false,
  );
}

async function testCancelDeletionRestoresThePreviousActivationState() {
  section('cancelling a deletion restores the previous activation state');

  await reset();
  await seedUser('admin-1', 'admin');
  await db.collection('users').doc('target-1').set({
    ...profile('target-1', 'student', false),
    banReason: 'Banned by admin',
    deletionScheduled: true,
    deletionState: 'scheduled',
    deletionPreviousIsActive: false,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });
  await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'))
    .set({
      type: 'accountDeletion',
      uid: 'target-1',
      status: 'scheduled',
      deletionClaimed: false,
      previousIsActive: false,
      deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
    });

  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.updateUser = async () => undefined;
  auth.revokeRefreshTokens = async () => undefined;
  try {
    await invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1');
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const user = await db.collection('users').doc('target-1').get();
  check(
    'the previously banned account stays banned',
    user.get('isActive'),
    false,
  );
  check(
    'the deletion state was cleared',
    user.get('deletionState'),
    null,
  );
  check(
    'the durable restore record was removed',
    (
      await db
        .collection('accountDeletionJobs')
        .doc(accountDeletionJobId('target-1'))
        .get()
    ).exists,
    false,
  );
}

async function testReviewAndNotificationAuthorizationsAreTransactional() {
  section('review and notification authorizations are transactional');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-REVIEW', 'owner-1');
  await seedRequest('JRQ-REVIEW', {
    roomId: 'RM-REVIEW',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'ownerConfirmed',
  });

  const originalRunTransaction = db.runTransaction;
  let cancelled = false;
  db.runTransaction = async (updateFunction) => {
    if (!cancelled) {
      cancelled = true;
      await db
        .collection('joinRequests')
        .doc('JRQ-REVIEW')
        .update({ status: 'cancelled' });
    }
    return originalRunTransaction.call(db, updateFunction);
  };
  try {
    await expectDenied(
      'a review cannot be written after the accepted request is cancelled',
      () =>
        invoke(
          submitRoomReview,
          { roomId: 'RM-REVIEW', rating: 5, comment: 'Too late' },
          'student-1',
        ),
      'failed-precondition',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }
  check(
    'the late review was not written',
    (
      await db
        .collection('roomReviews')
        .doc('REV-RM-REVIEW-student-1')
        .get()
    ).exists,
    false,
  );

  await db
    .collection('joinRequests')
    .doc('JRQ-REVIEW')
    .update({ status: 'ownerConfirmed' });
  await db.collection('users').doc('student-1').update({ isActive: false });
  await expectDenied(
    'an inactive student cannot write a review',
    () =>
      invoke(
        submitRoomReview,
        { roomId: 'RM-REVIEW', rating: 4, comment: 'Inactive' },
        'student-1',
      ),
    'permission-denied',
  );

  const reviewRef = db
    .collection('roomReviews')
    .doc('REV-RM-REVIEW-student-1');
  await reviewRef.set({
    reviewId: 'REV-RM-REVIEW-student-1',
    roomId: 'RM-REVIEW',
    studentId: 'student-1',
    ownerId: 'owner-1',
    rating: 5,
    comment: 'Existing',
  });
  let deactivated = false;
  db.runTransaction = async (updateFunction) => {
    if (!deactivated) {
      deactivated = true;
      await db.collection('users').doc('student-1').update({ isActive: false });
    }
    return originalRunTransaction.call(db, updateFunction);
  };
  try {
    await expectDenied(
      'an inactive student cannot delete a review',
      () => invoke(deleteRoomReview, { roomId: 'RM-REVIEW' }, 'student-1'),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }
  check('the inactive student kept the review', (await reviewRef.get()).exists, true);
}

async function testClientNotificationAuthorizationsAreTransactional() {
  section('client notification authorizations are transactional');

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await db.collection('conversations').doc('conversation-1').set({
    conversationId: 'conversation-1',
    participantIds: ['student-1', 'owner-1'],
    roomId: 'RM-1',
    createdByServer: true,
  });
  await db
    .collection('conversations')
    .doc('conversation-1')
    .collection('messages')
    .doc('message-1')
    .set({
      messageId: 'message-1',
      conversationId: 'conversation-1',
      senderId: 'student-1',
      receiverId: 'owner-1',
      content: 'The stored message',
      type: 'text',
      createdAt: firestore.Timestamp.now(),
    });

  const originalRunTransaction = db.runTransaction;
  let deactivated = false;
  db.runTransaction = async (updateFunction) => {
    if (!deactivated) {
      deactivated = true;
      await db.collection('users').doc('student-1').update({ isActive: false });
    }
    return originalRunTransaction.call(db, updateFunction);
  };
  try {
    await expectDenied(
      'an inactive student cannot send a chat notification',
      () =>
        invoke(
          notifyUser,
          {
            userId: 'owner-1',
            type: 'newMessage',
            data: {
              conversationId: 'conversation-1',
              messageId: 'message-1',
            },
          },
          'student-1',
        ),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }
  check(
    'the inactive student did not create a notification',
    (await db.collection('notifications').get()).empty,
    true,
  );

  await db.collection('users').doc('student-1').update({ isActive: true });
  const notificationRef = db.collection('notifications').doc('notification-1');
  await notificationRef.set({
    userId: 'student-1',
    title: 'Notice',
    body: 'Body',
    type: 'general',
    read: false,
  });
  let banned = false;
  db.runTransaction = async (updateFunction) => {
    if (!banned) {
      banned = true;
      await db.collection('users').doc('student-1').update({ isActive: false });
    }
    return originalRunTransaction.call(db, updateFunction);
  };
  try {
    await expectDenied(
      'an inactive student cannot delete a notification',
      () => invoke(deleteNotification, { notificationId: 'notification-1' }, 'student-1'),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }
  check(
    'the inactive student kept the notification',
    (await notificationRef.get()).exists,
    true,
  );
}

async function testScheduledDeletionScanLeavesFutureAccountsAlone() {
  section('the bounded scheduled-deletion scan leaves future accounts alone');

  await reset();
  await seedUser('target-1', 'student', false);
  await db.collection('users').doc('target-1').update({
    deletionScheduled: true,
    deletionState: 'scheduled',
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });

  await processScheduledDeletions.run({});

  const user = await db.collection('users').doc('target-1').get();
  check('the future account still exists', user.exists, true);
  check(
    'the future account is still marked for deletion',
    user.get('deletionScheduled'),
    true,
  );
  check(
    'no premature deletion job was created',
    (
      await db
        .collection('accountDeletionJobs')
        .doc(accountDeletionJobId('target-1'))
        .get()
    ).exists,
    false,
  );
}

async function testStaleRoleCleanupCannotClearANewerMarker() {
  section('a stale role cleanup cannot clear a newer cleanup marker');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'owner');
  await seedUser('owner-1', 'owner');
  await db.collection('users').doc('target-1').update({
    roleChangedFrom: 'student',
    roleChangeCleanupPending: true,
  });
  await seedRequest('JRQ-NEWER-ROLE-CLEANUP', {
    studentId: 'target-1',
    ownerId: 'owner-1',
    status: 'pending',
  });

  const originalRunTransaction = db.runTransaction;
  let transactionCount = 0;
  db.runTransaction = async (updateFunction) => {
    transactionCount += 1;
    const result = await originalRunTransaction.call(db, updateFunction);
    if (transactionCount === 2) {
      // A newer role change commits while the old cleanup is still running.
      await db.collection('users').doc('target-1').update({
        role: 'admin',
        roleChangedFrom: 'owner',
        roleChangeCleanupPending: true,
      });
    }
    return result;
  };

  const originalSetClaims = auth.setCustomUserClaims;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.setCustomUserClaims = async () => undefined;
  auth.revokeRefreshTokens = async () => undefined;
  try {
    await invoke(setUserRole, { uid: 'target-1', role: 'owner' }, 'admin-1');
  } finally {
    db.runTransaction = originalRunTransaction;
    auth.setCustomUserClaims = originalSetClaims;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const profile = await db.collection('users').doc('target-1').get();
  check(
    'the newer cleanup marker is still pending',
    profile.get('roleChangeCleanupPending'),
    true,
  );
  check(
    'the newer marker still names its own previous role',
    profile.get('roleChangedFrom'),
    'owner',
  );
}

async function testStaleRoleCleanupCannotCancelARequestUnderANewerRole() {
  section('a stale role cleanup cannot cancel a request under a newer role');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');
  await seedUser('owner-2', 'owner');
  await db.collection('users').doc('target-1').update({
    role: 'student',
    roleRevision: 1,
    roleChangedFrom: 'student',
    roleChangeTo: 'owner',
    roleChangeRevision: 1,
    roleChangeCleanupPending: true,
  });

  const originalRunTransaction = db.runTransaction;
  let transactionCount = 0;
  db.runTransaction = async (updateFunction) => {
    transactionCount += 1;
    const result = await originalRunTransaction.call(db, updateFunction);
    if (transactionCount === 1) {
      // A newer role change commits while revision 1 is still cleaning up.
      // The account is a student again and creates a valid tenant request.
      await db.collection('users').doc('target-1').update({
        role: 'student',
        roleRevision: 2,
        roleChangedFrom: 'owner',
        roleChangeTo: 'student',
        roleChangeRevision: 2,
        roleChangeCleanupPending: true,
      });
      await seedRequest('JRQ-NEWER-ROLE-REQUEST', {
        roomId: 'RM-NEWER-ROLE',
        studentId: 'target-1',
        ownerId: 'owner-2',
        status: 'pending',
      });
    }
    return result;
  };

  const publishedClaims = [];
  const originalSetClaims = auth.setCustomUserClaims;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.setCustomUserClaims = async (_uid, claims) => {
    publishedClaims.push(claims);
  };
  auth.revokeRefreshTokens = async () => undefined;
  try {
    await invoke(setUserRole, { uid: 'target-1', role: 'student' }, 'admin-1');
  } finally {
    db.runTransaction = originalRunTransaction;
    auth.setCustomUserClaims = originalSetClaims;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const request = await db
    .collection('joinRequests')
    .doc('JRQ-NEWER-ROLE-REQUEST')
    .get();
  check(
    'the request under the newer role was not cancelled',
    request.get('status'),
    'pending',
  );
  check(
    'the latest role was published to Auth',
    publishedClaims[publishedClaims.length - 1]?.role,
    'student',
  );
  check(
    'the latest role revision was published to Auth',
    publishedClaims[publishedClaims.length - 1]?.roleRevision,
    2,
  );
}

async function testAccountDeletionWorkerOnlyClaimsRealPendingJobs() {
  section('the account-deletion worker only claims real pending jobs');

  await reset();
  await seedUser('target-1', 'student');

  const jobRef = db.collection('accountDeletionJobs').doc('job-state-check');
  const cases = [
    {
      label: 'a scheduled job',
      values: {
        type: 'accountDeletion',
        uid: 'target-1',
        status: 'scheduled',
      },
    },
    {
      label: 'a cancelled job',
      values: {
        type: 'accountDeletion',
        uid: 'target-1',
        status: 'cancelled',
        restoreToken: 'restore-1',
      },
    },
    {
      label: 'a job of another type',
      values: {
        type: 'somethingElse',
        uid: 'target-1',
        status: 'pending',
      },
    },
    {
      label: 'a pending job without a uid',
      values: {
        type: 'accountDeletion',
        status: 'pending',
      },
    },
  ];

  for (const testCase of cases) {
    await jobRef.set(testCase.values);
    const claimed = await processAccountDeletionJob(jobRef);
    const snapshot = await jobRef.get();
    check(`${testCase.label} is not claimed`, claimed, false);
    check(
      `${testCase.label} keeps its status`,
      snapshot.get('status'),
      testCase.values.status,
    );
  }

  await jobRef.delete();
}

async function testCancelledRestoreDoesNotDeleteARependedJob() {
  section('a cancelled restore never deletes a re-pended deletion job');

  await reset();
  await seedUser('target-1', 'student', false);
  const jobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'));
  await jobRef.set({
    type: 'accountDeletion',
    uid: 'target-1',
    status: 'cancelled',
    deletionClaimed: false,
    previousIsActive: true,
    authEnablePending: true,
    restoreToken: 'restore-token-1',
  });

  const originalUpdateUser = auth.updateUser;
  auth.updateUser = async () => {
    // A concurrent enqueue re-pends the deletion while the restore worker is
    // still enabling Auth. The old worker deleted the job unconditionally.
    await jobRef.set(
      {
        status: 'pending',
        restoreToken: firestore.FieldValue.delete(),
        authEnablePending: firestore.FieldValue.delete(),
      },
      { merge: true },
    );
  };

  try {
    await processAccountDeletionJobs.run({});
  } finally {
    auth.updateUser = originalUpdateUser;
  }

  const job = await jobRef.get();
  check('the re-pended job still exists', job.exists, true);
  check('the re-pended job was not deleted', job.get('status'), 'pending');
  check(
    'the profile was not activated by the stale restore',
    (await db.collection('users').doc('target-1').get()).get('isActive'),
    false,
  );
}

async function testWrongTypedScheduledJobCannotDisableAuth() {
  section('a wrong-typed scheduled job cannot disable Auth');

  await reset();
  await seedUser('target-1', 'student');
  const jobRef = db.collection('accountDeletionJobs').doc('wrong-type-scheduled');
  await jobRef.set({
    type: 'somethingElse',
    uid: 'target-1',
    status: 'scheduled',
    authDisablePending: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });

  let authCalls = 0;
  const originalUpdateUser = auth.updateUser;
  auth.updateUser = async () => {
    authCalls += 1;
  };

  let workerError = null;
  try {
    await processAccountDeletionJobs.run({});
  } catch (error) {
    workerError = error;
  } finally {
    auth.updateUser = originalUpdateUser;
  }

  check('the malformed job did not fail the worker', workerError, null);
  check('the malformed job did not disable Auth', authCalls, 0);
  check(
    'the malformed job was not claimed for deletion',
    (await jobRef.get()).get('status'),
    'scheduled',
  );
}

async function testScheduledAuthDisableCannotUndoACancellation() {
  section('a stale scheduled Auth disable cannot undo a cancellation');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');

  let authDisabled = false;
  let firstDisable = true;
  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.updateUser = async (_uid, options) => {
    if (options.disabled === true && firstDisable) {
      firstDisable = false;
      // The cancellation commits while the scheduled disable is still in
      // flight. The old implementation then left Auth disabled even though
      // the restored profile was active again.
      await invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1');
    }
    authDisabled = options.disabled === true;
  };
  auth.revokeRefreshTokens = async () => undefined;

  try {
    await invoke(
      scheduleUserDeletion,
      { uid: 'target-1', days: 7 },
      'admin-1',
    );
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const user = await db.collection('users').doc('target-1').get();
  const job = await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'))
    .get();
  check('the cancellation restored the profile', user.get('isActive'), true);
  check('the stale disable was repaired in Auth', authDisabled, false);
  check('the cancelled deletion job was removed', job.exists, false);
}

async function testScheduledWorkerAuthDisableCannotUndoACancellation() {
  section('a stale scheduled worker Auth disable cannot undo a cancellation');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student', false);
  await db.collection('users').doc('target-1').update({
    deletionScheduled: true,
    deletionState: 'scheduled',
    deletionPreviousIsActive: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });
  await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'))
    .set({
      type: 'accountDeletion',
      uid: 'target-1',
      status: 'scheduled',
      deletionClaimed: false,
      authDisablePending: true,
      previousIsActive: true,
      deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
    });

  let authDisabled = false;
  let firstDisable = true;
  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.updateUser = async (_uid, options) => {
    if (options.disabled === true && firstDisable) {
      firstDisable = false;
      await invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1');
    }
    authDisabled = options.disabled === true;
  };
  auth.revokeRefreshTokens = async () => undefined;

  try {
    await processAccountDeletionJobs.run({});
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const user = await db.collection('users').doc('target-1').get();
  const job = await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'))
    .get();
  check('the worker cancellation restored the profile', user.get('isActive'), true);
  check('the worker repaired the stale Auth disable', authDisabled, false);
  check('the worker did not recreate the cancelled job', job.exists, false);
}

async function testAccountDeletionCompletionRequiresTheCurrentWorkerLease() {
  section('account-deletion completion requires the current worker lease');

  await reset();
  const jobRef = db.collection('accountDeletionJobs').doc('lease-completion-check');
  await jobRef.set({
    type: 'accountDeletion',
    uid: 'target-1',
    status: 'processing',
    workerToken: 'current-worker',
    leaseUntil: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });

  let staleError = null;
  try {
    await completeAccountDeletionJob(jobRef, 'stale-worker');
  } catch (error) {
    staleError = error;
  }
  check(
    'a stale worker cannot complete the job',
    String(staleError?.message || '').includes('lease was lost'),
    true,
  );
  check(
    'the current worker still owns the job',
    (await jobRef.get()).get('workerToken'),
    'current-worker',
  );
  check(
    'the stale worker did not complete the job',
    (await jobRef.get()).get('status'),
    'processing',
  );

  await jobRef.update({ status: 'pending' });
  let pendingError = null;
  try {
    await completeAccountDeletionJob(jobRef, 'current-worker');
  } catch (error) {
    pendingError = error;
  }
  check(
    'a job which is no longer processing cannot be completed',
    String(pendingError?.message || '').includes('lease was lost'),
    true,
  );

  await jobRef.update({ status: 'processing' });
  check(
    'the current worker can complete its job',
    await completeAccountDeletionJob(jobRef, 'current-worker'),
    true,
  );
  const completed = await jobRef.get();
  check('the completed job is marked as completed', completed.get('status'), 'completed');
  check('the completed tombstone drops the uid', completed.get('uid'), undefined);
}

async function testZeroDayDeletionIsScheduledImmediately() {
  section('a zero-day deletion is scheduled immediately');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');

  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.updateUser = async () => undefined;
  auth.revokeRefreshTokens = async () => undefined;

  let result;
  try {
    result = await invoke(
      scheduleUserDeletion,
      { uid: 'target-1', days: 0 },
      'admin-1',
    );
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const jobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'));
  check('the zero-day grace period was accepted', result.days, 0);
  check(
    'the due date is not in the future',
    new Date(result.deleteAfter).getTime() <= Date.now() + 1000,
    true,
  );
  check('the deletion job is scheduled', (await jobRef.get()).get('status'), 'scheduled');
  check(
    'the account is inactive while the deletion is scheduled',
    (await db.collection('users').doc('target-1').get()).get('isActive'),
    false,
  );
}

async function testEnqueueRefusesAnActiveRestore() {
  section('a new deletion cannot overwrite an active account restore');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student', false);
  await db.collection('users').doc('target-1').update({
    deletionState: 'restoring',
  });
  await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'))
    .set({
      type: 'accountDeletion',
      uid: 'target-1',
      status: 'cancelled',
      restoreToken: 'restore-in-progress',
      previousIsActive: true,
      authEnablePending: true,
    });

  await expectDenied(
    'a new deletion is refused while the restore is being finalized',
    () => invoke(deleteUserCompletely, { uid: 'target-1' }, 'admin-1'),
    'failed-precondition',
  );
  check(
    'the active restore was not overwritten',
    (
      await db
        .collection('accountDeletionJobs')
        .doc(accountDeletionJobId('target-1'))
        .get()
    ).get('status'),
    'cancelled',
  );
  check(
    'the profile remains inactive during the restore',
    (await db.collection('users').doc('target-1').get()).get('isActive'),
    false,
  );
}

async function testMaintenanceTaskChecksTheAdminInsideTheBatch() {
  section('a maintenance task checks the live admin inside its batch');

  await reset();
  await seedUser('admin-1', 'admin');
  const oldNotification = db.collection('notifications').doc('old-1');
  await oldNotification.set({
    userId: 'target-1',
    title: 'Old',
    body: 'Old notification',
    type: 'system',
    createdAt: firestore.Timestamp.fromMillis(Date.now() - 40 * 24 * 60 * 60 * 1000),
    read: false,
  });

  const originalRunTransaction = db.runTransaction;
  let demoted = false;
  db.runTransaction = async (updateFunction) => {
    if (!demoted) {
      demoted = true;
      await db.collection('users').doc('admin-1').update({ role: 'student' });
    }
    return originalRunTransaction.call(db, updateFunction);
  };

  try {
    await expectDenied(
      'a demoted admin cannot run a maintenance task',
      () => invoke(runMaintenanceTask, { task: 'cleanNotifications' }, 'admin-1'),
      'permission-denied',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }

  check(
    'the demoted admin did not delete the notification',
    (await oldNotification.get()).exists,
    true,
  );
}

async function testRoleClaimPublicationIsDurableAndRetryable() {
  section('a failed Auth role-claim publication is retried by the worker');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');

  const originalSetClaims = auth.setCustomUserClaims;
  const originalRevoke = auth.revokeRefreshTokens;
  const publishedClaims = [];
  auth.setCustomUserClaims = async () => {
    throw new Error('simulated Auth claim outage');
  };
  auth.revokeRefreshTokens = async () => undefined;

  try {
    await expectDenied(
      'the role change reports the failed Auth publication',
      () =>
        invoke(
          setUserRole,
          { uid: 'target-1', role: 'owner' },
          'admin-1',
        ),
      'internal',
    );
  } finally {
    auth.setCustomUserClaims = originalSetClaims;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const profileAfterFailure = await db.collection('users').doc('target-1').get();
  const jobAfterFailure = await db
    .collection('roleClaimJobs')
    .doc('target-1')
    .get();
  check('the live role change was committed', profileAfterFailure.get('role'), 'owner');
  check('the failed publication left a durable job', jobAfterFailure.exists, true);
  check(
    'the durable job targets the committed revision',
    Number(jobAfterFailure.get('roleRevision') || 0),
    Number(profileAfterFailure.get('roleRevision') || 0),
  );

  auth.setCustomUserClaims = async () => {
    throw new Error('simulated worker Auth claim outage');
  };
  auth.revokeRefreshTokens = async () => undefined;
  let workerError = null;
  try {
    await processRoleClaimPublicationJobs.run({});
  } catch (error) {
    workerError = error;
  } finally {
    auth.setCustomUserClaims = originalSetClaims;
    auth.revokeRefreshTokens = originalRevoke;
  }
  check(
    'the failed worker reports the aggregate publication failure',
    String(workerError?.message || '').includes('role-claim publication'),
    true,
  );
  const jobAfterWorkerFailure = await db
    .collection('roleClaimJobs')
    .doc('target-1')
    .get();
  check(
    'the failed worker kept the publication job',
    jobAfterWorkerFailure.exists,
    true,
  );
  check(
    'the failed worker recorded one publication attempt',
    Number(jobAfterWorkerFailure.get('attempts') || 0),
    1,
  );
  check(
    'the failed worker scheduled a durable retry',
    typeof jobAfterWorkerFailure.get('nextAttemptAt')?.toMillis === 'function',
    true,
  );

  await db.collection('roleClaimJobs').doc('target-1').update({
    nextAttemptAt: firestore.Timestamp.fromMillis(Date.now() - 1000),
  });
  auth.setCustomUserClaims = async (uid, claims) => {
    publishedClaims.push({ uid, claims });
  };
  auth.revokeRefreshTokens = async () => undefined;
  try {
    await processRoleClaimPublicationJobs.run({});
  } finally {
    auth.setCustomUserClaims = originalSetClaims;
    auth.revokeRefreshTokens = originalRevoke;
  }

  check('the worker published the missing role claim', publishedClaims.length, 1);
  check('the worker published the committed role', publishedClaims[0]?.claims?.role, 'owner');
  check(
    'the worker removed the completed publication job',
    (await db.collection('roleClaimJobs').doc('target-1').get()).exists,
    false,
  );
}

async function testRegisterUserRoleCanRetryItsClaimPublication() {
  section('a consumed registration challenge can retry only its claim publication');

  await reset();
  await db.collection('users').doc('retry-user').set({
    uid: 'retry-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
    email: 'retry-user@example.test',
  });
  const challenge = 'retry-role-claim-challenge';
  await db
    .collection('otpCodes')
    .doc(testOtpDocumentId('email', 'retry-user@example.test'))
    .set({
      channel: 'email',
      identifierHash: crypto
        .createHash('sha256')
        .update('retry-user@example.test')
        .digest('hex'),
      verified: true,
      verifiedByUid: 'retry-user',
      challengeHash: crypto.createHash('sha256').update(challenge).digest('hex'),
      challengeUsed: false,
      challengeIssuedAt: firestore.Timestamp.now(),
      challengeExpiresAt: firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
    });

  const originalSetClaims = auth.setCustomUserClaims;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.setCustomUserClaims = async () => {
    throw new Error('simulated Auth claim outage');
  };
  auth.revokeRefreshTokens = async () => undefined;

  let firstError = null;
  try {
    await invoke(
      registerUserRole,
      { role: 'owner', challenge },
      'retry-user',
    );
  } catch (error) {
    firstError = error;
  }
  check('the first role claim reports the Auth failure', firstError != null, true);
  check(
    'the live role claim was committed',
    (await db.collection('users').doc('retry-user').get()).get('role'),
    'owner',
  );
  check(
    'the failed role claim left a durable publication job',
    (await db.collection('roleClaimJobs').doc('retry-user').get()).exists,
    true,
  );

  const publishedClaims = [];
  auth.setCustomUserClaims = async (uid, claims) => {
    publishedClaims.push({ uid, claims });
  };
  try {
    const retried = await invoke(
      registerUserRole,
      { role: 'owner', challenge },
      'retry-user',
    );
    check('the consumed challenge can retry the same role claim', retried.success, true);
  } finally {
    auth.setCustomUserClaims = originalSetClaims;
    auth.revokeRefreshTokens = originalRevoke;
  }

  check('the retry published the missing claim', publishedClaims.length, 1);
  check('the retry published the selected role', publishedClaims[0]?.claims?.role, 'owner');
  check(
    'the retry removed the completed publication job',
    (await db.collection('roleClaimJobs').doc('retry-user').get()).exists,
    false,
  );
}

async function testExpiredOtpChallengeCannotClaimARole() {
  section('an expired OTP challenge cannot claim a role');

  await reset();
  await db.collection('users').doc('expired-user').set({
    uid: 'expired-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
    email: 'expired-user@example.test',
  });
  const challenge = 'expired-role-claim-challenge';
  await db
    .collection('otpCodes')
    .doc(testOtpDocumentId('email', 'expired-user@example.test'))
    .set({
      channel: 'email',
      identifierHash: crypto
        .createHash('sha256')
        .update('expired-user@example.test')
        .digest('hex'),
      verified: true,
      verifiedByUid: 'expired-user',
      challengeHash: crypto.createHash('sha256').update(challenge).digest('hex'),
      challengeUsed: false,
      challengeIssuedAt: firestore.Timestamp.fromMillis(Date.now() - 20 * 60 * 1000),
      challengeExpiresAt: firestore.Timestamp.fromMillis(Date.now() - 10 * 60 * 1000),
    });

  await expectDenied(
    'the expired challenge is refused',
    () =>
      invoke(
        registerUserRole,
        { role: 'owner', challenge },
        'expired-user',
      ),
    'failed-precondition',
  );
  check(
    'the expired challenge did not change the role',
    (await db.collection('users').doc('expired-user').get()).get('role'),
    'student',
  );
  check(
    'the expired challenge created no publication job',
    (await db.collection('roleClaimJobs').doc('expired-user').get()).exists,
    false,
  );
}

async function testRoleClaimWorkerIgnoresNonPublicationJobs() {
  section('the role-claim worker ignores jobs with another type or state');

  await reset();
  await seedUser('target-1', 'student');
  await db.collection('roleClaimJobs').doc('wrong-type').set({
    type: 'anotherJobType',
    status: 'pending',
    uid: 'target-1',
    role: 'owner',
    roleRevision: 0,
    attempts: 0,
  });
  await db.collection('roleClaimJobs').doc('cancelled-publication').set({
    type: 'roleClaimPublication',
    status: 'cancelled',
    uid: 'target-1',
    role: 'owner',
    roleRevision: 0,
    attempts: 0,
  });

  const originalSetClaims = auth.setCustomUserClaims;
  const publishedClaims = [];
  auth.setCustomUserClaims = async (uid, claims) => {
    publishedClaims.push({ uid, claims });
  };
  try {
    await processRoleClaimPublicationJobs.run({});
  } finally {
    auth.setCustomUserClaims = originalSetClaims;
  }

  check('the worker ignored the wrong-typed job', publishedClaims.length, 0);
  check(
    'the wrong-typed job was preserved',
    (await db.collection('roleClaimJobs').doc('wrong-type').get()).get('type'),
    'anotherJobType',
  );
  check(
    'the cancelled publication was preserved',
    (
      await db.collection('roleClaimJobs').doc('cancelled-publication').get()
    ).get('status'),
    'cancelled',
  );
}

async function testInactiveAccountCannotRepublishARoleClaim() {
  section('an inactive account cannot republish its matching role claim');

  await reset();
  await db.collection('users').doc('inactive-retry-user').set({
    uid: 'inactive-retry-user',
    role: 'owner',
    roleClaimed: true,
    roleRevision: 1,
    registrationCompleted: false,
    isActive: false,
    email: 'inactive-retry-user@example.test',
  });

  const originalSetClaims = auth.setCustomUserClaims;
  const publishedClaims = [];
  auth.setCustomUserClaims = async (uid, claims) => {
    publishedClaims.push({ uid, claims });
  };
  try {
    await expectDenied(
      'the inactive account is refused',
      () =>
        invoke(
          registerUserRole,
          { role: 'owner', challenge: 'not-used' },
          'inactive-retry-user',
        ),
      'permission-denied',
    );
  } finally {
    auth.setCustomUserClaims = originalSetClaims;
  }

  check('the inactive account published no claim', publishedClaims.length, 0);
  check(
    'the inactive account created no publication job',
    (
      await db.collection('roleClaimJobs').doc('inactive-retry-user').get()
    ).exists,
    false,
  );
}

async function testUnboundedOtpChallengeCannotClaimARole() {
  section('an unbounded legacy OTP challenge cannot claim a role');

  await reset();
  await db.collection('users').doc('unbounded-user').set({
    uid: 'unbounded-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
    email: 'unbounded-user@example.test',
  });
  const challenge = 'unbounded-role-claim-challenge';
  await db
    .collection('otpCodes')
    .doc(testOtpDocumentId('email', 'unbounded-user@example.test'))
    .set({
      channel: 'email',
      identifierHash: crypto
        .createHash('sha256')
        .update('unbounded-user@example.test')
        .digest('hex'),
      verified: true,
      verifiedByUid: 'unbounded-user',
      challengeHash: crypto.createHash('sha256').update(challenge).digest('hex'),
      challengeUsed: false,
    });

  await expectDenied(
    'the unbounded challenge is refused',
    () =>
      invoke(
        registerUserRole,
        { role: 'owner', challenge },
        'unbounded-user',
      ),
    'failed-precondition',
  );
  check(
    'the unbounded challenge did not change the role',
    (await db.collection('users').doc('unbounded-user').get()).get('role'),
    'student',
  );
  check(
    'the unbounded challenge created no publication job',
    (await db.collection('roleClaimJobs').doc('unbounded-user').get()).exists,
    false,
  );
}

async function testRoleChangeCleanupIsRetryable() {
  section('a pending role-change cleanup is retried');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'owner');
  await db.collection('users').doc('target-1').update({
    roleChangedFrom: 'student',
    roleChangeCleanupPending: true,
  });
  await seedRequest('JRQ-ROLE-CLEANUP', {
    studentId: 'target-1',
    ownerId: 'owner-1',
    status: 'pending',
  });
  await seedUser('owner-1', 'owner');

  const originalSetClaims = auth.setCustomUserClaims;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.setCustomUserClaims = async () => undefined;
  auth.revokeRefreshTokens = async () => undefined;
  try {
    await invoke(setUserRole, { uid: 'target-1', role: 'owner' }, 'admin-1');
  } finally {
    auth.setCustomUserClaims = originalSetClaims;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const request = await db.collection('joinRequests').doc('JRQ-ROLE-CLEANUP').get();
  const profile = await db.collection('users').doc('target-1').get();
  check(
    'the open request of the previous role was cancelled',
    request.get('status'),
    'cancelled',
  );
  check(
    'the durable cleanup marker was cleared',
    profile.get('roleChangeCleanupPending'),
    undefined,
  );
}

async function testBanDuringDeletionGraceCannotBeUndone() {
  section('a ban during the deletion grace period survives cancellation');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');
  await db.collection('users').doc('target-1').update({
    isActive: false,
    deletionScheduled: true,
    deletionState: 'scheduled',
    deletionPreviousIsActive: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });
  await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'))
    .set({
      type: 'accountDeletion',
      uid: 'target-1',
      status: 'scheduled',
      deletionClaimed: false,
      previousIsActive: true,
      deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
    });

  const originalRevoke = auth.revokeRefreshTokens;
  const originalUpdateUser = auth.updateUser;
  const authUpdates = [];
  auth.revokeRefreshTokens = async () => undefined;
  auth.updateUser = async (_uid, update) => {
    authUpdates.push(update);
  };

  try {
    await invoke(banUser, { uid: 'target-1' }, 'admin-1');
    await invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1');
  } finally {
    auth.revokeRefreshTokens = originalRevoke;
    auth.updateUser = originalUpdateUser;
  }

  const user = await db.collection('users').doc('target-1').get();
  check(
    'the cancelled deletion did not reactivate the banned account',
    user.get('isActive'),
    false,
  );
  check(
    'the ban marker is still present after cancellation',
    user.get('banReason'),
    'Banned by admin',
  );
  check(
    'the cancellation did not enable Auth for the banned account',
    authUpdates.some((update) => update?.disabled === false),
    false,
  );
}

async function testForcedLogoutDuringDeletionGraceCannotBeUndone() {
  section('a forced logout during the deletion grace period survives cancellation');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');
  await db.collection('users').doc('target-1').update({
    isActive: false,
    deletionScheduled: true,
    deletionState: 'scheduled',
    deletionPreviousIsActive: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });
  await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'))
    .set({
      type: 'accountDeletion',
      uid: 'target-1',
      status: 'scheduled',
      deletionClaimed: false,
      previousIsActive: true,
      deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
    });

  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  const authUpdates = [];
  auth.updateUser = async (_uid, update) => {
    authUpdates.push(update);
  };
  auth.revokeRefreshTokens = async () => undefined;

  try {
    await invoke(revokeUserTokens, { uid: 'target-1' }, 'admin-1');
    await invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1');
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const user = await db.collection('users').doc('target-1').get();
  const job = await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'))
    .get();
  check(
    'the cancelled deletion did not reactivate the forced-logout account',
    user.get('isActive'),
    false,
  );
  check(
    'the forced-logout marker is still present after cancellation',
    user.get('forcedLogoutAt') != null,
    true,
  );
  check(
    'the cancellation did not enable Auth for the forced-logout account',
    authUpdates.some((update) => update?.disabled === false),
    false,
  );
  check('the completed cancellation removed the restore record', job.exists, false);
}

async function testBanDuringRestoreKeepsADurableDisableRetry() {
  section('a ban during a restore keeps a durable Auth-disable retry');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student');
  await db.collection('users').doc('target-1').update({
    isActive: false,
    deletionScheduled: true,
    deletionState: 'scheduled',
    deletionPreviousIsActive: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });
  const jobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'));
  await jobRef.set({
    type: 'accountDeletion',
    uid: 'target-1',
    status: 'scheduled',
    deletionClaimed: false,
    previousIsActive: true,
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });

  let banTriggered = false;
  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.updateUser = async (_uid, update) => {
    if (update?.disabled === false) {
      if (!banTriggered) {
        banTriggered = true;
        try {
          await invoke(banUser, { uid: 'target-1' }, 'admin-1');
        } catch (_error) {
          // The ban's Firestore state is committed before its Auth call. The
          // simulated Auth failure below must not undo that durable state.
        }
      }
      return;
    }
    throw new Error('simulated Auth disable failure');
  };
  auth.revokeRefreshTokens = async () => undefined;

  await expectDenied(
    'the restore reports the failed compensating disable',
    () => invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1'),
    'internal',
  );

  const pendingJob = await jobRef.get();
  check('the concurrent ban was committed', pendingJob.get('previousIsActive'), false);
  check(
    'the failed compensating disable remains durable',
    pendingJob.get('authDisablePending'),
    true,
  );
  check(
    'the restore record was not deleted before Auth agreed',
    pendingJob.exists,
    true,
  );
  check(
    'the banned profile stayed inactive',
    (await db.collection('users').doc('target-1').get()).get('isActive'),
    false,
  );

  auth.updateUser = async () => undefined;
  try {
    await processAccountDeletionJobs.run({});
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const completedJob = await jobRef.get();
  const user = await db.collection('users').doc('target-1').get();
  check('the worker removed the completed restore record', completedJob.exists, false);
  check('the worker kept the banned account inactive', user.get('isActive'), false);
  check('the ban marker survived the restore', user.get('banReason'), 'Banned by admin');
}

async function testUnbanRepairsADeletionScheduledDuringTheAuthEnable() {
  section('an unban repairs a deletion scheduled during its Auth enable');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student', false);

  let deletionScheduled = false;
  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  const authUpdates = [];
  auth.updateUser = async (_uid, update) => {
    authUpdates.push(update);
    if (update?.disabled === false && !deletionScheduled) {
      deletionScheduled = true;
      await scheduleAccountDeletionJob(
        'target-1',
        firestore.Timestamp.fromMillis(Date.now() + 60_000),
        'admin-1',
      );
    }
  };
  auth.revokeRefreshTokens = async () => undefined;

  try {
    await expectDenied(
      'the unban refuses the newly scheduled deletion',
      () => invoke(unbanUser, { uid: 'target-1' }, 'admin-1'),
      'failed-precondition',
    );
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const job = await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'))
    .get();
  const user = await db.collection('users').doc('target-1').get();
  check('the racing deletion job remains scheduled', job.get('status'), 'scheduled');
  check(
    'the compensation left a durable Auth-disable marker',
    job.get('authDisablePending'),
    true,
  );
  check(
    'the compensation advanced the durable Auth revision',
    Number(job.get('authStateRevision') || 0) >= 2,
    true,
  );
  check('the deleting profile stayed inactive', user.get('isActive'), false);
  check(
    'the stale Auth enable was compensated',
    authUpdates.some((update) => update?.disabled === true),
    true,
  );
}

async function testConcurrentBanCannotBeUndoneByAnInFlightUnban() {
  section('a concurrent ban cannot be undone by an in-flight unban');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student', false);
  await db.collection('users').doc('target-1').update({
    banReason: 'Original ban',
    bannedAt: firestore.Timestamp.now(),
  });

  let banTriggered = false;
  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  auth.updateUser = async (_uid, update) => {
    if (update?.disabled === false && !banTriggered) {
      banTriggered = true;
      await invoke(
        banUser,
        { uid: 'target-1', reason: 'Concurrent ban' },
        'admin-1',
      );
    }
  };
  auth.revokeRefreshTokens = async () => undefined;

  try {
    await expectDenied(
      'the stale unban refuses to overwrite the concurrent ban',
      () => invoke(unbanUser, { uid: 'target-1' }, 'admin-1'),
      'failed-precondition',
    );
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const user = await db.collection('users').doc('target-1').get();
  check('the concurrent ban kept the account inactive', user.get('isActive'), false);
  check(
    'the concurrent ban marker survived the stale unban',
    user.get('banReason'),
    'Concurrent ban',
  );
  check(
    'the administrative state revision advanced',
    Number(user.get('administrativeStateRevision') || 0) >= 1,
    true,
  );
}

async function testLegacyCancellationWithoutPreviousStateStaysInactive() {
  section('a legacy cancellation without previous state stays inactive');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('target-1', 'student', false);
  await db.collection('users').doc('target-1').update({
    deletionScheduled: true,
    deletionState: 'scheduled',
    deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
  });
  await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('target-1'))
    .set({
      type: 'accountDeletion',
      uid: 'target-1',
      status: 'scheduled',
      deletionClaimed: false,
      deleteAfter: firestore.Timestamp.fromMillis(Date.now() + 60_000),
    });

  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  const authUpdates = [];
  auth.updateUser = async (_uid, update) => {
    authUpdates.push(update);
  };
  auth.revokeRefreshTokens = async () => undefined;

  try {
    await invoke(cancelUserDeletion, { uid: 'target-1' }, 'admin-1');
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
  }

  const user = await db.collection('users').doc('target-1').get();
  check(
    'the ambiguous legacy account stayed inactive',
    user.get('isActive'),
    false,
  );
  check(
    'the legacy cancellation did not enable Auth',
    authUpdates.some((update) => update?.disabled === false),
    false,
  );
  check(
    'the legacy restore record was removed',
    (
      await db
        .collection('accountDeletionJobs')
        .doc(accountDeletionJobId('target-1'))
        .get()
    ).exists,
    false,
  );
}

async function testAccountDeletionCancelsAndNotifiesOpenRequests() {
  section('account deletion cancels open requests and notifies the other party');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await db.collection('users').doc('owner-1').update({
    fcmToken: 'owner-device-token',
  });
  await seedRoom('RM-1', 'owner-1');
  await seedRequest('JRQ-DELETED-ACCOUNT', {
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'pending',
  });

  const jobRef = await enqueueAccountDeletion('student-1', {
    source: 'test-account-deletion',
    requestedBy: 'admin-1',
    authorizationUid: 'admin-1',
  });

  const originalGetStorage = storageSdk.getStorage;
  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  const originalDeleteUser = auth.deleteUser;
  const originalGetMessaging = messagingSdk.getMessaging;
  const pushes = [];
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => [[]],
    }),
  });
  messagingSdk.getMessaging = () => ({
    send: async (message) => {
      pushes.push(message);
    },
  });
  auth.updateUser = async () => undefined;
  auth.revokeRefreshTokens = async () => undefined;
  auth.deleteUser = async () => undefined;

  try {
    await processAccountDeletionJob(jobRef);
  } finally {
    storageSdk.getStorage = originalGetStorage;
    messagingSdk.getMessaging = originalGetMessaging;
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
    auth.deleteUser = originalDeleteUser;
  }

  check(
    'the deleted account request was removed with the account',
    (
      await db
        .collection('joinRequests')
        .doc('JRQ-DELETED-ACCOUNT')
        .get()
    ).exists,
    false,
  );
  const notifications = await db
    .collection('notifications')
    .where('userId', '==', 'owner-1')
    .get();
  check('the unaffected owner received one cancellation', notifications.size, 1);
  const notification = notifications.docs[0];
  check(
    'the cancellation notification keeps the request id',
    notification.get('data')?.requestId,
    'JRQ-DELETED-ACCOUNT',
  );
  check('the cancellation notification was pushed to the device', pushes.length, 1);
  check(
    'the pushed cancellation keeps the request id',
    pushes[0]?.data?.requestId,
    'JRQ-DELETED-ACCOUNT',
  );
  check(
    'the pushed cancellation keeps the notification type',
    pushes[0]?.data?.type,
    'joinRequest',
  );
}

async function testDelayedNotificationCannotCrossTheDeletionFence() {
  section('a delayed notification cannot cross the account-deletion fence');

  await reset();
  await seedUser('target-1', 'student');
  const userRef = db.collection('users').doc('target-1');

  const originalRunTransaction = db.runTransaction;
  let fenced = false;
  db.runTransaction = async (updateFunction) => {
    if (!fenced) {
      fenced = true;
      await userRef.update({
        isActive: false,
        deletionState: 'deleting',
        deletionFencedAt: firestore.Timestamp.now(),
      });
    }
    return originalRunTransaction.call(db, updateFunction);
  };

  let written = true;
  try {
    written = await notify(
      'target-1',
      'Late notice',
      'This must not survive the deletion fence.',
      'general',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
  }

  check('the delayed notification was refused', written, false);
  check(
    'the delayed notification was not written',
    (await db.collection('notifications').get()).empty,
    true,
  );
}

async function testChatNotificationIsBoundToOneSentMessage() {
  section('a chat notification is bound to one exact sent message');

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await db.collection('conversations').doc('conversation-1').set({
    conversationId: 'conversation-1',
    participantIds: ['student-1', 'owner-1'],
    roomId: 'RM-1',
    createdByServer: true,
  });
  const messages = db
    .collection('conversations')
    .doc('conversation-1')
    .collection('messages');
  await messages.doc('message-1').set({
    messageId: 'message-1',
    conversationId: 'conversation-1',
    senderId: 'student-1',
    receiverId: 'owner-1',
    content: 'The server-stored body',
    type: 'text',
    createdAt: firestore.Timestamp.now(),
  });
  await messages.doc('foreign-message').set({
    messageId: 'foreign-message',
    conversationId: 'conversation-1',
    senderId: 'owner-1',
    receiverId: 'student-1',
    content: 'Not sent by the caller',
    type: 'text',
    createdAt: firestore.Timestamp.now(),
  });

  const first = await invoke(
    notifyUser,
    {
      userId: 'owner-1',
      type: 'newMessage',
      title: 'Spoofed title',
      body: 'Spoofed body',
      data: {
        conversationId: 'conversation-1',
        messageId: 'message-1',
      },
    },
    'student-1',
  );
  check('the first chat notification was created', first.created, true);

  const notifications = await db.collection('notifications').get();
  check('one message creates one notification', notifications.size, 1);
  const notification = notifications.docs[0];
  check(
    'the notification body comes from the stored message',
    notification.get('body'),
    'The server-stored body',
  );
  check(
    'the client cannot choose the notification title',
    notification.get('title'),
    'New message',
  );
  check(
    'the notification keeps the exact message id',
    notification.get('data')?.messageId,
    'message-1',
  );

  const second = await invoke(
    notifyUser,
    {
      userId: 'owner-1',
      type: 'newMessage',
      data: {
        conversationId: 'conversation-1',
        messageId: 'message-1',
      },
    },
    'student-1',
  );
  check('a repeated chat notification is idempotent', second.created, false);
  check(
    'the repeated call did not create another notification',
    (await db.collection('notifications').get()).size,
    1,
  );

  await expectDenied(
    'a caller cannot notify about a message which somebody else sent',
    () =>
      invoke(
        notifyUser,
        {
          userId: 'owner-1',
          type: 'newMessage',
          data: {
            conversationId: 'conversation-1',
            messageId: 'foreign-message',
          },
        },
        'student-1',
      ),
    'permission-denied',
  );
}

async function testSubmittedPaymentCannotBeReplaced() {
  section('a submitted payment reference cannot be replaced');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-1', 'owner-1');
  await seedRequest('JRQ-SUBMITTED-ONCE', {
    status: 'studentConfirmed',
    monthlyRentAtJoin: 5000,
    commissionPercentageAtJoin: 30,
    platformFeePayer: 'owner',
  });

  await invoke(
    submitPayment,
    {
      requestId: 'JRQ-SUBMITTED-ONCE',
      reference: 'UPI-FIRST-REFERENCE',
      method: 'upi',
    },
    'owner-1',
  );

  await expectDenied(
    'a second submitted payment is refused',
    () =>
      invoke(
        submitPayment,
        {
          requestId: 'JRQ-SUBMITTED-ONCE',
          reference: 'UPI-SECOND-REFERENCE',
          method: 'upi',
        },
        'owner-1',
      ),
    'failed-precondition',
  );

  const payment = await db
    .collection('payments')
    .doc('JRQ-SUBMITTED-ONCE')
    .get();
  const request = await db
    .collection('joinRequests')
    .doc('JRQ-SUBMITTED-ONCE')
    .get();
  check(
    'the first payment reference was preserved',
    payment.get('reference'),
    'UPI-FIRST-REFERENCE',
  );
  check(
    'the request keeps the first payment reference',
    request.get('advancePaymentReference'),
    'UPI-FIRST-REFERENCE',
  );
  check(
    'the rejected second reference created no reference lock',
    (await db.collection('paymentReferences').get()).size,
    1,
  );
}

async function testListingDeletionRemovesOrphanReviews() {
  section('listing deletion removes the reviews of the removed listing');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-REVIEW-CLEANUP', 'owner-1');
  await seedRequest('JRQ-REVIEW-CLEANUP', {
    roomId: 'RM-REVIEW-CLEANUP',
    status: 'cancelled',
  });
  await db.collection('roomReviews').doc('REV-OLD-ROOM').set({
    reviewId: 'REV-OLD-ROOM',
    roomId: 'RM-REVIEW-CLEANUP',
    studentId: 'student-1',
    ownerId: 'owner-1',
    rating: 5,
    comment: 'Old review',
    createdAt: firestore.Timestamp.now(),
    updatedAt: firestore.Timestamp.now(),
  });

  const originalGetStorage = storageSdk.getStorage;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => [[]],
      file: () => ({ delete: async () => undefined }),
    }),
  });
  try {
    await invoke(
      deleteRoomListing,
      { roomId: 'RM-REVIEW-CLEANUP' },
      'owner-1',
    );
  } finally {
    storageSdk.getStorage = originalGetStorage;
  }

  check(
    'the review of the deleted listing was removed',
    (await db.collection('roomReviews').doc('REV-OLD-ROOM').get()).exists,
    false,
  );
}

async function testPhotoCleanupKeepsAReAddedImage() {
  section('room-photo cleanup keeps an image which was added again');

  await reset();
  const path = 'rooms/owner-1/RM-1/photo.jpg';
  const url =
    'https://firebasestorage.googleapis.com/v0/b/demo/o/' +
    encodeURIComponent(path);
  await seedRoom('RM-1', 'owner-1', { images: [url] });
  await db.collection('cleanupJobs').doc('readded-photo').set({
    type: 'roomPhotoPaths',
    roomId: 'RM-1',
    ownerId: 'owner-1',
    paths: [path],
    attempts: 0,
  });

  const deletedPaths = [];
  const originalGetStorage = storageSdk.getStorage;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => [[]],
      file: (filePath) => ({
        delete: async () => {
          deletedPaths.push(filePath);
        },
      }),
    }),
  });
  try {
    await processRoomPhotoCleanupJobs.run({});
  } finally {
    storageSdk.getStorage = originalGetStorage;
  }

  check('the re-added image was not deleted', deletedPaths, []);
  check(
    'the completed cleanup job was removed',
    (await db.collection('cleanupJobs').doc('readded-photo').get()).exists,
    false,
  );
  check(
    'the temporary room cleanup lock was released',
    (await db.collection('rooms').doc('RM-1').get()).get('photoCleanupLock'),
    undefined,
  );
}

async function testListingDeletionPagesRequestsAndKeepsTheirIds() {
  section('listing deletion pages its requests and keeps cancelled request ids');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-PAGED', 'owner-1');

  const batch = db.batch();
  for (let index = 0; index < 301; index += 1) {
    const id = `JRQ-PAGE-${String(index).padStart(3, '0')}`;
    batch.set(db.collection('joinRequests').doc(id), {
      requestId: id,
      roomId: 'RM-PAGED',
      studentId: 'student-1',
      ownerId: 'owner-1',
      status: index === 300 ? 'pending' : 'cancelled',
      monthlyRentAtJoin: 5000,
      commissionPercentageAtJoin: 30,
      platformFeePayer: 'owner',
      platformCutTaken: false,
      advancePaid: false,
      advancePaymentStatus: '',
    });
  }
  await batch.commit();

  const originalCollection = db.collection.bind(db);
  const observedLimits = [];
  db.collection = (collectionName) => {
    const collection = originalCollection(collectionName);
    if (collectionName !== 'joinRequests') return collection;

    const originalWhere = collection.where.bind(collection);
    collection.where = (...args) => {
      const query = originalWhere(...args);
      const state = { limited: false };
      const instrument = (candidate) => {
        const originalLimit = candidate.limit.bind(candidate);
        candidate.limit = (count) => {
          state.limited = true;
          observedLimits.push(count);
          return originalLimit(count);
        };
        const originalOrderBy = candidate.orderBy.bind(candidate);
        candidate.orderBy = (...orderArgs) => {
          const next = originalOrderBy(...orderArgs);
          instrument(next);
          return next;
        };
        const originalGet = candidate.get.bind(candidate);
        candidate.get = async (...getArgs) => {
          if (!state.limited) {
            throw new Error('an unbounded join-request query was used');
          }
          return originalGet(...getArgs);
        };
      };
      instrument(query);
      return query;
    };
    return collection;
  };

  const originalGetStorage = storageSdk.getStorage;
  storageSdk.getStorage = () => ({
    bucket: () => ({
      getFiles: async () => [[]],
      file: () => ({ delete: async () => undefined }),
    }),
  });

  try {
    await invoke(deleteRoomListing, { roomId: 'RM-PAGED' }, 'owner-1');
  } finally {
    db.collection = originalCollection;
    storageSdk.getStorage = originalGetStorage;
  }

  check(
    'every join-request query was bounded',
    observedLimits.every((limit) => limit <= 300),
    true,
  );
  check(
    'the bounded query used a full page',
    observedLimits.includes(300),
    true,
  );
  check(
    'the request on the second page was cancelled',
    (
      await db
        .collection('joinRequests')
        .doc('JRQ-PAGE-300')
        .get()
    ).get('status'),
    'cancelled',
  );

  const notifications = await db
    .collection('notifications')
    .where('userId', '==', 'student-1')
    .get();
  check('the paged cancellation created one notification', notifications.size, 1);
  check(
    'the paged cancellation notification keeps the request id',
    notifications.docs[0]?.get('data')?.requestId,
    'JRQ-PAGE-300',
  );
}

async function testStudentCancellationStopsAfterJoining() {
  section('a student cannot cancel after joining a room');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-1', 'owner-1');
  await seedRequest('JRQ-NOT-JOINED', {
    status: 'ownerConfirmed',
  });
  await seedRequest('JRQ-CONFIRMED-NOT-JOINED', {
    status: 'studentConfirmed',
  });
  await seedRequest('JRQ-LEGACY-CONFIRMED-NOT-JOINED', {
    status: 'owner_confirmed',
  });

  const pendingCancellation = await invoke(
    cancelJoinRequest,
    { requestId: 'JRQ-NOT-JOINED' },
    'student-1',
  );
  check(
    'a student may still cancel before the owner accepts the booking',
    pendingCancellation.status,
    'cancelled',
  );

  const confirmedCancellation = await invoke(
    cancelJoinRequest,
    { requestId: 'JRQ-CONFIRMED-NOT-JOINED' },
    'student-1',
  );
  check(
    'a student may still cancel a confirmed but inactive booking',
    confirmedCancellation.status,
    'cancelled',
  );

  const legacyConfirmedCancellation = await invoke(
    cancelJoinRequest,
    { requestId: 'JRQ-LEGACY-CONFIRMED-NOT-JOINED' },
    'student-1',
  );
  check(
    'a student may still cancel a legacy confirmed but inactive booking',
    legacyConfirmedCancellation.status,
    'cancelled',
  );

  await seedRequest('JRQ-JOINED', {
    status: 'adminReviewed',
  });
  await expectDenied(
    'a student cannot cancel after joining the room',
    () =>
      invoke(
        cancelJoinRequest,
        { requestId: 'JRQ-JOINED' },
        'student-1',
      ),
    'failed-precondition',
  );
  check(
    'the joined request was not cancelled by the student',
    (await db.collection('joinRequests').doc('JRQ-JOINED').get()).get('status'),
    'adminReviewed',
  );
}

async function testStudentCanRequestDifferentRooms() {
  section('one student may request more than one different room');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('owner-2', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-FIRST', 'owner-1');
  await seedRoom('RM-SECOND', 'owner-2');

  const first = await invoke(
    createJoinRequest,
    { roomId: 'RM-FIRST' },
    'student-1',
  );
  const second = await invoke(
    createJoinRequest,
    { roomId: 'RM-SECOND' },
    'student-1',
  );

  check('the first room request was created', first.success, true);
  check('the second room request was created', second.success, true);
  check('the two room requests have different ids', first.requestId !== second.requestId, true);

  const requests = await db
    .collection('joinRequests')
    .where('studentId', '==', 'student-1')
    .get();
  check('the student has one request for each room', requests.size, 2);
  check(
    'the first room request was kept',
    requests.docs.some((doc) => doc.get('roomId') === 'RM-FIRST'),
    true,
  );
  check(
    'the second room request was kept',
    requests.docs.some((doc) => doc.get('roomId') === 'RM-SECOND'),
    true,
  );

  await expectDenied(
    'the student cannot create a second request for the same room',
    () =>
      invoke(
        createJoinRequest,
        { roomId: 'RM-FIRST' },
        'student-1',
      ),
    'already-exists',
  );
  check(
    'the duplicate request was not created',
    (
      await db
        .collection('joinRequests')
        .where('studentId', '==', 'student-1')
        .get()
    ).size,
    2,
  );
}

async function testOwnerAvailabilityReleaseEndsOnlyThisRoomsBookings() {
  section('an owner can make an occupied room available and release its students');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedUser('student-2', 'student');
  await seedUser('student-3', 'student');
  await seedRoom('RM-RELEASE', 'owner-1', {
    occupancy: 2,
    currentOccupancy: 2,
    status: 'occupied',
  });
  await seedRoom('RM-OTHER', 'owner-1', {
    occupancy: 1,
    currentOccupancy: 1,
    status: 'occupied',
  });

  await seedRequest('JRQ-RELEASE-ACTIVE', {
    roomId: 'RM-RELEASE',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'adminReviewed',
    advancePaid: true,
    advancePaymentStatus: 'verified',
    invoiceId: 'INV-JRQ-RELEASE-ACTIVE',
  });
  await seedRequest('JRQ-RELEASE-SECOND-ACTIVE', {
    roomId: 'RM-RELEASE',
    studentId: 'student-2',
    ownerId: 'owner-1',
    status: 'adminReviewed',
    advancePaid: true,
    advancePaymentStatus: 'verified',
  });
  await seedRequest('JRQ-RELEASE-NOT-JOINED', {
    roomId: 'RM-RELEASE',
    studentId: 'student-3',
    ownerId: 'owner-1',
    status: 'studentConfirmed',
  });
  await seedRequest('JRQ-OTHER-ROOM', {
    roomId: 'RM-OTHER',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'adminReviewed',
    advancePaid: true,
    advancePaymentStatus: 'verified',
  });

  await db.collection('payments').doc('PAY-RELEASE').set({
    requestId: 'JRQ-RELEASE-ACTIVE',
    roomId: 'RM-RELEASE',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'verified',
  });
  await db.collection('commissionInvoices').doc('INV-JRQ-RELEASE-ACTIVE').set({
    invoiceId: 'INV-JRQ-RELEASE-ACTIVE',
    joinRequestId: 'JRQ-RELEASE-ACTIVE',
    roomId: 'RM-RELEASE',
    tenantId: 'student-1',
    ownerId: 'owner-1',
    status: 'pending',
  });

  const result = await invoke(
    setRoomListingAvailability,
    { roomId: 'RM-RELEASE', isOccupied: false },
    'owner-1',
  );
  check('the owner availability release succeeded', result.success, true);
  check('the released listing is available', result.status, 'available');
  check('the owner released two active requests', result.releasedRequests, 2);
  check('the owner released two students', result.releasedStudents, 2);

  const releasedRoom = await db.collection('rooms').doc('RM-RELEASE').get();
  const releasedRequest = await db
    .collection('joinRequests')
    .doc('JRQ-RELEASE-ACTIVE')
    .get();
  check('the released room has no occupants', releasedRoom.get('currentOccupancy'), 0);
  check('the released room is available', releasedRoom.get('status'), 'available');
  check(
    'the active request in the released room was cancelled',
    releasedRequest.get('status'),
    'cancelled',
  );
  check(
    'the released request keeps its verified payment status',
    releasedRequest.get('advancePaymentStatus'),
    'verified',
  );
  check(
    'the released request keeps its paid marker',
    releasedRequest.get('advancePaid'),
    true,
  );
  check(
    'the released request keeps its invoice reference',
    releasedRequest.get('invoiceId'),
    'INV-JRQ-RELEASE-ACTIVE',
  );
  check(
    'the second active request in the released room was cancelled',
    (await db.collection('joinRequests').doc('JRQ-RELEASE-SECOND-ACTIVE').get()).get('status'),
    'cancelled',
  );
  check(
    'the request which has not joined yet keeps its state',
    (await db.collection('joinRequests').doc('JRQ-RELEASE-NOT-JOINED').get()).get('status'),
    'studentConfirmed',
  );
  check(
    'the student joined to another room keeps that subscription',
    (await db.collection('joinRequests').doc('JRQ-OTHER-ROOM').get()).get('status'),
    'adminReviewed',
  );
  const otherRoom = await db.collection('rooms').doc('RM-OTHER').get();
  check('the other room keeps its occupant', otherRoom.get('currentOccupancy'), 1);
  check('the other room keeps its status', otherRoom.get('status'), 'occupied');
  check(
    'the verified payment history was not rewritten',
    (await db.collection('payments').doc('PAY-RELEASE').get()).get('status'),
    'verified',
  );
  check(
    'the invoice history was not rewritten',
    (await db.collection('commissionInvoices').doc('INV-JRQ-RELEASE-ACTIVE').get()).get('status'),
    'pending',
  );
  check(
    'the release records the owner as the actor',
    (await db.collection('joinRequests').doc('JRQ-RELEASE-ACTIVE').get()).get('cancelledByRole'),
    'owner',
  );

  const releaseNotifications = await db
    .collection('notifications')
    .where('userId', '==', 'student-1')
    .get();
  check(
    'the released student was notified',
    releaseNotifications.docs.some(
      (doc) => doc.get('title') === 'Room booking ended',
    ),
    true,
  );
  check(
    'the release notification keeps the payment history unchanged',
    releaseNotifications.docs.some(
      (doc) =>
        String(doc.get('body') || '').includes(
          'Payment and invoice history is kept unchanged',
        ),
    ),
    true,
  );
}

async function testAvailabilityReleaseRejectsUnauthorizedCallers() {
  section('availability release rejects unauthorized callers');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('owner-2', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-OWNER-1', 'owner-1');
  await seedRoom('RM-OWNER-2', 'owner-2');

  await expectDenied(
    'an owner cannot release another owner listing',
    () =>
      invoke(
        setRoomListingAvailability,
        { roomId: 'RM-OWNER-2', isOccupied: false },
        'owner-1',
      ),
  );
  check(
    'the other owner listing was not changed',
    (await db.collection('rooms').doc('RM-OWNER-2').get()).get('status'),
    'available',
  );

  await expectDenied(
    'a student cannot release a room through the owner callable',
    () =>
      invoke(
        setRoomListingAvailability,
        { roomId: 'RM-OWNER-1', isOccupied: false },
        'student-1',
      ),
  );
  await expectDenied(
    'a student cannot release a room through the admin callable',
    () =>
      invoke(
        adminSetRoomListingStatus,
        { roomId: 'RM-OWNER-1', status: 'available' },
        'student-1',
      ),
  );
  check(
    'the unauthorized calls did not change the owner listing',
    (await db.collection('rooms').doc('RM-OWNER-1').get()).get('status'),
    'available',
  );
}

async function testAdminAvailabilityReleaseEndsBookings() {
  section('an admin can make an occupied room available and release its students');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-ADMIN-RELEASE', 'owner-1', {
    occupancy: 1,
    currentOccupancy: 1,
    status: 'occupied',
  });
  await seedRequest('JRQ-ADMIN-RELEASE', {
    roomId: 'RM-ADMIN-RELEASE',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'adminReviewed',
  });

  const result = await invoke(
    adminSetRoomListingStatus,
    { roomId: 'RM-ADMIN-RELEASE', status: 'available' },
    'admin-1',
  );
  check('the admin availability release succeeded', result.success, true);
  check('the admin released one request', result.releasedRequests, 1);
  check('the admin released one student', result.releasedStudents, 1);
  const room = await db.collection('rooms').doc('RM-ADMIN-RELEASE').get();
  check('the admin released the room occupancy', room.get('currentOccupancy'), 0);
  check('the admin made the room available', room.get('status'), 'available');
  check(
    'the admin ended the active booking',
    (await db.collection('joinRequests').doc('JRQ-ADMIN-RELEASE').get()).get('status'),
    'cancelled',
  );
  check(
    'the release records the admin as the actor',
    (await db.collection('joinRequests').doc('JRQ-ADMIN-RELEASE').get()).get('cancelledByRole'),
    'admin',
  );
}

async function testInteractionMetadataUsesRealParticipantNames() {
  section('interaction metadata uses the real participant and listing names');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await db.collection('users').doc('owner-1').update({ name: 'Meera Nair' });
  await db.collection('users').doc('student-1').update({ name: 'Arjun Shah' });
  await seedRoom('RM-NAMES', 'owner-1', { title: 'Sunset Studio' });

  const created = await invoke(
    createJoinRequest,
    { roomId: 'RM-NAMES' },
    'student-1',
  );
  const requestId = created.requestId;
  const request = await db.collection('joinRequests').doc(requestId).get();

  check('the request records the real student name', request.get('studentName'), 'Arjun Shah');
  check('the request records the real owner name', request.get('ownerName'), 'Meera Nair');
  check('the request records the real room title', request.get('roomTitle'), 'Sunset Studio');
  check(
    'the request keeps an immutable student-name snapshot',
    request.get('studentNameAtRequest'),
    'Arjun Shah',
  );
  check(
    'the request keeps an immutable owner-name snapshot',
    request.get('ownerNameAtRequest'),
    'Meera Nair',
  );
  check(
    'the request keeps an immutable room-title snapshot',
    request.get('roomTitleAtRequest'),
    'Sunset Studio',
  );

  const studentDetails = await invoke(
    getBookingInteractionDetails,
    { requestId },
    'student-1',
  );
  check('the student sees the real owner name', studentDetails.ownerName, 'Meera Nair');
  check('the student sees the real listing title', studentDetails.roomTitle, 'Sunset Studio');
  check('the student is not blocked initially', studentDetails.canSend, true);

  const ownerDetails = await invoke(
    getBookingInteractionDetails,
    { requestId },
    'owner-1',
  );
  check('the owner sees the real student name', ownerDetails.studentName, 'Arjun Shah');
  check('the owner sees the real listing title', ownerDetails.roomTitle, 'Sunset Studio');

  const adminDetails = await invoke(
    getBookingInteractionDetails,
    { requestId },
    'admin-1',
  );
  check('the admin sees the real student name', adminDetails.studentName, 'Arjun Shah');
  check('the admin sees the real owner name', adminDetails.ownerName, 'Meera Nair');

  const contact = await invoke(
    getRoomContactDetails,
    { roomId: 'RM-NAMES' },
    'student-1',
  );
  check('the room contact resolves the real owner name', contact.ownerName, 'Meera Nair');
  check('the room contact resolves the real listing title', contact.roomTitle, 'Sunset Studio');

  // The owner opens the conversation through the verified request. This is
  // the path which lets an owner reply to a student without guessing a uid.
  const opened = await invoke(
    openConversation,
    {
      otherUserId: 'student-1',
      roomId: 'RM-NAMES',
      requestId,
    },
    'owner-1',
  );
  const conversationId = ['owner-1', 'student-1'].sort().join('_');
  check('the owner opened the deterministic conversation', opened.conversationId, conversationId);
  check('the owner sees the real student name in chat', opened.peerName, 'Arjun Shah');
  check('the chat identifies the peer role', opened.peerRole, 'student');
  check('the chat carries the real listing title', opened.roomTitle, 'Sunset Studio');

  const conversation = await db
    .collection('conversations')
    .doc(conversationId)
    .get();
  check(
    'the server conversation stores both real names',
    conversation.get('participantNames'),
    { 'owner-1': 'Meera Nair', 'student-1': 'Arjun Shah' },
  );
  check('the server conversation stores the listing title', conversation.get('roomTitle'), 'Sunset Studio');
  const capturedContext = await db
    .collection('conversations')
    .doc(conversationId)
    .collection('contexts')
    .doc(requestId)
    .get();
  check(
    'the server stored a request-scoped listing context',
    capturedContext.get('roomTitle'),
    'Sunset Studio',
  );
  check(
    'the request-scoped context records its original capture time',
    capturedContext.get('capturedAt') instanceof firestore.Timestamp,
    true,
  );

  const conversationBeforeDetails = await db
    .collection('conversations')
    .doc(conversationId)
    .get();
  const conversationVersionBeforeDetails =
    conversationBeforeDetails.updateTime?.toMillis() ?? 0;

  const chatDetails = await invoke(
    getConversationInteractionDetails,
    { conversationId, requestId },
    'student-1',
  );
  check('the chat resolves the real peer name', chatDetails.peerName, 'Meera Nair');
  check('the chat resolves the real listing title', chatDetails.roomTitle, 'Sunset Studio');

  const ownerChatDetails = await invoke(
    getConversationInteractionDetails,
    { conversationId, roomId: 'RM-NAMES', requestId },
    'owner-1',
  );
  check(
    'the owner-side chat resolves the real student name',
    ownerChatDetails.peerName,
    'Arjun Shah',
  );
  check(
    'the owner-side chat resolves the real listing title',
    ownerChatDetails.roomTitle,
    'Sunset Studio',
  );

  const ownerConversationListDetails = await invoke(
    getConversationInteractionDetails,
    { conversationId, roomId: 'RM-NAMES' },
    'owner-1',
  );
  check(
    'the owner-side conversation-list context resolves the real student name',
    ownerConversationListDetails.peerName,
    'Arjun Shah',
  );
  const conversationAfterDetails = await db
    .collection('conversations')
    .doc(conversationId)
    .get();
  check(
    'read-only chat details did not create a new conversation version',
    conversationAfterDetails.updateTime?.toMillis() ?? 0,
    conversationVersionBeforeDetails,
  );

  // Current display data and request-time snapshots are deliberately
  // separate. A profile rename or listing rename updates what users see,
  // while the request-time values remain an immutable record of what the
  // parties agreed when the request was created.
  await db.collection('users').doc('student-1').update({
    name: 'Arjun Shah Updated',
  });
  await db.collection('rooms').doc('RM-NAMES').update({
    title: 'Sunset Studio Renamed',
  });

  const reopened = await invoke(
    openConversation,
    {
      otherUserId: 'owner-1',
      roomId: 'RM-NAMES',
      requestId,
    },
    'student-1',
  );
  check(
    'reopening the conversation keeps the captured listing context',
    reopened.roomTitle,
    'Sunset Studio Renamed',
  );

  const contextAfterReopen = await db
    .collection('conversations')
    .doc(conversationId)
    .collection('contexts')
    .doc(requestId)
    .get();
  check(
    'reopening the conversation does not replace the captured title',
    contextAfterReopen.get('roomTitle'),
    'Sunset Studio',
  );
  check(
    'reopening the conversation does not reset the capture time',
    contextAfterReopen.get('capturedAt')?.toMillis(),
    capturedContext.get('capturedAt')?.toMillis(),
  );

  const refreshedBooking = await invoke(
    getBookingInteractionDetails,
    { requestId },
    'owner-1',
  );
  check(
    'the booking shows the current participant name',
    refreshedBooking.studentName,
    'Arjun Shah Updated',
  );
  check(
    'the booking shows the current listing title',
    refreshedBooking.roomTitle,
    'Sunset Studio Renamed',
  );

  const refreshedRequest = await db
    .collection('joinRequests')
    .doc(requestId)
    .get();
  check(
    'the request stores the current participant name separately',
    refreshedRequest.get('studentName'),
    'Arjun Shah Updated',
  );
  check(
    'the request stores the current listing title separately',
    refreshedRequest.get('roomTitle'),
    'Sunset Studio Renamed',
  );
  check(
    'the student-name request-time snapshot remains immutable',
    refreshedRequest.get('studentNameAtRequest'),
    'Arjun Shah',
  );
  check(
    'the owner-name request-time snapshot remains immutable',
    refreshedRequest.get('ownerNameAtRequest'),
    'Meera Nair',
  );
  check(
    'the listing-title request-time snapshot remains immutable',
    refreshedRequest.get('roomTitleAtRequest'),
    'Sunset Studio',
  );

  const refreshedChat = await invoke(
    getConversationInteractionDetails,
    { conversationId, requestId },
    'student-1',
  );
  check(
    'the request-backed chat keeps its captured listing context',
    refreshedChat.roomTitle,
    'Sunset Studio',
  );
  check(
    'the request-backed chat resolves the current participant name',
    refreshedChat.peerName,
    'Meera Nair',
  );

  // Whitespace-only current values are not display values. The immutable
  // request-time snapshots must still be available as the final fallback.
  await db.collection('users').doc('student-1').update({ name: '   ' });
  await db.collection('users').doc('owner-1').update({ name: '   ' });
  await db.collection('rooms').doc('RM-NAMES').update({ title: '   ' });
  await db.collection('joinRequests').doc(requestId).update({
    studentName: '   ',
    ownerName: '   ',
    roomTitle: '   ',
  });
  const snapshotFallback = await invoke(
    getBookingInteractionDetails,
    { requestId },
    'owner-1',
  );
  check(
    'a whitespace-only current name falls back to the immutable snapshot',
    snapshotFallback.studentName,
    'Arjun Shah',
  );
  check(
    'a whitespace-only current title falls back to the immutable snapshot',
    snapshotFallback.roomTitle,
    'Sunset Studio',
  );

  // Chat metadata follows the same fallback order. A missing profile and
  // missing current conversation metadata must not hide the immutable
  // request-time name.
  await db.collection('conversations').doc(conversationId).update({
    participantNames: { 'owner-1': '', 'student-1': '' },
  });
  const chatSnapshotFallback = await invoke(
    getConversationInteractionDetails,
    { conversationId, requestId },
    'owner-1',
  );
  check(
    'a chat without current metadata falls back to the immutable participant snapshot',
    chatSnapshotFallback.peerName,
    'Arjun Shah',
  );
  const reopenedOwnerChat = await invoke(
    openConversation,
    {
      otherUserId: 'student-1',
      roomId: 'RM-NAMES',
      requestId,
    },
    'owner-1',
  );
  check(
    'reopening a chat stores the immutable participant snapshot when current metadata is missing',
    reopenedOwnerChat.peerName,
    'Arjun Shah',
  );
  const reopenedStudentChat = await invoke(
    openConversation,
    {
      otherUserId: 'owner-1',
      roomId: 'RM-NAMES',
      requestId,
    },
    'student-1',
  );
  check(
    'the opposite chat direction also stores the immutable participant snapshot',
    reopenedStudentChat.peerName,
    'Meera Nair',
  );
}

async function testInteractionMetadataChecksLiveRolesInTheTransaction() {
  section('interaction metadata checks the live participant role in its transaction');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await db.collection('users').doc('owner-1').update({ name: 'Meera Nair' });
  await db.collection('users').doc('student-1').update({ name: 'Arjun Shah' });
  await seedRoom('RM-LIVE-ROLE', 'owner-1', { title: 'Live Role Room' });
  await seedRequest('JRQ-LIVE-ROLE', {
    roomId: 'RM-LIVE-ROLE',
    studentName: 'Arjun Shah',
    ownerName: 'Meera Nair',
    roomTitle: 'Live Role Room',
  });

  const conversation = await invoke(
    openConversation,
    {
      otherUserId: 'owner-1',
      roomId: 'RM-LIVE-ROLE',
      requestId: 'JRQ-LIVE-ROLE',
    },
    'student-1',
  );
  check(
    'the live student can initially read the booking details',
    (
      await invoke(
        getBookingInteractionDetails,
        { requestId: 'JRQ-LIVE-ROLE' },
        'student-1',
      )
    ).studentName,
    'Arjun Shah',
  );
  check(
    'the live owner can initially read the booking details',
    (
      await invoke(
        getBookingInteractionDetails,
        { requestId: 'JRQ-LIVE-ROLE' },
        'owner-1',
      )
    ).ownerName,
    'Meera Nair',
  );

  await db.collection('users').doc('owner-1').update({ role: 'student' });
  await expectDenied(
    'a demoted owner cannot read owner-side booking details',
    () =>
      invoke(
        getBookingInteractionDetails,
        { requestId: 'JRQ-LIVE-ROLE' },
        'owner-1',
      ),
    'permission-denied',
  );
  await expectDenied(
    'a demoted owner cannot read owner-side conversation details',
    () =>
      invoke(
        getConversationInteractionDetails,
        { conversationId: conversation.conversationId, requestId: 'JRQ-LIVE-ROLE' },
        'owner-1',
      ),
    'permission-denied',
  );
  await expectDenied(
    'a demoted owner cannot open the owner-side conversation',
    () =>
      invoke(
        openConversation,
        {
          otherUserId: 'student-1',
          roomId: 'RM-LIVE-ROLE',
          requestId: 'JRQ-LIVE-ROLE',
        },
        'owner-1',
      ),
    'permission-denied',
  );

  await expectDenied(
    'a live student cannot read booking details after the owner is demoted',
    () =>
      invoke(
        getBookingInteractionDetails,
        { requestId: 'JRQ-LIVE-ROLE' },
        'student-1',
      ),
    'permission-denied',
  );
  await expectDenied(
    'a live student cannot read request-backed chat details after the owner is demoted',
    () =>
      invoke(
        getConversationInteractionDetails,
        { conversationId: conversation.conversationId, requestId: 'JRQ-LIVE-ROLE' },
        'student-1',
      ),
    'permission-denied',
  );
  await expectDenied(
    'a live student cannot read room-backed chat details after the owner is demoted',
    () =>
      invoke(
        getConversationInteractionDetails,
        {
          conversationId: conversation.conversationId,
          roomId: 'RM-LIVE-ROLE',
        },
        'student-1',
      ),
    'permission-denied',
  );

  await db.collection('users').doc('owner-1').update({ role: 'owner' });
  await db.collection('users').doc('student-1').update({ isActive: false });
  await expectDenied(
    'an inactive student cannot read student-side booking details',
    () =>
      invoke(
        getBookingInteractionDetails,
        { requestId: 'JRQ-LIVE-ROLE' },
        'student-1',
      ),
    'permission-denied',
  );
  await expectDenied(
    'an inactive student cannot read student-side conversation details',
    () =>
      invoke(
        getConversationInteractionDetails,
        { conversationId: conversation.conversationId, requestId: 'JRQ-LIVE-ROLE' },
        'student-1',
      ),
    'permission-denied',
  );
  await expectDenied(
    'an inactive student cannot read room-contact details',
    () =>
      invoke(
        getRoomContactDetails,
        { roomId: 'RM-LIVE-ROLE' },
        'student-1',
      ),
    'permission-denied',
  );
  await expectDenied(
    'an inactive student cannot open the room conversation',
    () =>
      invoke(
        openConversation,
        {
          otherUserId: 'owner-1',
          roomId: 'RM-LIVE-ROLE',
        },
        'student-1',
      ),
    'permission-denied',
  );

  const adminDetails = await invoke(
    getBookingInteractionDetails,
    { requestId: 'JRQ-LIVE-ROLE' },
    'admin-1',
  );
  check(
    'a live administrator can still review the booking details',
    adminDetails.studentName,
    'Arjun Shah',
  );
}

async function testMalformedRequestApprovalReturnsAPreconditionError() {
  section('a malformed booking request fails approval with a precondition error');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-MALFORMED-APPROVAL', 'owner-1');
  await seedRequest('JRQ-MALFORMED-APPROVAL', {
    roomId: 'RM-MALFORMED-APPROVAL',
    studentId: '',
  });

  await expectDenied(
    'a malformed request cannot be approved',
    () =>
      invoke(
        respondToJoinRequest,
        { requestId: 'JRQ-MALFORMED-APPROVAL', approve: true },
        'owner-1',
      ),
    'failed-precondition',
  );
  check(
    'the malformed request was not approved',
    (
      await db
        .collection('joinRequests')
        .doc('JRQ-MALFORMED-APPROVAL')
        .get()
    ).get('status'),
    'pending',
  );
}

async function testTerminalRequestCannotCreateConversation() {
  section('a terminal booking request cannot start a new conversation');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-TERMINAL-CHAT', 'owner-1', { title: 'Terminal Chat Room' });

  const conversationId = ['owner-1', 'student-1'].sort().join('_');
  const conversationRef = db.collection('conversations').doc(conversationId);
  const terminalStates = [
    ['rejected', 'a rejected request cannot start a conversation'],
    ['cancelled', 'a cancelled request cannot start a conversation'],
    ['unknownState', 'an unknown request state cannot start a conversation'],
  ];

  for (const [status, label] of terminalStates) {
    const requestId = `JRQ-TERMINAL-${status.toUpperCase()}`;
    await seedRequest(requestId, {
      roomId: 'RM-TERMINAL-CHAT',
      status,
    });
    await expectDenied(
      label,
      () =>
        invoke(
          openConversation,
          {
            otherUserId: 'student-1',
            roomId: 'RM-TERMINAL-CHAT',
            requestId,
          },
          'owner-1',
        ),
      'failed-precondition',
    );
  }

  check(
    'terminal requests did not create a conversation',
    (await conversationRef.get()).exists,
    false,
  );

  // An open request can establish the conversation normally.
  await seedRequest('JRQ-TERMINAL-OPEN', {
    roomId: 'RM-TERMINAL-CHAT',
    status: 'pending',
  });
  const opened = await invoke(
    openConversation,
    {
      otherUserId: 'student-1',
      roomId: 'RM-TERMINAL-CHAT',
      requestId: 'JRQ-TERMINAL-OPEN',
    },
    'owner-1',
  );
  check('an open request created the conversation', opened.conversationId, conversationId);

  // Once a conversation exists, a later terminal state does not erase the
  // history. The parties can still reopen it while the block state permits.
  await db
    .collection('joinRequests')
    .doc('JRQ-TERMINAL-OPEN')
    .update({ status: 'cancelled' });
  const reopened = await invoke(
    openConversation,
    {
      otherUserId: 'student-1',
      roomId: 'RM-TERMINAL-CHAT',
      requestId: 'JRQ-TERMINAL-OPEN',
    },
    'owner-1',
  );
  check(
    'an existing conversation remains available after the request closes',
    reopened.conversationId,
    conversationId,
  );
  check(
    'the existing conversation was not removed when the request closed',
    (await conversationRef.get()).exists,
    true,
  );
}

async function testDirectionalBlocksProtectBothRoles() {
  section('directional blocks protect both the student and the owner');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedUser('outsider-1', 'student');
  await db.collection('users').doc('owner-1').update({ name: 'Meera Nair' });
  await db.collection('users').doc('student-1').update({ name: 'Arjun Shah' });
  await seedRoom('RM-BLOCK', 'owner-1', { title: 'Garden Flat' });
  await seedRequest('JRQ-BLOCK', {
    roomId: 'RM-BLOCK',
    studentName: 'Arjun Shah',
    ownerName: 'Meera Nair',
    roomTitle: 'Garden Flat',
  });

  const conversationId = ['owner-1', 'student-1'].sort().join('_');
  await invoke(
    openConversation,
    {
      otherUserId: 'owner-1',
      roomId: 'RM-BLOCK',
      requestId: 'JRQ-BLOCK',
    },
    'student-1',
  );

  const blocked = await invoke(
    blockUser,
    {
      otherUserId: 'owner-1',
      requestId: 'JRQ-BLOCK',
    },
    'student-1',
  );
  check('the student block succeeded', blocked.blocked, true);
  check('the student reports its own block', blocked.blockedByMe, true);
  check('the student does not report a peer block', blocked.blockedMe, false);
  check('the block stops the student from sending', blocked.canSend, false);
  check(
    'the directional student-to-owner block was stored',
    (
      await db
        .collection('userBlocks')
        .doc('student-1')
        .collection('blockedUsers')
        .doc('owner-1')
        .get()
    ).exists,
    true,
  );

  const studentView = await invoke(
    getBookingInteractionDetails,
    { requestId: 'JRQ-BLOCK' },
    'student-1',
  );
  check('the student sees the own block flag', studentView.blockedByMe, true);
  check('the student sees no peer block flag', studentView.blockedMe, false);
  check('the student booking is effectively blocked', studentView.canSend, false);

  const ownerView = await invoke(
    getBookingInteractionDetails,
    { requestId: 'JRQ-BLOCK' },
    'owner-1',
  );
  check('the owner sees no own block flag', ownerView.blockedByMe, false);
  check('the owner sees the incoming block flag', ownerView.blockedMe, true);
  check('the owner booking is effectively blocked', ownerView.canSend, false);

  const ownerChat = await invoke(
    getConversationInteractionDetails,
    { conversationId, requestId: 'JRQ-BLOCK' },
    'owner-1',
  );
  check('the owner keeps access to the existing chat history', ownerChat.peerName, 'Arjun Shah');
  check('the owner chat is read-only while blocked', ownerChat.canSend, false);

  const reopened = await invoke(
    openConversation,
    {
      otherUserId: 'owner-1',
      roomId: 'RM-BLOCK',
      requestId: 'JRQ-BLOCK',
    },
    'student-1',
  );
  check('a blocked student can still open the existing conversation', reopened.conversationId, conversationId);
  check('the reopened blocked conversation is read-only', reopened.canSend, false);

  await expectDenied(
    'an outsider cannot block a participant without a relationship',
    () =>
      invoke(
        blockUser,
        {
          otherUserId: 'owner-1',
          requestId: 'JRQ-BLOCK',
        },
        'outsider-1',
      ),
    'failed-precondition',
  );
  await expectDenied(
    'a caller cannot block an arbitrary account without context',
    () =>
      invoke(
        blockUser,
        { otherUserId: 'owner-1' },
        'student-1',
      ),
    'invalid-argument',
  );

  const unblocked = await invoke(
    unblockUser,
    { otherUserId: 'owner-1' },
    'student-1',
  );
  check('the student unblock succeeded', unblocked.blocked, false);
  check('the student no longer reports an own block', unblocked.blockedByMe, false);
  check('the student can send after unblocking', unblocked.canSend, true);
  check(
    'the directional block document was removed',
    (
      await db
        .collection('userBlocks')
        .doc('student-1')
        .collection('blockedUsers')
        .doc('owner-1')
        .get()
    ).exists,
    false,
  );

  const ownerAfterUnblock = await invoke(
    getBookingInteractionDetails,
    { requestId: 'JRQ-BLOCK' },
    'owner-1',
  );
  check('the owner can continue after the student unblocks', ownerAfterUnblock.canSend, true);

  const conversationOnlyBlock = await invoke(
    blockUser,
    { otherUserId: 'owner-1', conversationId },
    'student-1',
  );
  check(
    'a verified conversation alone authorizes the block',
    conversationOnlyBlock.blockedByMe,
    true,
  );
  await invoke(unblockUser, { otherUserId: 'owner-1' }, 'student-1');

  const ownerBlocked = await invoke(
    blockUser,
    {
      otherUserId: 'student-1',
      requestId: 'JRQ-BLOCK',
    },
    'owner-1',
  );
  check('the owner can block the student', ownerBlocked.blockedByMe, true);
  check('the owner block is immediately effective', ownerBlocked.canSend, false);
  check(
    'the reverse directional block was stored',
    (
      await db
        .collection('userBlocks')
        .doc('owner-1')
        .collection('blockedUsers')
        .doc('student-1')
        .get()
    ).exists,
    true,
  );
  await expectDenied(
    'a caller cannot use unblock as an oracle for a peer-only block',
    () => invoke(unblockUser, { otherUserId: 'owner-1' }, 'student-1'),
    'failed-precondition',
  );
  check(
    'the peer-only block was not removed by the unrelated caller',
    (
      await db
        .collection('userBlocks')
        .doc('owner-1')
        .collection('blockedUsers')
        .doc('student-1')
        .get()
    ).exists,
    true,
  );

  const ownerUnblocked = await invoke(
    unblockUser,
    { otherUserId: 'student-1' },
    'owner-1',
  );
  check('the owner can unblock the student', ownerUnblocked.blockedByMe, false);
  check('the owner can send after unblocking', ownerUnblocked.canSend, true);
}

async function testBlockBeforeConversationAndDeletionFence() {
  section('a request authorizes a block before a conversation exists and a deleting target cannot be blocked');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-EARLY-BLOCK', 'owner-1');
  await seedRequest('JRQ-EARLY-BLOCK', { roomId: 'RM-EARLY-BLOCK' });

  const blocked = await invoke(
    blockUser,
    { otherUserId: 'owner-1', requestId: 'JRQ-EARLY-BLOCK' },
    'student-1',
  );
  check('the request authorizes a block before any chat exists', blocked.blockedByMe, true);
  const earlyConversationId = ['owner-1', 'student-1'].sort().join('_');
  await expectDenied(
    'a blocked pair cannot create the first conversation afterwards',
    () =>
      invoke(
        openConversation,
        {
          otherUserId: 'owner-1',
          roomId: 'RM-EARLY-BLOCK',
          requestId: 'JRQ-EARLY-BLOCK',
        },
        'student-1',
      ),
    'failed-precondition',
  );
  check(
    'the blocked first conversation was not created',
    (await db.collection('conversations').doc(earlyConversationId).get()).exists,
    false,
  );

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-DELETING-TARGET', 'owner-1');
  await seedRequest('JRQ-DELETING-TARGET', {
    roomId: 'RM-DELETING-TARGET',
  });
  await db.collection('users').doc('student-1').update({
    isActive: false,
    deletionState: 'deleting',
  });
  await expectDenied(
    'a peer cannot create a new incoming block for a deleting account',
    () =>
      invoke(
        blockUser,
        { otherUserId: 'student-1', requestId: 'JRQ-DELETING-TARGET' },
        'owner-1',
      ),
    'failed-precondition',
  );
  check(
    'the deleting account did not receive a new incoming block',
    (
      await db
        .collection('userBlocks')
        .doc('owner-1')
        .collection('blockedUsers')
        .doc('student-1')
        .get()
    ).exists,
    false,
  );
}

async function testBlocksStopBookingProgressionButAllowClosure() {
  section('blocks stop booking progression while protective closure stays available');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-PROGRESS', 'owner-1');
  await seedRoom('RM-SECOND', 'owner-1');
  await seedRequest('JRQ-APPROVE', {
    roomId: 'RM-PROGRESS',
    status: 'pending',
  });
  await seedRequest('JRQ-CONFIRM', {
    roomId: 'RM-PROGRESS',
    status: 'ownerConfirmed',
  });
  await seedRequest('JRQ-CANCEL', {
    roomId: 'RM-PROGRESS',
    status: 'ownerConfirmed',
  });
  await seedRequest('JRQ-PAYMENT', {
    roomId: 'RM-PROGRESS',
    status: 'studentConfirmed',
  });

  await invoke(
    blockUser,
    { otherUserId: 'owner-1', requestId: 'JRQ-APPROVE' },
    'student-1',
  );

  await expectDenied(
    'a blocked pair cannot create a new booking request',
    () => invoke(createJoinRequest, { roomId: 'RM-SECOND' }, 'student-1'),
    'failed-precondition',
  );
  check(
    'the refused request was not created',
    (
      await db
        .collection('joinRequests')
        .where('roomId', '==', 'RM-SECOND')
        .where('studentId', '==', 'student-1')
        .get()
    ).empty,
    true,
  );

  await expectDenied(
    'a blocked owner cannot approve a booking',
    () =>
      invoke(
        respondToJoinRequest,
        { requestId: 'JRQ-APPROVE', approve: true },
        'owner-1',
      ),
    'failed-precondition',
  );
  check(
    'the blocked approval did not advance the request',
    (await db.collection('joinRequests').doc('JRQ-APPROVE').get()).get('status'),
    'pending',
  );

  await invoke(
    respondToJoinRequest,
    { requestId: 'JRQ-APPROVE', approve: false, reason: 'Not suitable' },
    'owner-1',
  );
  check(
    'a blocked owner can still decline the request',
    (await db.collection('joinRequests').doc('JRQ-APPROVE').get()).get('status'),
    'rejected',
  );

  await expectDenied(
    'a blocked student cannot confirm the booking',
    () =>
      invoke(
        confirmJoinAsStudent,
        { requestId: 'JRQ-CONFIRM' },
        'student-1',
      ),
    'failed-precondition',
  );
  check(
    'the blocked confirmation did not advance the request',
    (await db.collection('joinRequests').doc('JRQ-CONFIRM').get()).get('status'),
    'ownerConfirmed',
  );

  await invoke(
    cancelJoinRequest,
    { requestId: 'JRQ-CANCEL', reason: 'Changed my mind' },
    'student-1',
  );
  check(
    'a blocked student can still cancel the request',
    (await db.collection('joinRequests').doc('JRQ-CANCEL').get()).get('status'),
    'cancelled',
  );

  await expectDenied(
    'a blocked party cannot create a payment intent',
    () =>
      invoke(
        createUpiPayment,
        { joinRequestId: 'JRQ-PAYMENT' },
        'owner-1',
      ),
    'failed-precondition',
  );
  await expectDenied(
    'a blocked party cannot submit a payment',
    () =>
      invoke(
        submitPayment,
        {
          requestId: 'JRQ-PAYMENT',
          reference: 'UPI-BLOCKED',
          method: 'upi',
        },
        'owner-1',
      ),
    'failed-precondition',
  );
  check(
    'the blocked payment was not stored',
    (await db.collection('payments').doc('JRQ-PAYMENT').get()).exists,
    false,
  );
}

async function testBlockedPaymentCanStillBeRejectedByTheAdmin() {
  section('an admin can still reject a submitted payment while the pair is blocked');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('owner-1', 'owner');
  await seedUser('student-1', 'student');
  await seedRoom('RM-PAYMENT-BLOCK', 'owner-1');
  await seedRequest('JRQ-REJECT-BLOCKED', {
    roomId: 'RM-PAYMENT-BLOCK',
    status: 'studentConfirmed',
    monthlyRentAtJoin: 5000,
    commissionPercentageAtJoin: 30,
    platformFeePayer: 'owner',
  });
  await db.collection('payments').doc('JRQ-REJECT-BLOCKED').set({
    requestId: 'JRQ-REJECT-BLOCKED',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'RM-PAYMENT-BLOCK',
    amount: 1500,
    feePercentage: 30,
    reference: 'UPI-REJECT-BLOCKED',
    method: 'upi',
    payer: 'owner',
    feeWaived: false,
    status: 'submitted',
  });
  await invoke(
    blockUser,
    { otherUserId: 'owner-1', requestId: 'JRQ-REJECT-BLOCKED' },
    'student-1',
  );

  await invoke(
    verifyPayment,
    {
      requestId: 'JRQ-REJECT-BLOCKED',
      approve: false,
      note: 'The money did not arrive',
    },
    'admin-1',
  );
  check(
    'the admin rejected the blocked payment',
    (await db.collection('payments').doc('JRQ-REJECT-BLOCKED').get()).get('status'),
    'rejected',
  );
  check(
    'the rejected blocked booking was not activated',
    (await db.collection('joinRequests').doc('JRQ-REJECT-BLOCKED').get()).get('status'),
    'studentConfirmed',
  );

  await seedRequest('JRQ-APPROVE-BLOCKED', {
    roomId: 'RM-PAYMENT-BLOCK',
    status: 'studentConfirmed',
    monthlyRentAtJoin: 5000,
    commissionPercentageAtJoin: 30,
    platformFeePayer: 'owner',
  });
  await db.collection('payments').doc('JRQ-APPROVE-BLOCKED').set({
    requestId: 'JRQ-APPROVE-BLOCKED',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'RM-PAYMENT-BLOCK',
    amount: 1500,
    feePercentage: 30,
    reference: 'UPI-APPROVE-BLOCKED',
    method: 'upi',
    payer: 'owner',
    feeWaived: false,
    status: 'submitted',
  });
  await expectDenied(
    'an admin cannot activate a submitted payment while the pair is blocked',
    () =>
      invoke(
        verifyPayment,
        { requestId: 'JRQ-APPROVE-BLOCKED', approve: true },
        'admin-1',
      ),
    'failed-precondition',
  );
  check(
    'the blocked submitted payment was not activated',
    (await db.collection('joinRequests').doc('JRQ-APPROVE-BLOCKED').get()).get('status'),
    'studentConfirmed',
  );
  check(
    'the blocked submitted payment is still awaiting a decision',
    (await db.collection('payments').doc('JRQ-APPROVE-BLOCKED').get()).get('status'),
    'submitted',
  );
}

async function main() {
  await testInteractionMetadataUsesRealParticipantNames();
  await testInteractionMetadataChecksLiveRolesInTheTransaction();
  await testMalformedRequestApprovalReturnsAPreconditionError();
  await testTerminalRequestCannotCreateConversation();
  await testDirectionalBlocksProtectBothRoles();
  await testBlockBeforeConversationAndDeletionFence();
  await testBlocksStopBookingProgressionButAllowClosure();
  await testBlockedPaymentCanStillBeRejectedByTheAdmin();
  await testOwnerApprovalAndCancellationUseLiveRole();
  await testRoleChangeCancelsOwnerSideRequests();
  await testWaivedPaymentStillRequiresAParty();
  await testRejectedPaymentCannotResurrectTerminalRequest();
  await testMismatchedPaymentCanBeRejectedWithoutChangingRequest();
  await testAlreadyActiveApprovalDoesNotRequireStudentRole();
  await testPaymentSubmissionUsesTheFreshRequestSnapshot();
  await testMalformedPaymentCannotBeVerified();
  await testAdminCannotRejectASubmittedPayment();
  await testPaymentPathsRevalidateRoomAvailability();
  await testApprovalAndConfirmationRevalidateTheRoom();
  await testAccountDeletionFenceBlocksBookingTransitions();
  await testPaymentVerificationChecksTheAdminInsideTheTransaction();
  await testPaymentVerificationRejectsAnInvalidRequestRent();
  await testVisitDetailsUseOneFreshTransactionSnapshot();
  await testReviewAndNotificationAuthorizationsAreTransactional();
  await testClientNotificationAuthorizationsAreTransactional();
  await testAdminReviewChecksTheAdminInsideTheTransaction();
  await testPrivateLocationMigrationChecksTheAdminInsideTheTransaction();
  await testLocationFinalizationChecksTheAdminInsideTheTransaction();
  await testStudentDeletionFenceIsCheckedInsideTheTransaction();
  await testRoleChangeChecksTheAdminInsideTheTransaction();
  await testStaleRoleCleanupCannotClearANewerMarker();
  await testStaleRoleCleanupCannotCancelARequestUnderANewerRole();
  await testAdminCallablesCheckTheLiveAdminInsideTheTransaction();
  await testAdminCallablesRefuseSelfTargeting();
  await testUnbanRefusesAnAccountWhichIsBeingDeleted();
  await testUnbanKeepsTheProfileInactiveWhenAuthFails();
  await testCancelDeletionRestoresThePreviousActivationState();
  await testAccountDeletionWorkerOnlyClaimsRealPendingJobs();
  await testWrongTypedScheduledJobCannotDisableAuth();
  await testScheduledAuthDisableCannotUndoACancellation();
  await testScheduledWorkerAuthDisableCannotUndoACancellation();
  await testAccountDeletionCompletionRequiresTheCurrentWorkerLease();
  await testZeroDayDeletionIsScheduledImmediately();
  await testEnqueueRefusesAnActiveRestore();
  await testCancelledRestoreDoesNotDeleteARependedJob();
  await testMaintenanceTaskChecksTheAdminInsideTheBatch();
  await testRoleChangeCleanupIsRetryable();
  await testRoleClaimPublicationIsDurableAndRetryable();
  await testRegisterUserRoleCanRetryItsClaimPublication();
  await testRoleClaimWorkerIgnoresNonPublicationJobs();
  await testInactiveAccountCannotRepublishARoleClaim();
  await testExpiredOtpChallengeCannotClaimARole();
  await testUnboundedOtpChallengeCannotClaimARole();
  await testBanCommitsFirestoreStateBeforeAuth();
  await testConversationCreationIsServerVerified();
  await testConversationCleanupMarksBeforeDeletingMessages();
  await testAuthDeleteCleanupIsDurableAndRetryable();
  await testAccountDeletionDoesNotEraseLiveBookings();
  await testAdminDeletionDistinguishesBlockedAndTransientFailures();
  await testScheduledCancellationAndClaimRace();
  await testScheduledDeletionScanLeavesFutureAccountsAlone();
  await testAuthLifecycleTransitionsRemainRetryable();
  await testRoomPhotoCleanupFailureIsDurableAndRetryable();
  await testRoomPhotoCleanupQuarantinesPoisonJobs();
  await testInterruptedRoomDeletionIsResumed();
  await testMismatchedPrefixCleanupCannotDeleteALaterListing();
  await testReviewCleanupKeepsADifferentListingGeneration();
  await testReviewCleanupKeepsAReviewUpdatedAfterTheCutoff();
  await testReferencedPathCleanupAlwaysLocksTheRoom();
  await testAdminCanTakeOverAStrandedListingDeletion();
  await testPrivateLocationWriteIsOwnerOnlyAndAtomic();
  await testVisitDetailsUseThePrivateLocation();
  await testPrivateLocationMigrationIsIdempotentAndGated();
  await testPrivateLocationMigrationValidatesAndRepairsSafely();
  await testFinalizationLatchPreventsExactPublicRewrites();
  await testPrivateLocationMigrationPaginatesDeterministically();
  await testRoomDeletionRemovesThePrivateLocation();
  await testRoomDeletionStopsWhenTheCallerLosesAuthority();
  await testBanDuringDeletionGraceCannotBeUndone();
  await testForcedLogoutDuringDeletionGraceCannotBeUndone();
  await testBanDuringRestoreKeepsADurableDisableRetry();
  await testUnbanRepairsADeletionScheduledDuringTheAuthEnable();
  await testConcurrentBanCannotBeUndoneByAnInFlightUnban();
  await testLegacyCancellationWithoutPreviousStateStaysInactive();
  await testAccountDeletionCancelsAndNotifiesOpenRequests();
  await testDelayedNotificationCannotCrossTheDeletionFence();
  await testChatNotificationIsBoundToOneSentMessage();
  await testSubmittedPaymentCannotBeReplaced();
  await testListingDeletionRemovesOrphanReviews();
  await testPhotoCleanupKeepsAReAddedImage();
  await testListingDeletionPagesRequestsAndKeepsTheirIds();
  await testStudentCancellationStopsAfterJoining();
  await testStudentCanRequestDifferentRooms();
  await testOwnerAvailabilityReleaseEndsOnlyThisRoomsBookings();
  await testAvailabilityReleaseRejectsUnauthorizedCallers();
  await testAdminAvailabilityReleaseEndsBookings();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('failed checks:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
