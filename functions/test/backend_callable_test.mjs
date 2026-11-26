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
// The suite supplies its own live Auth records. Point the SDK at the emulator
// protocol so it does not look for application-default credentials while it
// initializes the shared Auth service.
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.ROOM_PHOTO_BUCKET =
  process.env.ROOM_PHOTO_BUCKET || 'demo.appspot.com';

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
  publishRoomListing,
  setRoomListingAvailability,
  adminSetRoomListingStatus,
} = require(path.join(ROOT, 'lib', 'rooms.js'));
const {
  registerUserRole,
  completeRegistration,
} = require(path.join(ROOT, 'lib', 'otp.js'));
const {
  syncAuthProfile,
  linkVerifiedEmail,
  processRegistrationRollbackOperations,
  rollbackIncompleteRegistration,
} = require(path.join(ROOT, 'lib', 'authProfile.js'));
const {
  ADMIN_SUPPORT_CONVERSATION_OPERATIONS,
  ADMIN_SUPPORT_REPLY_NOTIFICATION_OPERATIONS,
  adminConversationId,
  adminMessageNotificationId,
  adminSupportIdentityFor,
  listAdminSupportConversations,
  markAdminSupportConversationRead,
  sendAdminMessage,
  sendAdminSupportReply,
  supportReplyNotificationId,
} = require(path.join(ROOT, 'lib', 'adminMessaging.js'));
const {
  getRoomReviews,
  deleteAnyRoomReview,
  reviewNotificationId,
} = require(path.join(ROOT, 'lib', 'reviews.js'));
const {
  processRoleClaimPublicationJobs,
} = require(path.join(ROOT, 'lib', 'roleClaims.js'));
const {
  ensureUserProfile,
} = require(path.join(ROOT, 'lib', 'profileBootstrap.js'));
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
  deleteAttributedNotificationsForUser,
  deleteUserEverywhere,
} = require(path.join(ROOT, 'lib', 'admin.js'));

// The compiled modules initialize the default Admin app when they are
// loaded. Open Firestore and Auth only after that initialization.
const db = firestore.getFirestore();
const auth = authSdk.getAuth();

// Registration and profile synchronisation read the live Auth user record.
// The Firestore-only suite supplies a deterministic live identity instead of
// requiring the Auth emulator. Tests which exercise a specific Auth state
// override this getter and restore it afterwards.
auth.getUser = async (uid) => ({
  uid,
  email: `${uid}@example.test`,
  emailVerified: false,
  // The callable suite models a live linked phone by default. Tests which
  // exercise an unlinked provider override this getter explicitly.
  phoneNumber: '+919876500000',
  // The signed proof that the account completed Firebase's phone challenge.
  // A number without this server-issued fact is not verified, even when the
  // live Auth record carries it.
  customClaims: { stayServeVerifiedPhone: '+919876500000' },
  providerData: [
    { providerId: 'password' },
    { providerId: 'phone', phoneNumber: '+919876500000' },
  ],
});

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

async function invoke(callable, data, uid, tokenOverrides = {}) {
  return callable.run(data, {
    auth: uid
      ? {
          uid,
          token: {
            email: `${uid}@example.test`,
            email_verified: true,
            ...tokenOverrides,
          },
        }
      : undefined,
    rawRequest: {},
    instanceIdToken: null,
  });
}

function emulatorJwt(uid, claims = {}) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    sub: uid,
    user_id: uid,
    role: 'student',
    ...claims,
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

async function readDocumentAsClient({
  collection,
  documentId,
  uid,
  claims = {},
}) {
  const host = `http://127.0.0.1:${PORT}/v1/projects/${PROJECT}/databases/(default)/documents`;
  const response = await fetch(
    `${host}/${collection}/${documentId}`,
    {
      headers: {
        Authorization: `Bearer ${emulatorJwt(uid, claims)}`,
      },
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
    return 'allowed';
  } catch (error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    const ok = code.includes(expectedCode) || message.includes(expectedCode);
    const outcome = ok
      ? `rejected (${code || expectedCode})`
      : `${code}: ${message}`;
    check(label, outcome, `rejected (${expectedCode})`);
    return outcome;
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
    emailVerified: true,
    phone: `+9198765${String(uid).replace(/\D/g, '').padStart(5, '0').slice(-5)}`,
    phoneVerified: true,
    authProviders: [role === 'admin' ? 'admin' : 'password'],
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

  // The opaque administrator identity is stored in a nested server-only
  // profile. A collection-group sweep removes both it and ordinary profiles.
  const users = await db.collectionGroup('users').get();
  await Promise.all(users.docs.map((doc) => doc.ref.delete()));

  const collections = [
    'users',
    'joinRequests',
    'payments',
    'commissionInvoices',
    'joinRequestLocks',
    'notifications',
    'notificationAttributions',
    'adminMessageNotificationOperations',
    'adminSupportConversationOperations',
    'adminSupportReplyNotificationOperations',
    'rooms',
    'roomPrivate',
    'roomReviews',
    'reviewDeletionAudit',
    'reviewDeletionState',
    'emailLinkOperations',
    'registrationRollbackOperations',
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
  await db.collection('notifications').doc('legacy-message-notification').set({
    userId: 'owner-1',
    title: 'New message',
    body: 'Hello',
    type: 'newMessage',
    data: { conversationId: 'conversation-1', messageId: 'message-1' },
    read: false,
  });
  const attributedNotificationId = adminMessageNotificationId('message-1');
  await db
    .collection('notificationAttributions')
    .doc(attributedNotificationId)
    .set({
      notificationId: attributedNotificationId,
      userId: 'owner-1',
      sourceType: 'chatMessage',
      sourceAuthorUid: 'student-1',
      sourceRecipientUid: 'owner-1',
      sourceId: 'message-1',
      sourceMessageId: 'message-1',
    });
  await db
    .collection('adminMessageNotificationOperations')
    .doc('message-1')
    .set({
      operationId: 'message-1',
      notificationId: attributedNotificationId,
      messageId: 'message-1',
      conversationId: 'conversation-1',
      sourceAuthorUid: 'student-1',
      sourceRecipientUid: 'owner-1',
      recipientId: 'owner-1',
      sourceType: 'adminMessage',
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
  check(
    'the legacy notification copy of the deleted message was removed',
    (await db
      .collection('notifications')
      .doc('legacy-message-notification')
      .get()).exists,
    false,
  );
  check(
    'the server-only attribution of the deleted message was removed',
    (await db
      .collection('notificationAttributions')
      .doc(attributedNotificationId)
      .get()).exists,
    false,
  );
  check(
    'the server-only delivery operation of the deleted message was removed',
    (await db
      .collection('adminMessageNotificationOperations')
      .doc('message-1')
      .get()).exists,
    false,
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
  const emailLinkOperationRef = db
    .collection('emailLinkOperations')
    .doc('email-link-target-1');
  await emailLinkOperationRef.set({
    operationId: emailLinkOperationRef.id,
    uid: 'target-1',
    email: 'target-1@example.test',
    status: 'complete',
  });
  const peerEmailLinkOperationRef = db
    .collection('emailLinkOperations')
    .doc('email-link-peer-1');
  await peerEmailLinkOperationRef.set({
    operationId: peerEmailLinkOperationRef.id,
    uid: 'peer-1',
    email: 'peer-1@example.test',
    status: 'complete',
  });
  const registrationRollbackRef = db
    .collection('registrationRollbackOperations')
    .doc('target-1');
  await registrationRollbackRef.set({
    operationId: 'target-1',
    uid: 'target-1',
    status: 'rollbackRequested',
    attempts: 0,
  });
  const adminModerationAuditRef = db
    .collection('reviewDeletionAudit')
    .doc('admin-moderation-target-1');
  await adminModerationAuditRef.set({
    reviewId: 'review-by-target-1',
    studentId: 'peer-1',
    ownerId: 'owner-1',
    deletedByAdminId: 'target-1',
  });
  const peerModerationAuditRef = db
    .collection('reviewDeletionAudit')
    .doc('admin-moderation-peer-1');
  await peerModerationAuditRef.set({
    reviewId: 'review-by-peer-1',
    studentId: 'student-1',
    ownerId: 'owner-1',
    deletedByAdminId: 'peer-1',
  });
  const adminModerationStateRef = db
    .collection('reviewDeletionState')
    .doc('review-by-target-1');
  await adminModerationStateRef.set({
    reviewId: 'review-by-target-1',
    studentId: 'peer-1',
    ownerId: 'owner-1',
    deletedByAdminId: 'target-1',
  });
  const peerModerationStateRef = db
    .collection('reviewDeletionState')
    .doc('review-by-peer-1');
  await peerModerationStateRef.set({
    reviewId: 'review-by-peer-1',
    studentId: 'student-1',
    ownerId: 'owner-1',
    deletedByAdminId: 'peer-1',
  });

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
    check(
      'the failed cleanup kept the pending registration rollback marker',
      (await registrationRollbackRef.get()).get('status'),
      'rollbackRequested',
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
      'the verified-email linking operation was removed with the account',
      (await emailLinkOperationRef.get()).exists,
      false,
    );
    check(
      'another account verified-email linking operation was preserved',
      (await peerEmailLinkOperationRef.get()).exists,
      true,
    );
    check(
      'the completed account cleanup removed the registration rollback marker',
      (await registrationRollbackRef.get()).exists,
      false,
    );
    check(
      'the deleted administrator was removed from moderation history',
      (await adminModerationAuditRef.get()).exists,
      false,
    );
    check(
      'another administrator was preserved in moderation history',
      (await peerModerationAuditRef.get()).exists,
      true,
    );
    check(
      'the deleted administrator was removed from the moderation state',
      (await adminModerationStateRef.get()).exists,
      false,
    );
    check(
      'another administrator was preserved in the moderation state',
      (await peerModerationStateRef.get()).exists,
      true,
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

async function testAccountCleanupRemovesReviewNotificationDependents() {
  section('account cleanup removes review notification dependents first');

  await reset();
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  const reviewId = 'REV-ACCOUNT-CLEANUP-student-1';
  const reviewInstanceId = 'review-account-cleanup-lifecycle';
  const notificationId = reviewNotificationId(
    reviewId,
    reviewInstanceId,
    'owner-1',
  );
  await db.collection('roomReviews').doc(reviewId).set({
    reviewId,
    reviewInstanceId,
    roomId: 'RM-ACCOUNT-CLEANUP',
    studentId: 'student-1',
    ownerId: 'owner-1',
    rating: 4,
    comment: 'Private review text',
  });
  await db.collection('notifications').doc(notificationId).set({
    userId: 'owner-1',
    title: 'New review',
    body: 'A student rated your room 4/5',
    type: 'review',
    data: { roomId: 'RM-ACCOUNT-CLEANUP' },
    read: false,
  });
  await db.collection('notifications').doc('legacy-account-review').set({
    userId: 'owner-1',
    title: 'New review',
    body: 'Private review text',
    type: 'review',
    data: { roomId: 'RM-ACCOUNT-CLEANUP', reviewId },
    read: false,
  });
  await db.collection('notificationAttributions').doc(notificationId).set({
    notificationId,
    userId: 'owner-1',
    sourceType: 'roomReview',
    sourceAuthorUid: 'student-1',
    sourceRecipientUid: 'owner-1',
    sourceId: reviewInstanceId,
    sourceReviewId: reviewId,
  });

  // The verified-phone proof holds the exact phone number of the account. It
  // is personal data and must not survive the deletion.
  await db.collection('phoneVerificationProofs').doc('student-1').set({
    uid: 'student-1',
    phone: '+919999000001',
    provider: 'phone',
  });

  // A support reply of the deleted account towards the administrator. Its
  // delivery operation names the deleted uid on both sides of the channel.
  const supportReplyMessageId = 'MSG-ACCOUNT-CLEANUP-support';
  const supportReplyCopyId = supportReplyNotificationId(
    'ADMIN-ACCOUNT-CLEANUP',
    supportReplyMessageId,
  );
  await db
    .collection('adminSupportReplyNotificationOperations')
    .doc(supportReplyMessageId)
    .set({
      operationId: supportReplyMessageId,
      notificationId: supportReplyCopyId,
      messageId: supportReplyMessageId,
      conversationId: 'ADMIN-ACCOUNT-CLEANUP',
      recipientId: 'admin-1',
      sourceAuthorUid: 'student-1',
      sourceRecipientUid: 'admin-1',
      sourceType: 'adminSupportReply',
    });
  await db.collection('notifications').doc(supportReplyCopyId).set({
    userId: 'admin-1',
    title: 'StayServe Support',
    body: 'You have a new support reply.',
    type: 'newMessage',
    data: { conversationId: 'ADMIN-ACCOUNT-CLEANUP' },
    read: false,
  });

  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  const originalDeleteUser = auth.deleteUser;
  const originalGetStorage = storageSdk.getStorage;
  auth.updateUser = async () => undefined;
  auth.revokeRefreshTokens = async () => undefined;
  auth.deleteUser = async () => undefined;
  storageSdk.getStorage = () => ({
    bucket: () => ({ getFiles: async () => [[]] }),
  });

  try {
    await deleteUserEverywhere('student-1');
    check(
      'the account cleanup removed the review source',
      (await db.collection('roomReviews').doc(reviewId).get()).exists,
      false,
    );
    check(
      'the account cleanup removed the deterministic review notification',
      (await db.collection('notifications').doc(notificationId).get()).exists,
      false,
    );
    check(
      'the account cleanup removed the legacy review notification',
      (await db.collection('notifications').doc('legacy-account-review').get()).exists,
      false,
    );
    check(
      'the account cleanup removed the server-only review attribution',
      (await db
        .collection('notificationAttributions')
        .doc(notificationId)
        .get()).exists,
      false,
    );
    check(
      'the account cleanup removed the phone-verification proof',
      (await db
        .collection('phoneVerificationProofs')
        .doc('student-1')
        .get()).exists,
      false,
    );
    check(
      'the account cleanup removed the support-reply delivery operation',
      (await db
        .collection('adminSupportReplyNotificationOperations')
        .doc(supportReplyMessageId)
        .get()).exists,
      false,
    );
    check(
      'the account cleanup removed the support-reply notification',
      (await db
        .collection('notifications')
        .doc(supportReplyCopyId)
        .get()).exists,
      false,
    );

    // Every cleanup step is idempotent, so an interrupted job can safely
    // repeat the whole operation.
    await deleteUserEverywhere('student-1');
    check(
      'the repeated account cleanup remains successful',
      (await db.collection('roomReviews').doc(reviewId).get()).exists,
      false,
    );
  } finally {
    auth.updateUser = originalUpdateUser;
    auth.revokeRefreshTokens = originalRevoke;
    auth.deleteUser = originalDeleteUser;
    storageSdk.getStorage = originalGetStorage;
  }
}

async function testAccountDeletionPreservesPendingRegistrationRollback() {
  section('account deletion preserves a pending rollback until Auth is removed');

  await reset();
  await seedUser('admin-1', 'admin');
  await db.collection('users').doc('incomplete-rollback-user').set({
    uid: 'incomplete-rollback-user',
    role: 'student',
    roleClaimed: false,
    registrationCompleted: false,
    isActive: true,
    phoneVerified: false,
  });
  const rollbackRef = db
    .collection('registrationRollbackOperations')
    .doc('incomplete-rollback-user');
  await rollbackRef.set({
    operationId: 'incomplete-rollback-user',
    uid: 'incomplete-rollback-user',
    status: 'rollbackRequested',
    attempts: 0,
  });

  const originalUpdateUser = auth.updateUser;
  const originalRevoke = auth.revokeRefreshTokens;
  const originalDeleteUser = auth.deleteUser;
  const originalGetStorage = storageSdk.getStorage;
  const deletedAuthUids = [];
  let failStorage = true;

  auth.updateUser = async () => undefined;
  auth.revokeRefreshTokens = async () => undefined;
  auth.deleteUser = async (uid) => {
    deletedAuthUids.push(uid);
  };
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
      await deleteUserEverywhere('incomplete-rollback-user');
    } catch (error) {
      cleanupError = error;
    }
    check(
      'the account cleanup failed before Auth deletion',
      String(cleanupError?.message || '').includes('Storage outage'),
      true,
    );
    check(
      'the failed account cleanup kept the rollback worker instruction',
      (await rollbackRef.get()).get('status'),
      'rollbackRequested',
    );
    check(
      'the failed account cleanup did not delete the Auth account',
      deletedAuthUids,
      [],
    );

    // The rollback worker can now finish the incomplete registration even
    // though the broader account cleanup was interrupted.
    failStorage = false;
    const rollbackSummary = await processRegistrationRollbackOperations();
    check('the rollback worker deleted the pending Auth account', rollbackSummary.deleted, 1);
    check(
      'the rollback worker deleted the expected Auth uid',
      deletedAuthUids,
      ['incomplete-rollback-user'],
    );
    check(
      'the rollback worker completed the durable marker',
      (await rollbackRef.get()).get('status'),
      'authDeleted',
    );

    // A successful account-cleanup retry removes the completed marker. It
    // can therefore never be picked up as future work for the deleted uid.
    await deleteUserEverywhere('incomplete-rollback-user');
    check(
      'the completed account cleanup removed the rollback marker',
      (await rollbackRef.get()).exists,
      false,
    );
    check(
      'the completed account cleanup removed the incomplete profile',
      (await db
        .collection('users')
        .doc('incomplete-rollback-user')
        .get()).exists,
      false,
    );

    // These operation collections contain uids and proofs. Even a trusted
    // administrator client must not be able to read them.
    await db.collection('emailLinkOperations').doc('private-email-link').set({
      operationId: 'private-email-link',
      uid: 'incomplete-rollback-user',
      email: 'private@example.test',
      status: 'authorised',
    });
    const rollbackRead = await readDocumentAsClient({
      collection: 'registrationRollbackOperations',
      documentId: 'incomplete-rollback-user',
      uid: 'admin-1',
      claims: { admin: true },
    });
    check(
      'an administrator client cannot read the rollback operation',
      rollbackRead.status >= 400,
      true,
    );
    const emailLinkRead = await readDocumentAsClient({
      collection: 'emailLinkOperations',
      documentId: 'private-email-link',
      uid: 'admin-1',
      claims: { admin: true },
    });
    check(
      'an administrator client cannot read the email-link operation',
      emailLinkRead.status >= 400,
      true,
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
    phoneVerified: true,
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
    phoneVerified: true,
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
    phoneVerified: true,
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
    reviewInstanceId: 'review-instance-existing',
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
      () =>
        invoke(
          deleteRoomReview,
          {
            roomId: 'RM-REVIEW',
            expectedReviewInstanceId: 'review-instance-existing',
          },
          'student-1',
        ),
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
  const reviewLifecycleId = 'review-lifecycle-listing-cleanup';
  const reviewNotificationIdForCleanup = reviewNotificationId(
    'REV-OLD-ROOM',
    reviewLifecycleId,
    'owner-1',
  );
  await db.collection('roomReviews').doc('REV-OLD-ROOM').set({
    reviewId: 'REV-OLD-ROOM',
    reviewInstanceId: reviewLifecycleId,
    roomId: 'RM-REVIEW-CLEANUP',
    studentId: 'student-1',
    ownerId: 'owner-1',
    rating: 5,
    comment: 'Old review',
    createdAt: firestore.Timestamp.now(),
    updatedAt: firestore.Timestamp.now(),
  });
  await db
    .collection('notifications')
    .doc(reviewNotificationIdForCleanup)
    .set({
      userId: 'owner-1',
      title: 'New review',
      body: 'student-1 rated your room 5/5',
      type: 'review',
      data: { roomId: 'RM-REVIEW-CLEANUP' },
      read: false,
      createdAt: firestore.Timestamp.now(),
    });
  await db
    .collection('notificationAttributions')
    .doc(reviewNotificationIdForCleanup)
    .set({
      notificationId: reviewNotificationIdForCleanup,
      userId: 'owner-1',
      sourceType: 'roomReview',
      sourceAuthorUid: 'student-1',
      sourceRecipientUid: 'owner-1',
      sourceId: reviewLifecycleId,
      sourceReviewId: 'REV-OLD-ROOM',
      createdAt: firestore.Timestamp.now(),
      updatedAt: firestore.Timestamp.now(),
    });
  await db.collection('notifications').doc('legacy-listing-review-notification').set({
    userId: 'owner-1',
    title: 'New review',
    body: 'Old review',
    type: 'review',
    data: { roomId: 'RM-REVIEW-CLEANUP', reviewId: 'REV-OLD-ROOM' },
    read: false,
    createdAt: firestore.Timestamp.now(),
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
  check(
    'the deterministic review notification was removed',
    (
      await db
        .collection('notifications')
        .doc(reviewNotificationIdForCleanup)
        .get()
    ).exists,
    false,
  );
  check(
    'the review notification attribution was removed',
    (
      await db
        .collection('notificationAttributions')
        .doc(reviewNotificationIdForCleanup)
        .get()
    ).exists,
    false,
  );
  check(
    'the legacy review notification was removed',
    (
      await db
        .collection('notifications')
        .doc('legacy-listing-review-notification')
        .get()
    ).exists,
    false,
  );
}

async function testPhotoCleanupKeepsAReAddedImage() {
  section('room-photo cleanup keeps an image which was added again');

  await reset();
  const path = 'rooms/owner-1/RM-1/photo.jpg';
  const url =
    'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/' +
    `${encodeURIComponent(path)}?alt=media&token=abc`;
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

async function testPhoneAndGoogleRegistrationIdentities() {
  section('phone and Google identities can complete registration');

  const originalSetClaims = auth.setCustomUserClaims;
  const originalGetUser = auth.getUser;
  const liveAuthUsers = new Map([
    [
      'phone-user',
      {
        email: null,
        emailVerified: false,
        phoneNumber: '+919876543210',
        providerData: [{ providerId: 'phone' }],
      },
    ],
    [
      'google-user',
      {
        email: 'google-user@example.test',
        emailVerified: true,
        phoneNumber: null,
        providerData: [{ providerId: 'google.com' }],
      },
    ],
    [
      'role-phone-user',
      {
        email: null,
        emailVerified: false,
        phoneNumber: '+919876543212',
        providerData: [{ providerId: 'phone' }],
      },
    ],
    [
      'bound-user',
      {
        email: 'bound-user@example.test',
        emailVerified: false,
        phoneNumber: null,
        providerData: [{ providerId: 'password' }],
      },
    ],
    [
      'stale-phone-user',
      {
        email: null,
        emailVerified: false,
        phoneNumber: null,
        providerData: [{ providerId: 'password' }],
      },
    ],
    [
      'stale-role-user',
      {
        email: null,
        emailVerified: false,
        phoneNumber: null,
        providerData: [{ providerId: 'password' }],
      },
    ],
    [
      'stale-completed-user',
      {
        email: 'stale-completed-user@example.test',
        emailVerified: true,
        phoneNumber: null,
        providerData: [{ providerId: 'password' }],
      },
    ],
    [
      'stale-email-user',
      {
        email: 'stale-email-user@example.test',
        emailVerified: false,
        phoneNumber: null,
        providerData: [{ providerId: 'password' }],
      },
    ],
    [
      'stale-profile-email-user',
      {
        email: null,
        emailVerified: false,
        phoneNumber: null,
        providerData: [{ providerId: 'password' }],
      },
    ],
  ]);
  auth.setCustomUserClaims = async () => undefined;
  auth.getUser = async (uid) => ({
    uid,
    email: null,
    emailVerified: false,
    phoneNumber: null,
    providerData: [],
    ...(liveAuthUsers.get(uid) || {}),
  });
  try {
    await reset();
  await db.collection('users').doc('phone-user').set({
    uid: 'phone-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
    phone: '+919876543210',
    phoneVerified: true,
  });

  const phoneResult = await invoke(
    completeRegistration,
    { name: 'Phone User', role: 'student' },
    'phone-user',
    {
      email: '',
      email_verified: false,
      phone_number: '+919876543210',
      phone_number_verified: true,
      firebase: {
        identities: { phone: ['+919876543210'] },
        sign_in_provider: 'phone',
      },
    },
  );
  check('a phone-only account completes registration', phoneResult.success, true);
  check(
    'the phone-only account keeps its verified phone',
    (await db.collection('users').doc('phone-user').get()).get('phoneVerified'),
    true,
  );
  check(
    'the phone-only account has no verified email',
    (await db.collection('users').doc('phone-user').get()).get('emailVerified'),
    false,
  );

  await reset();
  await db.collection('users').doc('google-user').set({
    uid: 'google-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
    email: 'google-user@example.test',
    emailVerified: true,
  });
  const googleResult = await invoke(
    completeRegistration,
    { name: 'Google User', role: 'student' },
    'google-user',
    {
      email: 'google-user@example.test',
      email_verified: true,
      firebase: {
        identities: { 'google.com': ['google-user@example.test'] },
        sign_in_provider: 'google.com',
      },
    },
  );
  check('a Google account completes registration', googleResult.success, true);
  check(
    'the Google account keeps its verified email',
    (await db.collection('users').doc('google-user').get()).get('emailVerified'),
    true,
  );
  check(
    'the Google provider is recorded on the profile',
    (await db.collection('users').doc('google-user').get()).get('authProviders'),
    ['google.com'],
  );

  await reset();
  await db.collection('users').doc('role-phone-user').set({
    uid: 'role-phone-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
    phone: '+919876543212',
    phoneVerified: true,
  });
  const roleResult = await invoke(
    registerUserRole,
    { role: 'owner', challenge: '' },
    'role-phone-user',
    {
      email: '',
      email_verified: false,
      phone_number: '+919876543212',
      phone_number_verified: true,
      firebase: {
        identities: { phone: ['+919876543212'] },
        sign_in_provider: 'phone',
      },
    },
  );
  check('a verified phone can claim a role without an email challenge', roleResult.success, true);
  const roleProfile = await db.collection('users').doc('role-phone-user').get();
  check('the role claim completes the registration', roleProfile.get('registrationCompleted'), true);
  check('the role claim stores the selected role', roleProfile.get('role'), 'owner');
  check('the role claim keeps the verified phone', roleProfile.get('phoneVerified'), true);

  await reset();
  await db.collection('users').doc('bound-user').set({
    uid: 'bound-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
    email: 'bound-user@example.test',
    emailVerified: false,
  });
  const boundChallenge = 'bound-to-another-user';
  await db.collection('otpCodes').doc(testOtpDocumentId('email', 'bound-user@example.test')).set({
    channel: 'email',
    identifierHash: crypto
      .createHash('sha256')
      .update('bound-user@example.test')
      .digest('hex'),
    verified: true,
    verifiedByUid: 'another-user',
    challengeHash: crypto.createHash('sha256').update(boundChallenge).digest('hex'),
    challengeUsed: false,
    challengeIssuedAt: firestore.Timestamp.now(),
    challengeExpiresAt: firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
  });
  await expectDenied(
    'a challenge bound to another signed-in account cannot complete registration',
    () =>
      invoke(
        completeRegistration,
        { name: 'Bound User', role: 'student', challenge: boundChallenge },
        'bound-user',
        {
          email: 'bound-user@example.test',
          email_verified: false,
        },
      ),
    'failed-precondition',
  );
  check(
    'the foreign challenge did not complete the registration',
    (await db.collection('users').doc('bound-user').get()).get('registrationCompleted'),
    false,
  );

  // A phone provider may be unlinked after an ID token was issued. The old
  // token is still cryptographically valid and still carries the phone, but
  // the live Auth record does not. Registration must not accept that stale
  // phone as a verified registration contact.
  await reset();
  await db.collection('users').doc('stale-phone-user').set({
    uid: 'stale-phone-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
    phone: '+919876543219',
    phoneVerified: true,
  });
  await expectDenied(
    'a stale token cannot complete registration with an unlinked phone',
    () =>
      invoke(
        completeRegistration,
        { name: 'Stale Phone User', role: 'student' },
        'stale-phone-user',
        {
          email: '',
          email_verified: false,
          phone_number: '+919876543219',
          phone_number_verified: true,
          firebase: {
            identities: { phone: ['+919876543219'] },
            sign_in_provider: 'phone',
          },
        },
      ),
    'failed-precondition',
  );
  check(
    'the stale phone did not complete the registration',
    (await db.collection('users').doc('stale-phone-user').get()).get('registrationCompleted'),
    false,
  );

  await reset();
  await db.collection('users').doc('stale-role-user').set({
    uid: 'stale-role-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
    phone: '+919876543219',
    phoneVerified: true,
  });
  await expectDenied(
    'a stale token cannot claim a role with an unlinked phone',
    () =>
      invoke(
        registerUserRole,
        { role: 'owner', challenge: '' },
        'stale-role-user',
        {
          email: '',
          email_verified: false,
          phone_number: '+919876543219',
          phone_number_verified: true,
          firebase: {
            identities: { phone: ['+919876543219'] },
            sign_in_provider: 'phone',
          },
        },
      ),
    'failed-precondition',
  );
  check(
    'the stale phone did not claim a role',
    (await db.collection('users').doc('stale-role-user').get()).get('roleClaimed'),
    false,
  );

  // The idempotent role-publication retry must reconcile the cached phone as
  // well. Otherwise the missing Auth claim would provide a convenient way to
  // preserve a phone which had already been unlinked.
  await reset();
  await db.collection('users').doc('stale-completed-user').set({
    uid: 'stale-completed-user',
    role: 'student',
    roleClaimed: true,
    roleRevision: 0,
    registrationCompleted: true,
    isActive: true,
    email: 'stale-completed-user@example.test',
    emailVerified: true,
    phone: '+919876543219',
    phoneVerified: true,
  });
  const reconciled = await invoke(
    registerUserRole,
    { role: 'student', challenge: '' },
    'stale-completed-user',
    {
      email: 'stale-completed-user@example.test',
      email_verified: true,
      phone_number: '+919876543219',
      phone_number_verified: true,
      firebase: {
        identities: { phone: ['+919876543219'] },
        sign_in_provider: 'phone',
      },
    },
  );
  check('the idempotent role retry succeeds', reconciled.success, true);
  check(
    'the idempotent role retry revokes an unlinked phone',
    (await db.collection('users').doc('stale-completed-user').get()).get('phoneVerified'),
    false,
  );
  check(
    'the idempotent role retry removes the unlinked phone',
    (await db.collection('users').doc('stale-completed-user').get()).get('phone'),
    null,
  );

  // A legacy profile may contain a stale verified address. The live Auth
  // record is authoritative, so an idempotent registration retry must not
  // preserve that address after Auth removed or replaced it.
  await reset();
  await db.collection('users').doc('stale-profile-email-user').set({
    uid: 'stale-profile-email-user',
    role: 'student',
    roleClaimed: true,
    roleRevision: 0,
    registrationCompleted: true,
    isActive: true,
    email: 'removed-profile@example.test',
    emailVerified: true,
    emailVerifiedAt: firestore.Timestamp.now(),
    phone: null,
    phoneVerified: false,
  });
  const reconciledEmail = await invoke(
    registerUserRole,
    { role: 'student', challenge: '' },
    'stale-profile-email-user',
    {
      email: 'removed-profile@example.test',
      email_verified: true,
    },
  );
  check('the idempotent email reconciliation succeeds', reconciledEmail.success, true);
  const reconciledEmailProfile = await db
    .collection('users')
    .doc('stale-profile-email-user')
    .get();
  check(
    'the removed live email is not preserved on the profile',
    reconciledEmailProfile.get('email'),
    '',
  );
  check(
    'the removed live email is no longer marked verified',
    reconciledEmailProfile.get('emailVerified'),
    false,
  );

  // The same rule applies to an email claim: only the live Auth record may
  // establish that the address is currently verified.
  await reset();
  await db.collection('users').doc('stale-email-user').set({
    uid: 'stale-email-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
    email: 'stale-email-user@example.test',
    emailVerified: false,
  });
  await expectDenied(
    'a stale token cannot complete registration with an unverified live email',
    () =>
      invoke(
        completeRegistration,
        { name: 'Stale Email User', role: 'student' },
        'stale-email-user',
        {
          email: 'stale-email-user@example.test',
          email_verified: true,
        },
      ),
    'failed-precondition',
  );
  check(
    'the stale email claim did not complete the registration',
    (await db.collection('users').doc('stale-email-user').get()).get('registrationCompleted'),
    false,
  );

  // An Auth lookup failure is not proof of a verified contact. Registration
  // must fail closed instead of falling back to the signed token.
  await reset();
  await db.collection('users').doc('auth-failure-user').set({
    uid: 'auth-failure-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
  });
  const liveGetter = auth.getUser;
  auth.getUser = async () => {
    throw new Error('simulated Auth lookup failure');
  };
  try {
    await expectDenied(
      'a live Auth lookup failure does not complete registration',
      () =>
        invoke(
          completeRegistration,
          { name: 'Auth Failure User', role: 'student' },
          'auth-failure-user',
          {
            email: '',
            email_verified: false,
            phone_number: '+919876543219',
            phone_number_verified: true,
          },
        ),
      'internal',
    );
  } finally {
    auth.getUser = liveGetter;
  }
  check(
    'the Auth lookup failure did not complete the registration',
    (await db.collection('users').doc('auth-failure-user').get()).get('registrationCompleted'),
    false,
  );
  } finally {
    auth.setCustomUserClaims = originalSetClaims;
    auth.getUser = originalGetUser;
  }
}

async function testAuthProfileSyncAndEmailLink() {
  section('Auth profile synchronisation and later email linking are server-owned');

  const originalGetUser = auth.getUser;
  const originalUpdateUser = auth.updateUser;
  const authState = {
    uid: 'sync-user',
    email: null,
    emailVerified: false,
    phoneNumber: '+919876543211',
    providerData: [{ providerId: 'phone' }],
  };
  let updateProperties = null;
  let failNextAuthUpdate = true;
  auth.getUser = async () => ({ ...authState });
  auth.updateUser = async (uid, properties) => {
    updateProperties = { uid, properties };
    if (failNextAuthUpdate) {
      failNextAuthUpdate = false;
      throw new Error('simulated transient Auth update failure');
    }
    authState.email = properties.email;
    authState.emailVerified = properties.emailVerified;
    return { ...authState };
  };

  try {
    await reset();
  await db.collection('users').doc('sync-user').set({
    uid: 'sync-user',
    role: 'student',
    registrationCompleted: true,
    isActive: true,
    name: 'Sync User',
    email: '',
    emailVerified: false,
    phone: null,
    phoneVerified: false,
  });
  const synced = await invoke(
    syncAuthProfile,
    {},
    'sync-user',
    {
      email: '',
      email_verified: false,
      phone_number: '+919876543211',
      phone_number_verified: true,
      firebase: {
        identities: { phone: ['+919876543211'] },
        sign_in_provider: 'phone',
      },
    },
  );
  check('the Auth profile sync succeeds', synced.success, true);
  check(
    'the signed phone claim is copied to the profile',
    (await db.collection('users').doc('sync-user').get()).get('phoneVerified'),
    true,
  );

  // Simulate a phone provider which was unlinked after the ID token was
  // issued. The old token is still cryptographically valid and still carries
  // the phone, but the live Auth record does not. The server must revoke the
  // stale verified-phone grant instead of preserving it.
  authState.phoneNumber = null;
  authState.providerData = [{ providerId: 'password' }];
  const revoked = await invoke(
    syncAuthProfile,
    {},
    'sync-user',
    {
      email: '',
      email_verified: false,
      phone_number: '+919876543211',
      phone_number_verified: true,
      firebase: {
        identities: { phone: ['+919876543211'] },
        sign_in_provider: 'phone',
      },
    },
  );
  check('the profile sync accepts the live Auth state', revoked.success, true);
  check(
    'an unlinked phone is no longer verified on the profile',
    (await db.collection('users').doc('sync-user').get()).get('phoneVerified'),
    false,
  );
  check(
    'an unlinked phone is removed from the profile',
    (await db.collection('users').doc('sync-user').get()).get('phone'),
    null,
  );

  // Restore the phone for the separate email-linking regression below.
  authState.phoneNumber = '+919876543211';
  authState.providerData = [{ providerId: 'phone' }];
  await invoke(
    syncAuthProfile,
    {},
    'sync-user',
    {
      email: '',
      email_verified: false,
      phone_number: '+919876543211',
      phone_number_verified: true,
      firebase: {
        identities: { phone: ['+919876543211'] },
        sign_in_provider: 'phone',
      },
    },
  );

  // The live Auth record is authoritative for the address as well as its
  // verification flag. A removed or replaced address must not survive in the
  // profile merely because an older copy was marked verified.
  await db.collection('users').doc('sync-user').set({
    email: 'removed@example.test',
    emailVerified: true,
  }, { merge: true });
  authState.email = 'replacement@example.test';
  authState.emailVerified = false;
  const replacedEmail = await invoke(
    syncAuthProfile,
    {},
    'sync-user',
    {
      email: 'removed@example.test',
      email_verified: true,
    },
  );
  check('the live email replacement is synchronised', replacedEmail.success, true);
  const replacedProfile = await db.collection('users').doc('sync-user').get();
  check(
    'the profile contains the live replacement address',
    replacedProfile.get('email'),
    'replacement@example.test',
  );
  check(
    'the replaced address is not marked verified by the stale profile',
    replacedProfile.get('emailVerified'),
    false,
  );

  // Restore the phone-only state for the separate email-linking regression.
  authState.email = null;
  authState.emailVerified = false;
  await db.collection('users').doc('sync-user').set({
    email: '',
    emailVerified: false,
  }, { merge: true });

  const identifier = 'linked@example.test';
  const challenge = 'linked-email-challenge';
  await db.collection('otpCodes').doc(testOtpDocumentId('email', identifier)).set({
    channel: 'email',
    identifierHash: crypto
      .createHash('sha256')
      .update(identifier)
      .digest('hex'),
    verified: true,
    verifiedByUid: 'sync-user',
    challengeHash: crypto.createHash('sha256').update(challenge).digest('hex'),
    challengeUsed: false,
    challengeIssuedAt: firestore.Timestamp.now(),
    challengeExpiresAt: firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
  });

    await expectDenied(
      'a transient Auth failure does not discard the authorised link request',
      () =>
        invoke(
          linkVerifiedEmail,
          { email: identifier, challenge },
          'sync-user',
          { email: '', email_verified: false },
        ),
      'internal',
    );
    check(
      'the authorised retry record survives the transient Auth failure',
      (await db.collection('emailLinkOperations').get()).size,
      1,
    );
    check(
      'the consumed email proof is retained for the authorised retry',
      (await db.collection('otpCodes').doc(testOtpDocumentId('email', identifier)).get()).get('challengeUsed'),
      true,
    );

    const linked = await invoke(
      linkVerifiedEmail,
      { email: identifier, challenge },
      'sync-user',
      { email: '', email_verified: false },
    );
    check('the authorised email link retry succeeds', linked.success, true);
    check(
      'Firebase Auth receives the verified address',
      updateProperties?.properties,
      { email: identifier, emailVerified: true },
    );
    check(
      'the linked email is copied to the profile',
      (await db.collection('users').doc('sync-user').get()).get('emailVerified'),
      true,
    );
    check(
      'adding an email does not claim a password provider',
      (await db.collection('users').doc('sync-user').get()).get('authProviders'),
      ['phone'],
    );

    // Simulate the narrow cross-system failure window: Auth already contains
    // the verified address, but the Firestore profile write was lost. The
    // same authorised request must repair the profile without a new code.
    await db.collection('users').doc('sync-user').set(
      {
        email: '',
        emailVerified: false,
      },
      { merge: true },
    );
    const operationSnapshot = await db
      .collection('emailLinkOperations')
      .doc((await db.collection('emailLinkOperations').get()).docs[0].id)
      .get();
    await operationSnapshot.ref.set(
      { status: 'authorised' },
      { merge: true },
    );
    const recovered = await invoke(
      linkVerifiedEmail,
      { email: identifier, challenge },
      'sync-user',
      { email: '', email_verified: false },
    );
    check('the partial cross-system link is recoverable', recovered.success, true);
    check(
      'the recovered profile contains the verified email',
      (await db.collection('users').doc('sync-user').get()).get('emailVerified'),
      true,
    );

    // The durable retry window is finite even after the operation completed.
    // Otherwise the consumed code could be replayed forever and restore an
    // address which was subsequently removed from the live Auth account.
    await operationSnapshot.ref.set(
      {
        status: 'complete',
        expiresAt: firestore.Timestamp.fromMillis(Date.now() - 1000),
      },
      { merge: true },
    );
    authState.email = null;
    authState.emailVerified = false;
    await expectDenied(
      'an expired email-link retry cannot restore the removed address',
      () =>
        invoke(
          linkVerifiedEmail,
          { email: identifier, challenge },
          'sync-user',
          { email: '', email_verified: false },
        ),
      'failed-precondition',
    );
    check(
      'the expired retry did not restore the address in Firebase Auth',
      authState.email,
      null,
    );
  } finally {
    auth.getUser = originalGetUser;
    auth.updateUser = originalUpdateUser;
  }
}

async function testConcurrentEmailLinksAreSerialized() {
  section('concurrent different email links are serialised per account');

  const originalGetUser = auth.getUser;
  const originalUpdateUser = auth.updateUser;
  const authState = {
    email: null,
    emailVerified: false,
    phoneNumber: '+919876543213',
    providerData: [{ providerId: 'phone' }],
  };
  auth.getUser = async (uid) => ({ uid, ...authState });
  auth.updateUser = async (uid, properties) => {
    // Keep the winning request inside the Auth/Firestore hand-off long
    // enough for the other request to attempt the same account lock.
    await new Promise((resolve) => setTimeout(resolve, 50));
    authState.email = properties.email;
    authState.emailVerified = properties.emailVerified;
    return { uid, ...authState };
  };

  const firstEmail = 'first-concurrent@example.test';
  const secondEmail = 'second-concurrent@example.test';
  const firstChallenge = 'first-concurrent-challenge';
  const secondChallenge = 'second-concurrent-challenge';

  const seedChallenge = async (email, challenge) => {
    await db.collection('otpCodes').doc(testOtpDocumentId('email', email)).set({
      channel: 'email',
      identifierHash: crypto
        .createHash('sha256')
        .update(email)
        .digest('hex'),
      verified: true,
      verifiedByUid: 'concurrent-link-user',
      challengeHash: crypto.createHash('sha256').update(challenge).digest('hex'),
      challengeUsed: false,
      challengeIssuedAt: firestore.Timestamp.now(),
      challengeExpiresAt: firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
    });
  };

  try {
    await reset();
    await db.collection('users').doc('concurrent-link-user').set({
      uid: 'concurrent-link-user',
      role: 'student',
      roleClaimed: true,
      registrationCompleted: true,
      isActive: true,
      email: '',
      emailVerified: false,
      phone: '+919876543213',
      phoneVerified: true,
      authProviders: ['phone'],
    });
    await seedChallenge(firstEmail, firstChallenge);
    await seedChallenge(secondEmail, secondChallenge);

    const results = await Promise.allSettled([
      invoke(
        linkVerifiedEmail,
        { email: firstEmail, challenge: firstChallenge },
        'concurrent-link-user',
      ),
      invoke(
        linkVerifiedEmail,
        { email: secondEmail, challenge: secondChallenge },
        'concurrent-link-user',
      ),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    check('exactly one concurrent email link succeeds', fulfilled.length, 1);
    check('the other concurrent email link is refused', rejected.length, 1);
    check(
      'the losing email link reports a precondition failure',
      String(rejected[0]?.reason?.code || '').includes('failed-precondition'),
      true,
    );

    const linkedProfile = await db
      .collection('users')
      .doc('concurrent-link-user')
      .get();
    check(
      'the profile email matches the final live Auth email',
      linkedProfile.get('email'),
      authState.email,
    );
    check(
      'the profile verification flag matches the final live Auth state',
      linkedProfile.get('emailVerified'),
      authState.emailVerified,
    );
    check(
      'the profile contains the address which won the Auth update',
      authState.email === firstEmail || authState.email === secondEmail,
      true,
    );

    const losingEmail = authState.email === firstEmail ? secondEmail : firstEmail;
    check(
      'the rejected request did not consume its email proof',
      (await db
        .collection('otpCodes')
        .doc(testOtpDocumentId('email', losingEmail))
        .get()).get('challengeUsed'),
      false,
    );
    check(
      'the rejected request did not change the winning Auth address',
      authState.email !== losingEmail,
      true,
    );
    check(
      'the winning request kept its consumed proof',
      (await db
        .collection('otpCodes')
        .doc(
          testOtpDocumentId(
            'email',
            authState.email === firstEmail ? firstEmail : secondEmail,
          ),
        )
        .get()).get('challengeUsed'),
      true,
    );

    const linkOperations = await db.collection('emailLinkOperations').get();
    check(
      'the successful request released its account lock',
      linkOperations.docs.filter((doc) => doc.id.startsWith('lock_')).length,
      0,
    );
    check(
      'only the winning durable operation remains',
      linkOperations.docs.filter((doc) => !doc.id.startsWith('lock_')).length,
      1,
    );
    check(
      'the rejected request did not create a second durable operation',
      linkOperations.docs.filter(
        (doc) =>
          !doc.id.startsWith('lock_') &&
          doc.get('email') === losingEmail,
      ).length,
      0,
    );
    check(
      'the winning proof remains bound to the account',
      (await db
        .collection('otpCodes')
        .doc(
          testOtpDocumentId(
            'email',
            authState.email === firstEmail ? firstEmail : secondEmail,
          ),
        )
        .get()).get('verifiedByUid'),
      'concurrent-link-user',
    );
  } finally {
    auth.getUser = originalGetUser;
    auth.updateUser = originalUpdateUser;
  }
}

async function testSupportRepliesUseTheTrustedRoute() {
  section('a support reply is written by the trusted server route');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('student-1', 'student');
  await seedUser('student-2', 'student');
  await db.collection('users').doc('student-1').set({
    ...profile('student-1', 'student'),
    phoneVerified: true,
  });
  await db.collection('users').doc('student-2').set({
    ...profile('student-2', 'student'),
    phoneVerified: true,
  });

  const sent = await invoke(
    sendAdminMessage,
    {
      userId: 'student-1',
      content: 'Please update your room details.',
      requestId: 'support-reply-admin-message',
    },
    'admin-1',
  );
  const adminIdentity = adminSupportIdentityFor('admin-1');
  check('the administrator message is stored', sent.success, true);

  await db.collection('conversations').doc(sent.conversationId).update({
    unreadCount: {
      [adminIdentity]: 0,
      'student-1': 2,
    },
  });

  const reply = await invoke(
    sendAdminSupportReply,
    {
      conversationId: sent.conversationId,
      content: 'I have updated the room details.',
      requestId: 'support-reply-request-1',
    },
    'student-1',
  );
  check('the support reply is accepted', reply.success, true);
  check(
    'the support reply keeps the request id idempotent',
    reply.alreadySent,
    false,
  );

  const storedReply = await db
    .collection('conversations')
    .doc(sent.conversationId)
    .collection('messages')
    .doc(reply.messageId)
    .get();
  check(
    'the support reply names the support target as the sender',
    storedReply.get('senderId'),
    'student-1',
  );
  check(
    'the support reply names the opaque administrator as the receiver',
    storedReply.get('receiverId'),
    adminIdentity,
  );
  check(
    'the support reply does not carry an administrator marker',
    storedReply.get('adminVerified') == null,
    true,
  );
  check(
    'the support reply is stored with the administrator reply in one channel',
    (await db
      .collection('conversations')
      .doc(sent.conversationId)
      .collection('messages')
      .get()).size,
    2,
  );

  const replyUnread = (
    await db.collection('conversations').doc(sent.conversationId).get()
  ).get('unreadCount');
  check(
    'the support reply raises the administrator counter by exactly one',
    replyUnread[adminIdentity],
    1,
  );
  check(
    'the support reply preserves the tenant counter',
    replyUnread['student-1'],
    2,
  );
  check(
    'the support reply updates the conversation preview',
    (await db.collection('conversations').doc(sent.conversationId).get()).get(
      'lastMessage',
    ),
    'I have updated the room details.',
  );

  const retriedReply = await invoke(
    sendAdminSupportReply,
    {
      conversationId: sent.conversationId,
      content: 'I have updated the room details.',
      requestId: 'support-reply-request-1',
    },
    'student-1',
  );
  check('the support reply retry is idempotent', retriedReply.alreadySent, true);
  check(
    'the support reply retry did not create a duplicate message',
    (await db
      .collection('conversations')
      .doc(sent.conversationId)
      .collection('messages')
      .get()).size,
    2,
  );
  check(
    'the support reply retry did not raise the administrator counter again',
    (
      await db.collection('conversations').doc(sent.conversationId).get()
    ).get('unreadCount')[adminIdentity],
    1,
  );

  await expectDenied(
    'the same request id cannot be reused for a different reply',
    () =>
      invoke(
        sendAdminSupportReply,
        {
          conversationId: sent.conversationId,
          content: 'A different reply.',
          requestId: 'support-reply-request-1',
        },
        'student-1',
      ),
    'already-exists',
  );

  await expectDenied(
    'another tenant cannot reply to somebody else support channel',
    () =>
      invoke(
        sendAdminSupportReply,
        {
          conversationId: sent.conversationId,
          content: 'Not my conversation.',
          requestId: 'support-reply-request-foreign',
        },
        'student-2',
      ),
    'permission-denied',
  );

  await expectDenied(
    'a support reply cannot address an unknown conversation',
    () =>
      invoke(
        sendAdminSupportReply,
        {
          conversationId: 'ADMIN-unknown-conversation',
          content: 'Hello?',
          requestId: 'support-reply-request-unknown',
        },
        'student-1',
      ),
    'not-found',
  );

  // The mapped administrator has to stay live: a reply which was written after
  // a demotion would stay in a channel which nobody can answer.
  await db.collection('users').doc('admin-1').update({ role: 'student' });
  await expectDenied(
    'a support reply to a demoted administrator is refused',
    () =>
      invoke(
        sendAdminSupportReply,
        {
          conversationId: sent.conversationId,
          content: 'Still there?',
          requestId: 'support-reply-request-demoted',
        },
        'student-1',
      ),
    'permission-denied',
  );
  await db.collection('users').doc('admin-1').update({ role: 'admin' });

  // The support target clears its own counter; the administrator's counter
  // stays untouched.
  const tenantReadReceipt = await invoke(
    markAdminSupportConversationRead,
    { conversationId: sent.conversationId },
    'student-1',
  );
  check('the support target can clear its own counter', tenantReadReceipt.success, true);
  const afterTenantRead = (
    await db.collection('conversations').doc(sent.conversationId).get()
  ).get('unreadCount');
  check('the support target counter was cleared', afterTenantRead['student-1'], 0);
  check(
    'the administrator counter survived the tenant read receipt',
    afterTenantRead[adminIdentity],
    1,
  );

  await expectDenied(
    'an unmapped administrator cannot clear the support conversation',
    () =>
      invoke(
        markAdminSupportConversationRead,
        { conversationId: sent.conversationId },
        'student-2',
      ),
    'permission-denied',
  );

  // The cached `phoneVerified` flag alone must not authorize the read
  // receipt. A tenant whose phone provider was unlinked keeps the stale
  // cache until the next profile synchronisation, so the live Auth proof
  // decides.
  const originalGetUser = auth.getUser;
  auth.getUser = async (uid) => ({
    uid,
    email: `${uid}@example.test`,
    emailVerified: false,
    phoneNumber: '+919876500000',
    // The signed proof is gone: the live number is no longer bound to a
    // completed phone challenge.
    customClaims: {},
    providerData: [
      { providerId: 'password' },
      { providerId: 'phone', phoneNumber: '+919876500000' },
    ],
  });
  try {
    await expectDenied(
      'a tenant without a live verified phone cannot clear its counter',
      () =>
        invoke(
          markAdminSupportConversationRead,
          { conversationId: sent.conversationId },
          'student-1',
        ),
      'permission-denied',
    );
  } finally {
    auth.getUser = originalGetUser;
  }

  // The notification is addressed to the real administrator, never to the
  // synthetic identity.
  await db.collection('users').doc('admin-1').update({
    fcmToken: 'support-reply-device-token',
  });
  const supportPushes = [];
  const supportMessagingGetter = messagingSdk.getMessaging;
  messagingSdk.getMessaging = () => ({
    send: async (message) => {
      supportPushes.push(message);
      return 'support-reply-message-id';
    },
  });
  let secondReply;
  try {
    secondReply = await invoke(
      sendAdminSupportReply,
      {
        conversationId: sent.conversationId,
        content: 'A second reply.',
        requestId: 'support-reply-request-2',
      },
      'student-1',
    );
  } finally {
    messagingSdk.getMessaging = supportMessagingGetter;
  }
  const administratorNotifications = await db
    .collection('notifications')
    .where('userId', '==', 'admin-1')
    .get();
  check(
    'every support reply notifies the real administrator exactly once',
    administratorNotifications.size,
    2,
  );
  const secondNotification = administratorNotifications.docs.find(
    (document) =>
      document.get('data')?.messageId === secondReply.messageId,
  );
  check(
    'the support reply notification was created',
    Boolean(secondNotification),
    true,
  );
  check(
    'the support reply notification points at the support conversation',
    secondNotification?.get('data')?.conversationId,
    sent.conversationId,
  );
  check(
    'the support reply notification does not copy the private reply text',
    String(secondNotification?.get('body') || '').includes('A second reply.'),
    false,
  );
  check('the support reply sends one device push', supportPushes.length, 1);
  const syntheticNotifications = await db
    .collection('notifications')
    .where('userId', '==', adminIdentity)
    .get();
  check(
    'the support reply does not notify the synthetic identity',
    syntheticNotifications.size,
    0,
  );
}

async function testLegacyAdminUnreadCounterSurvivesTheConversion() {
  section('a legacy administrator unread counter survives the conversion');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('student-1', 'student');
  await db.collection('users').doc('student-1').set({
    ...profile('student-1', 'student'),
    phoneVerified: true,
  });

  const conversationId = adminConversationId('admin-1', 'student-1');
  const adminIdentity = adminSupportIdentityFor('admin-1');
  const now = firestore.Timestamp.now();

  // A legacy support channel counted the administrator's unread replies under
  // the administrator's real uid.
  await db.collection('conversations').doc(conversationId).set({
    conversationId,
    participantIds: ['admin-1', 'student-1'],
    participantNames: {
      'admin-1': 'StayServe Admin',
      'student-1': 'student-1',
    },
    conversationType: 'adminSupport',
    adminId: 'admin-1',
    unreadCount: {
      'admin-1': 3,
      'student-1': 2,
    },
    lastMessage: 'An earlier reply.',
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await invoke(
    sendAdminMessage,
    {
      userId: 'student-1',
      content: 'Please update your room details.',
      requestId: 'legacy-unread-remap',
    },
    'admin-1',
  );

  const conversation = await db
    .collection('conversations')
    .doc(conversationId)
    .get();
  const unread = conversation.get('unreadCount');
  check(
    'the legacy administrator counter is remapped to the opaque identity',
    unread[adminIdentity],
    3,
  );
  check(
    'the legacy administrator uid is no longer a counter key',
    unread['admin-1'] === undefined,
    true,
  );
  check(
    'the tenant counter survives the conversion and the new message',
    unread['student-1'],
    3,
  );
  check(
    'the conversion replaces the administrator participant',
    conversation.get('participantIds'),
    [adminIdentity, 'student-1'],
  );
  check(
    'the conversion replaces the administrator marker',
    conversation.get('adminId'),
    adminIdentity,
  );
}

async function testSupportReplyNotificationDeliveryIsRetryable() {
  section('a failed support-reply notification is repaired by the retry');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('student-1', 'student');
  await db.collection('users').doc('student-1').set({
    ...profile('student-1', 'student'),
    phoneVerified: true,
  });
  await db.collection('users').doc('admin-1').update({
    fcmToken: 'support-retry-device-token',
  });

  const sent = await invoke(
    sendAdminMessage,
    {
      userId: 'student-1',
      content: 'Please update your room details.',
      requestId: 'support-retry-admin-message',
    },
    'admin-1',
  );

  // The first device push fails. The message itself is stored.
  const failedPushes = [];
  const originalGetter = messagingSdk.getMessaging;
  messagingSdk.getMessaging = () => ({
    send: async (message) => {
      failedPushes.push(message);
      throw new Error('The device push failed.');
    },
  });
  let reply;
  try {
    reply = await invoke(
      sendAdminSupportReply,
      {
        conversationId: sent.conversationId,
        content: 'I have updated the room details.',
        requestId: 'support-retry-request',
      },
      'student-1',
    );
  } finally {
    messagingSdk.getMessaging = originalGetter;
  }
  check('the support reply is stored even though the push failed', reply.success, true);
  check('the failed push was attempted', failedPushes.length, 1);

  const operationRef = db
    .collection(ADMIN_SUPPORT_REPLY_NOTIFICATION_OPERATIONS)
    .doc(reply.messageId);
  const operation = await operationRef.get();
  check('the durable delivery operation exists', operation.exists, true);
  check(
    'the failed push is still pending',
    operation.get('pushDeliveryState'),
    'pending',
  );
  check(
    'the in-app notification was created',
    (
      await db.collection('notifications').where('userId', '==', 'admin-1').get()
    ).size,
    1,
  );

  // The retry of the same request repairs the failed push.
  const repairedPushes = [];
  messagingSdk.getMessaging = () => ({
    send: async (message) => {
      repairedPushes.push(message);
      return 'support-retry-message-id';
    },
  });
  let retried;
  try {
    retried = await invoke(
      sendAdminSupportReply,
      {
        conversationId: sent.conversationId,
        content: 'I have updated the room details.',
        requestId: 'support-retry-request',
      },
      'student-1',
    );
  } finally {
    messagingSdk.getMessaging = originalGetter;
  }
  check('the retry is idempotent', retried.alreadySent, true);
  check('the retry repeated the failed push', repairedPushes.length, 1);
  const repairedOperation = await operationRef.get();
  check(
    'the repaired push is marked as delivered',
    repairedOperation.get('pushDeliveryState'),
    'delivered',
  );
  check(
    'the retry did not create a second message',
    (
      await db
        .collection('conversations')
        .doc(sent.conversationId)
        .collection('messages')
        .get()
    ).size,
    2,
  );
  check(
    'the retry did not create a second notification',
    (
      await db.collection('notifications').where('userId', '==', 'admin-1').get()
    ).size,
    1,
  );

  // A missing in-app notification is repaired by the next retry as well.
  const notificationSnapshot = await db
    .collection('notifications')
    .where('userId', '==', 'admin-1')
    .limit(1)
    .get();
  await notificationSnapshot.docs[0].ref.delete();
  messagingSdk.getMessaging = () => ({
    send: async () => 'support-retry-message-id',
  });
  try {
    await invoke(
      sendAdminSupportReply,
      {
        conversationId: sent.conversationId,
        content: 'I have updated the room details.',
        requestId: 'support-retry-request',
      },
      'student-1',
    );
  } finally {
    messagingSdk.getMessaging = originalGetter;
  }
  check(
    'the retry recreated the missing in-app notification',
    (
      await db.collection('notifications').where('userId', '==', 'admin-1').get()
    ).size,
    1,
  );
}

async function testDraftListingsArePublishedByTheServer() {
  section('a new listing is published by the server when it is complete');

  await reset();
  await seedUser('owner-1', 'owner');
  await seedUser('owner-2', 'owner');
  await seedUser('student-1', 'student');

  // A new listing starts as a draft. It is not offered to students and it
  // cannot be booked while its photos and its private location are missing.
  await db.collection('rooms').doc('RM-DRAFT').set({
    roomId: 'RM-DRAFT',
    ownerId: 'owner-1',
    title: 'Draft room',
    monthlyRent: 6000,
    occupancy: 2,
    currentOccupancy: 0,
    status: 'draft',
    listingGeneration: 'generation-draft',
    images: [],
  });

  await expectDenied(
    'a draft without its private location cannot be published',
    () => invoke(publishRoomListing, { roomId: 'RM-DRAFT' }, 'owner-1'),
    'failed-precondition',
  );

  await db.collection('roomPrivate').doc('RM-DRAFT').set({
    roomId: 'RM-DRAFT',
    ownerId: 'owner-1',
    address: '42 Test Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: 77.5946,
  });

  const published = await invoke(
    publishRoomListing,
    { roomId: 'RM-DRAFT' },
    'owner-1',
  );
  check('the finished draft is published', published.success, true);
  check(
    'the published listing is available',
    (await db.collection('rooms').doc('RM-DRAFT').get()).get('status'),
    'available',
  );

  const retried = await invoke(
    publishRoomListing,
    { roomId: 'RM-DRAFT' },
    'owner-1',
  );
  check('the publication retry is idempotent', retried.alreadyPublished, true);
  check(
    'the retry did not change the listing again',
    (await db.collection('rooms').doc('RM-DRAFT').get()).get('status'),
    'available',
  );

  await expectDenied(
    'another owner cannot publish a foreign listing',
    () => invoke(publishRoomListing, { roomId: 'RM-DRAFT' }, 'owner-2'),
    'permission-denied',
  );

  await expectDenied(
    'a student cannot publish a listing',
    () => invoke(publishRoomListing, { roomId: 'RM-DRAFT' }, 'student-1'),
    'permission-denied',
  );

  // The live role is authoritative: a demoted owner cannot publish a
  // listing with a stale custom claim.
  await db.collection('rooms').doc('RM-DRAFT-3').set({
    roomId: 'RM-DRAFT-3',
    ownerId: 'owner-1',
    title: 'Draft room of a demoted owner',
    monthlyRent: 6000,
    occupancy: 2,
    currentOccupancy: 0,
    status: 'draft',
    listingGeneration: 'generation-draft-3',
    images: [],
  });
  await db.collection('roomPrivate').doc('RM-DRAFT-3').set({
    roomId: 'RM-DRAFT-3',
    ownerId: 'owner-1',
    address: '44 Test Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: 77.5946,
  });
  await db.collection('users').doc('owner-1').update({ role: 'student' });
  await expectDenied(
    'a demoted owner cannot publish a listing',
    () => invoke(publishRoomListing, { roomId: 'RM-DRAFT-3' }, 'owner-1'),
    'permission-denied',
  );
  check(
    'the demoted draft stays unpublished',
    (await db.collection('rooms').doc('RM-DRAFT-3').get()).get('status'),
    'draft',
  );
  await db.collection('users').doc('owner-1').update({ role: 'owner' });

  // A staged photo which was never committed keeps the listing unpublished.
  await db.collection('rooms').doc('RM-DRAFT-2').set({
    roomId: 'RM-DRAFT-2',
    ownerId: 'owner-1',
    title: 'Draft room with a staged photo',
    monthlyRent: 6000,
    occupancy: 2,
    currentOccupancy: 0,
    status: 'draft',
    listingGeneration: 'generation-draft-2',
    images: [],
  });
  await db.collection('roomPrivate').doc('RM-DRAFT-2').set({
    roomId: 'RM-DRAFT-2',
    ownerId: 'owner-1',
    address: '43 Test Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: 77.5946,
  });
  await db.collection('roomPhotoUploadOperations').doc('upload-draft-2').set({
    ownerId: 'owner-1',
    roomId: 'RM-DRAFT-2',
    uploadId: 'upload-draft-2',
    listingGeneration: 'generation-draft-2',
    status: 'uploaded',
    byteLength: 1024,
  });
  await expectDenied(
    'a draft with an uncommitted photo cannot be published',
    () => invoke(publishRoomListing, { roomId: 'RM-DRAFT-2' }, 'owner-1'),
    'failed-precondition',
  );
  check(
    'the incomplete draft stays unpublished',
    (await db.collection('rooms').doc('RM-DRAFT-2').get()).get('status'),
    'draft',
  );

  // The transactional counter is authoritative inside the publication
  // transaction: a listing whose room quota still holds a pending upload is
  // not published, even when the operation records were already swept.
  await db.collection('rooms').doc('RM-DRAFT-4').set({
    roomId: 'RM-DRAFT-4',
    ownerId: 'owner-1',
    title: 'Draft room with a pending quota',
    monthlyRent: 6000,
    occupancy: 2,
    currentOccupancy: 0,
    status: 'draft',
    listingGeneration: 'generation-draft-4',
    images: [],
  });
  await db.collection('roomPrivate').doc('RM-DRAFT-4').set({
    roomId: 'RM-DRAFT-4',
    ownerId: 'owner-1',
    address: '45 Test Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: 77.5946,
  });
  await db.collection('roomPhotoRoomQuotas').doc('RM-DRAFT-4').set({
    roomId: 'RM-DRAFT-4',
    ownerId: 'owner-1',
    listingGeneration: 'generation-draft-4',
    pendingCount: 1,
    pendingBytes: 1024,
  });
  await expectDenied(
    'a draft with a pending room-photo quota cannot be published',
    () => invoke(publishRoomListing, { roomId: 'RM-DRAFT-4' }, 'owner-1'),
    'failed-precondition',
  );
  check(
    'the draft with a pending quota stays unpublished',
    (await db.collection('rooms').doc('RM-DRAFT-4').get()).get('status'),
    'draft',
  );

  // The quota of an earlier lifetime of the same room id does not block a
  // new listing.
  await db.collection('roomPhotoRoomQuotas').doc('RM-DRAFT-4').update({
    listingGeneration: 'generation-of-an-earlier-lifetime',
    pendingCount: 3,
  });
  const publishedAfterFence = await invoke(
    publishRoomListing,
    { roomId: 'RM-DRAFT-4' },
    'owner-1',
  );
  check(
    'a quota of an earlier listing lifetime does not block the publication',
    publishedAfterFence.success,
    true,
  );

  // The owner cannot publish the listing with the availability toggle.
  await expectDenied(
    'the availability toggle cannot publish a draft',
    () =>
      invoke(
        setRoomListingAvailability,
        { roomId: 'RM-DRAFT-2', isOccupied: false },
        'owner-1',
      ),
    'failed-precondition',
  );
  check(
    'the availability toggle left the draft alone',
    (await db.collection('rooms').doc('RM-DRAFT-2').get()).get('status'),
    'draft',
  );
}

async function testAdminMessagingAndReviewDeletion() {
  section('administrators can message users and delete any review');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('admin-2', 'admin');
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  // `sendAdminMessage` uses the same phone-verified tenant policy as every
  // other service, so the fixture deliberately includes the proof.
  await db.collection('users').doc('student-1').set({
    ...profile('student-1', 'student'),
    phoneVerified: true,
  });

  await expectDenied(
    'a student cannot send an administrator message',
    () =>
      invoke(
        sendAdminMessage,
        {
          userId: 'owner-1',
          content: 'Pretend I am support',
          requestId: 'forged-admin-message',
        },
        'student-1',
      ),
    'permission-denied',
  );

  const sent = await invoke(
    sendAdminMessage,
    {
      userId: 'student-1',
      content: 'Please update your room details.',
      requestId: 'admin-message-test-1',
    },
    'admin-1',
  );
  check('the administrator message is stored', sent.success, true);
  const adminMessage = await db
    .collection('conversations')
    .doc(sent.conversationId)
    .collection('messages')
    .doc(sent.messageId)
    .get();
  check(
    'the server marks the message as sent by an administrator',
    adminMessage.get('senderType'),
    'admin',
  );
  check(
    'the server marks the administrator as verified',
    adminMessage.get('adminVerified'),
    true,
  );

  const adminIdentity = adminSupportIdentityFor('admin-1');
  const supportConversation = await db
    .collection('conversations')
    .doc(sent.conversationId)
    .get();
  check(
    'the recipient-readable conversation uses the stable administrator tick',
    supportConversation.get('participantIds'),
    [adminIdentity, 'student-1'],
  );
  check(
    'the recipient-readable conversation does not expose the administrator uid',
    supportConversation.get('adminId'),
    adminIdentity,
  );
  check(
    'the support conversation contains no raw administrator uid',
    JSON.stringify(supportConversation.data() || {}).includes('admin-1'),
    false,
  );
  check(
    'the recipient-readable message uses the stable administrator tick',
    adminMessage.get('senderId'),
    adminIdentity,
  );
  check(
    'the recipient-readable message has no raw administrator uid',
    JSON.stringify(adminMessage.data() || {}).includes('admin-1'),
    false,
  );

  const adminOperation = await db
    .collection('adminMessageNotificationOperations')
    .doc(sent.messageId)
    .get();
  check(
    'the server-only delivery operation keeps the administrator attribution',
    adminOperation.get('sourceAuthorUid'),
    'admin-1',
  );
  const conversationOperation = await db
    .collection(ADMIN_SUPPORT_CONVERSATION_OPERATIONS)
    .doc(sent.conversationId)
    .get();
  check(
    'the server-only conversation operation keeps the administrator attribution',
    conversationOperation.get('adminUid'),
    'admin-1',
  );
  check(
    'the server-only conversation operation keeps the opaque identity',
    conversationOperation.get('adminIdentity'),
    adminIdentity,
  );

  const administratorInbox = await invoke(
    listAdminSupportConversations,
    {},
    'admin-1',
  );
  check(
    'the mapped administrator discovers the support conversation',
    administratorInbox.conversationIds,
    [sent.conversationId],
  );
  check(
    'the administrator inbox does not expose the raw administrator uid',
    JSON.stringify(administratorInbox).includes('admin-1'),
    false,
  );
  const otherAdministratorInbox = await invoke(
    listAdminSupportConversations,
    {},
    'admin-2',
  );
  check(
    'an unmapped administrator does not discover the support conversation',
    otherAdministratorInbox.conversationIds,
    [],
  );
  await expectDenied(
    'a tenant cannot list the administrator support inbox',
    () => invoke(listAdminSupportConversations, {}, 'student-1'),
    'permission-denied',
  );

  await db.collection('conversations').doc(sent.conversationId).update({
    unreadCount: {
      [adminIdentity]: 4,
      'student-1': 3,
    },
  });
  await expectDenied(
    'an unmapped administrator cannot clear the support unread counter',
    () =>
      invoke(
        markAdminSupportConversationRead,
        { conversationId: sent.conversationId },
        'admin-2',
      ),
    'permission-denied',
  );
  const readReceipt = await invoke(
    markAdminSupportConversationRead,
    { conversationId: sent.conversationId },
    'admin-1',
  );
  check('the mapped administrator clears the support unread counter', readReceipt.success, true);
  const clearedUnread = (
    await db.collection('conversations').doc(sent.conversationId).get()
  ).get('unreadCount');
  check(
    'the trusted read receipt clears only the opaque administrator key',
    clearedUnread[adminIdentity],
    0,
  );
  check(
    'the trusted read receipt preserves the tenant unread counter',
    clearedUnread['student-1'],
    3,
  );
  const conversationOperationRead = await readDocumentAsClient({
    collection: ADMIN_SUPPORT_CONVERSATION_OPERATIONS,
    documentId: sent.conversationId,
    uid: 'admin-1',
    claims: { admin: true },
  });
  check(
    'an administrator client cannot read the conversation operation',
    conversationOperationRead.status >= 400,
    true,
  );
  check(
    'the opaque administrator profile is stored outside the readable user directory',
    (await db.collection('users').doc(adminIdentity).get()).exists,
    true,
  );
  const identityProfileRead = await readDocumentAsClient({
    collection: 'users',
    documentId: adminIdentity,
    uid: 'admin-1',
    claims: { admin: true },
  });
  check(
    'an administrator client cannot read the opaque support profile directly',
    identityProfileRead.status >= 400,
    true,
  );
  check(
    'the opaque administrator profile is not a top-level user document',
    (await db.collection('users').get()).docs.some(
      (document) => document.id === adminIdentity,
    ),
    false,
  );

  // Support details must derive the administrator's live role from the real
  // administrator profile. They must not depend on a readable synthetic
  // profile which may be absent from a migrated conversation.
  await db.collection('users').doc(adminIdentity).delete();
  check(
    'the synthetic administrator profile is absent for the tenant-support check',
    (await db.collection('users').doc(adminIdentity).get()).exists,
    false,
  );

  const supportDetails = await invoke(
    getConversationInteractionDetails,
    { conversationId: sent.conversationId },
    'student-1',
  );
  check(
    'the tenant resolves the trusted support identity through the server',
    supportDetails.peerId,
    adminIdentity,
  );
  check(
    'the tenant sees the administrator support conversation',
    supportDetails.isAdminSupport,
    true,
  );

  const administratorSupportDetails = await invoke(
    getConversationInteractionDetails,
    { conversationId: sent.conversationId },
    'admin-1',
  );
  check(
    'the mapped administrator resolves the tenant peer',
    administratorSupportDetails.peerId,
    'student-1',
  );
  check(
    'the mapped administrator sees the support conversation',
    administratorSupportDetails.isAdminSupport,
    true,
  );

  const administratorConversationRead = await readDocumentAsClient({
    collection: 'conversations',
    documentId: sent.conversationId,
    uid: 'admin-1',
    claims: { admin: true },
  });
  check(
    'the mapped administrator can read the support conversation',
    administratorConversationRead.status < 400,
    true,
  );
  const administratorMessageRead = await readDocumentAsClient({
    collection: `conversations/${sent.conversationId}/messages`,
    documentId: sent.messageId,
    uid: 'admin-1',
    claims: { admin: true },
  });
  check(
    'the mapped administrator can read the support messages',
    administratorMessageRead.status < 400,
    true,
  );

  const studentReplyId = 'student-support-reply';
  await db
    .collection('conversations')
    .doc(sent.conversationId)
    .collection('messages')
    .doc(studentReplyId)
    .set({
      messageId: studentReplyId,
      conversationId: sent.conversationId,
      senderId: 'student-1',
      receiverId: adminIdentity,
      content: 'I have updated the room details.',
      type: 'text',
      createdAt: firestore.Timestamp.now(),
      readAt: null,
      roomId: '',
      imageUrl: null,
    });
  await db.collection('users').doc('admin-1').update({
    fcmToken: 'admin-support-device-token',
  });
  const supportPushes = [];
  const supportMessagingGetter = messagingSdk.getMessaging;
  messagingSdk.getMessaging = () => ({
    send: async (message) => {
      supportPushes.push(message);
      return 'support-message-id';
    },
  });
  let replyNotification;
  try {
    replyNotification = await invoke(
      notifyUser,
      {
        userId: adminIdentity,
        type: 'newMessage',
        data: {
          conversationId: sent.conversationId,
          messageId: studentReplyId,
        },
      },
      'student-1',
    );
  } finally {
    messagingSdk.getMessaging = supportMessagingGetter;
  }
  check('the support reply creates a notification', replyNotification.created, true);
  const administratorReplyNotifications = await db
    .collection('notifications')
    .where('userId', '==', 'admin-1')
    .get();
  check(
    'the support reply notification is addressed to the real administrator',
    administratorReplyNotifications.size,
    1,
  );
  check(
    'the support reply notification points at the support conversation',
    administratorReplyNotifications.docs[0]?.get('data')?.conversationId,
    sent.conversationId,
  );
  check(
    'the support reply notification does not copy the private reply text',
    String(administratorReplyNotifications.docs[0]?.get('body') || '').includes(
      'I have updated the room details.',
    ),
    false,
  );
  check(
    'the support reply notification uses a generic administrator prompt',
    administratorReplyNotifications.docs[0]?.get('body'),
    'You have a new support reply.',
  );
  check('the support reply sends one device push', supportPushes.length, 1);
  check(
    'the support reply push does not copy the private reply text',
    String(supportPushes[0]?.notification?.body || '').includes(
      'I have updated the room details.',
    ),
    false,
  );
  check(
    'the support reply push data does not copy the private reply text',
    String(supportPushes[0]?.data?.body || '').includes(
      'I have updated the room details.',
    ),
    false,
  );
  const syntheticReplyNotifications = await db
    .collection('notifications')
    .where('userId', '==', adminIdentity)
    .get();
  check(
    'the support reply does not notify the synthetic identity',
    syntheticReplyNotifications.size,
    0,
  );

  const retried = await invoke(
    sendAdminMessage,
    {
      userId: 'student-1',
      content: 'Please update your room details.',
      requestId: 'admin-message-test-1',
    },
    'admin-1',
  );
  check('the administrator message retry is idempotent', retried.alreadySent, true);
  check(
    'the administrator message retry did not create a duplicate',
    (await db
      .collection('conversations')
      .doc(sent.conversationId)
      .collection('messages')
      .where('messageId', '==', sent.messageId)
      .get()).size,
    1,
  );

  await db.collection('roomReviews').doc('review-1').set({
    reviewId: 'review-1',
    reviewInstanceId: 'review-instance-1',
    roomId: 'room-1',
    studentId: 'student-1',
    ownerId: 'owner-1',
    rating: 1,
    comment: 'Moderate this review',
  });
  await expectDenied(
    'a student cannot delete an arbitrary review',
    () =>
      invoke(
        deleteAnyRoomReview,
        {
          reviewId: 'review-1',
          expectedReviewInstanceId: 'review-instance-1',
        },
        'student-1',
      ),
    'permission-denied',
  );
  const deleted = await invoke(
    deleteAnyRoomReview,
    {
      reviewId: 'review-1',
      expectedReviewInstanceId: 'review-instance-1',
    },
    'admin-1',
  );
  check('the administrator deletes the review', deleted.success, true);
  check(
    'the deleted review no longer exists',
    (await db.collection('roomReviews').doc('review-1').get()).exists,
    false,
  );
  const firstAuditSnapshot = await db
    .collection('reviewDeletionAudit')
    .where('reviewId', '==', 'review-1')
    .get();
  check(
    'the administrator moderation action is audited',
    firstAuditSnapshot.docs[0]?.get('deletedByAdminId'),
    'admin-1',
  );
  check(
    'the first moderation event keeps its review lifecycle',
    firstAuditSnapshot.docs[0]?.get('reviewInstanceId'),
    'review-instance-1',
  );
  const deletedAgain = await invoke(
    deleteAnyRoomReview,
    {
      reviewId: 'review-1',
      expectedReviewInstanceId: 'review-instance-1',
    },
    'admin-1',
  );
  check('the administrator deletion retry is idempotent', deletedAgain.alreadyDeleted, true);
  check(
    'the idempotent retry does not create another audit event',
    (await db.collection('reviewDeletionAudit').where('reviewId', '==', 'review-1').get()).size,
    1,
  );

  // The deterministic review id can be used again after a moderation. The
  // recreated review is a new lifecycle, so its later moderation must append
  // a new event instead of overwriting the first administrator's history.
  await seedUser('admin-2', 'admin');
  await db.collection('roomReviews').doc('review-1').set({
    reviewId: 'review-1',
    reviewInstanceId: 'review-instance-2',
    roomId: 'room-1',
    studentId: 'student-1',
    ownerId: 'owner-1',
    rating: 2,
    comment: 'Recreated review',
  });
  const deletedAgainLifecycle = await invoke(
    deleteAnyRoomReview,
    {
      reviewId: 'review-1',
      expectedReviewInstanceId: 'review-instance-2',
    },
    'admin-2',
  );
  check(
    'the recreated review can be deleted independently',
    deletedAgainLifecycle.success,
    true,
  );
  const auditEvents = await db
    .collection('reviewDeletionAudit')
    .where('reviewId', '==', 'review-1')
    .get();
  check('the recreated review has a separate audit event', auditEvents.size, 2);
  const firstEvent = auditEvents.docs.find(
    (event) => event.get('reviewInstanceId') === 'review-instance-1',
  );
  const secondEvent = auditEvents.docs.find(
    (event) => event.get('reviewInstanceId') === 'review-instance-2',
  );
  check(
    'the earlier moderation history is preserved',
    firstEvent?.get('deletedByAdminId'),
    'admin-1',
  );
  check(
    'the later moderation is attributed to the second administrator',
    secondEvent?.get('deletedByAdminId'),
    'admin-2',
  );
  const retriedSecondLifecycle = await invoke(
    deleteAnyRoomReview,
    {
      reviewId: 'review-1',
      expectedReviewInstanceId: 'review-instance-2',
    },
    'admin-2',
  );
  check(
    'the second lifecycle retry is idempotent',
    retriedSecondLifecycle.alreadyDeleted,
    true,
  );
  check(
    'the second lifecycle retry does not append another event',
    (await db.collection('reviewDeletionAudit').where('reviewId', '==', 'review-1').get()).size,
    2,
  );

  // The raw administrator uid is not a conversation participant. The
  // server-only conversation operation is therefore the durable mapping which
  // lets the administrator's own account cleanup discover and remove the
  // support channel.
  await deleteUserConversations('admin-1');
  check(
    'administrator cleanup removed the opaque support conversation',
    (await db.collection('conversations').doc(sent.conversationId).get()).exists,
    false,
  );
  check(
    'administrator cleanup removed the server-only conversation operation',
    (await db
      .collection(ADMIN_SUPPORT_CONVERSATION_OPERATIONS)
      .doc(sent.conversationId)
      .get()).exists,
    false,
  );
  check(
    'administrator cleanup removed the server-only delivery operation',
    (await db
      .collection('adminMessageNotificationOperations')
      .doc(sent.messageId)
      .get()).exists,
    false,
  );
  check(
    'administrator cleanup removed the recipient notification',
    (await db
      .collection('notifications')
      .where('userId', '==', 'student-1')
      .get()).size,
    0,
  );
}

async function testLegacyAdminSupportPrivacyMigration() {
  section('legacy support conversations migrate without exposing the administrator uid');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('student-1', 'student');

  const conversationId = 'ADMIN-LEGACY-SUPPORT';
  await db.collection('conversations').doc(conversationId).set({
    conversationId,
    participantIds: ['admin-1', 'student-1'],
    participantNames: {
      'admin-1': 'Admin',
      'student-1': 'Student',
    },
    conversationType: 'adminSupport',
    adminId: 'admin-1',
    adminVerified: true,
    createdByServer: true,
    roomId: '',
    roomTitle: 'StayServe Support',
    unreadCount: {
      'admin-1': 1,
      'student-1': 2,
    },
    createdAt: firestore.Timestamp.now(),
    updatedAt: firestore.Timestamp.now(),
  });
  await db
    .collection('conversations')
    .doc(conversationId)
    .collection('messages')
    .doc('legacy-admin-message')
    .set({
      messageId: 'legacy-admin-message',
      conversationId,
      senderId: 'admin-1',
      receiverId: 'student-1',
      content: 'Legacy administrator support message.',
      type: 'text',
      senderType: 'admin',
      adminVerified: true,
      adminId: 'admin-1',
      createdAt: firestore.Timestamp.now(),
    });
  await db
    .collection('conversations')
    .doc(conversationId)
    .collection('messages')
    .doc('legacy-student-reply')
    .set({
      messageId: 'legacy-student-reply',
      conversationId,
      senderId: 'student-1',
      receiverId: 'admin-1',
      content: 'Legacy student support reply.',
      type: 'text',
      createdAt: firestore.Timestamp.now(),
    });

  const legacyConversationRead = await readDocumentAsClient({
    collection: 'conversations',
    documentId: conversationId,
    uid: 'student-1',
    claims: {
      phone_number: '+919876500001',
      stayServeVerifiedPhone: '+919876500001',
    },
  });
  check(
    'a tenant cannot directly read a legacy raw-uid support conversation',
    legacyConversationRead.status >= 400,
    true,
  );
  const legacyMessageRead = await readDocumentAsClient({
    collection: `conversations/${conversationId}/messages`,
    documentId: 'legacy-admin-message',
    uid: 'student-1',
    claims: {
      phone_number: '+919876500001',
      stayServeVerifiedPhone: '+919876500001',
    },
  });
  check(
    'a tenant cannot directly read a legacy raw-uid support message',
    legacyMessageRead.status >= 400,
    true,
  );

  const legacyAdministratorInbox = await invoke(
    listAdminSupportConversations,
    {},
    'admin-1',
  );
  check(
    'the administrator inbox discovers and migrates a legacy support conversation',
    legacyAdministratorInbox.conversationIds,
    [conversationId],
  );
  check(
    'the migrated legacy conversation is mapped to the administrator',
    (await db
      .collection(ADMIN_SUPPORT_CONVERSATION_OPERATIONS)
      .doc(conversationId)
      .get()).get('adminUid'),
    'admin-1',
  );

  const tenantDetails = await invoke(
    getConversationInteractionDetails,
    { conversationId },
    'student-1',
  );
  check(
    'the tenant receives the opaque administrator peer after migration',
    tenantDetails.peerId,
    adminSupportIdentityFor('admin-1'),
  );
  check(
    'the tenant support response does not contain the raw administrator uid',
    JSON.stringify(tenantDetails).includes('admin-1'),
    false,
  );

  const migratedConversation = await db
    .collection('conversations')
    .doc(conversationId)
    .get();
  check(
    'the migrated support parent uses the opaque administrator identity',
    migratedConversation.get('adminId'),
    adminSupportIdentityFor('admin-1'),
  );
  check(
    'the migrated support parent has no raw administrator uid',
    JSON.stringify(migratedConversation.data() || {}).includes('admin-1'),
    false,
  );
  const migratedMessages = await db
    .collection('conversations')
    .doc(conversationId)
    .collection('messages')
    .get();
  check(
    'the migrated support messages have no raw administrator uid',
    migratedMessages.docs.some((message) =>
      JSON.stringify(message.data() || {}).includes('admin-1'),
    ),
    false,
  );
  const migratedOperation = await db
    .collection(ADMIN_SUPPORT_CONVERSATION_OPERATIONS)
    .doc(conversationId)
    .get();
  check(
    'the server-only mapping keeps the legacy administrator attribution',
    migratedOperation.get('adminUid'),
    'admin-1',
  );

  const administratorDetails = await invoke(
    getConversationInteractionDetails,
    { conversationId },
    'admin-1',
  );
  check(
    'the mapped administrator resolves the tenant after migration',
    administratorDetails.peerId,
    'student-1',
  );

  const migratedConversationRead = await readDocumentAsClient({
    collection: 'conversations',
    documentId: conversationId,
    uid: 'student-1',
    claims: {
      phone_number: '+919876500001',
      stayServeVerifiedPhone: '+919876500001',
    },
  });
  check(
    'the tenant can read the migrated opaque support conversation',
    migratedConversationRead.status < 400,
    true,
  );
  check(
    'the tenant-visible migrated conversation contains no raw administrator uid',
    JSON.stringify(migratedConversationRead.body || {}).includes('admin-1'),
    false,
  );
  const migratedMessageRead = await readDocumentAsClient({
    collection: `conversations/${conversationId}/messages`,
    documentId: 'legacy-admin-message',
    uid: 'student-1',
    claims: {
      phone_number: '+919876500001',
      stayServeVerifiedPhone: '+919876500001',
    },
  });
  check(
    'the tenant can read the migrated opaque support messages',
    migratedMessageRead.status < 400,
    true,
  );
  check(
    'the tenant-visible migrated message contains no raw administrator uid',
    JSON.stringify(migratedMessageRead.body || {}).includes('admin-1'),
    false,
  );
}

async function testReviewAndAdminMessagingEnforceLiveVerifiedPhone() {
  section('review and support operations enforce the live verified phone');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('student-1', 'student');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-LIVE-PHONE', 'owner-1');
  await seedRequest('JRQ-LIVE-PHONE', {
    roomId: 'RM-LIVE-PHONE',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'ownerConfirmed',
  });

  const originalGetUser = auth.getUser;
  auth.getUser = async (uid) => ({
    uid,
    email: `${uid}@example.test`,
    emailVerified: false,
    // The administrator is exempt from the tenant phone policy. The student
    // still has a stale Firestore grant, but Firebase Auth no longer has the
    // phone provider. The owner has a live phone with a server-issued proof.
    phoneNumber:
      uid === 'admin-1' || uid === 'student-1'
        ? null
        : '+919876500001',
    customClaims:
      uid === 'owner-1'
        ? { stayServeVerifiedPhone: '+919876500001' }
        : {},
    providerData:
      uid === 'owner-1'
        ? [
            { providerId: 'password' },
            { providerId: 'phone', phoneNumber: '+919876500001' },
          ]
        : [{ providerId: 'password' }],
  });

  try {
    await expectDenied(
      'a tenant with an unlinked live phone cannot read room reviews',
      () =>
        invoke(
          getRoomReviews,
          { roomId: 'RM-LIVE-PHONE' },
          'student-1',
        ),
      'permission-denied',
    );
    await expectDenied(
      'a tenant with an unlinked live phone cannot submit a review',
      () =>
        invoke(
          submitRoomReview,
          {
            roomId: 'RM-LIVE-PHONE',
            rating: 5,
            comment: 'This review must not be stored.',
          },
          'student-1',
        ),
      'permission-denied',
    );
    check(
      'the rejected review was not stored',
      (await db
        .collection('roomReviews')
        .where('roomId', '==', 'RM-LIVE-PHONE')
        .get()).size,
      0,
    );
    check(
      'the stale cached phone grant was revoked',
      (await db.collection('users').doc('student-1').get()).get('phoneVerified'),
      false,
    );

    await expectDenied(
      'an administrator cannot send support data to a tenant without a live phone',
      () =>
        invoke(
          sendAdminMessage,
          {
            userId: 'student-1',
            content: 'This support message must not be stored.',
            requestId: 'live-phone-rejected-message',
          },
          'admin-1',
        ),
      'permission-denied',
    );
    check(
      'the rejected support message was not stored',
      (await db.collection('conversations').get()).size,
      0,
    );
    check(
      'the rejected support message left no delivery operation',
      (await db.collection('adminMessageNotificationOperations').get()).size,
      0,
    );

    const accepted = await invoke(
      sendAdminMessage,
      {
        userId: 'owner-1',
        content: 'A support message for a live tenant.',
        requestId: 'live-phone-accepted-message',
      },
      'admin-1',
    );
    check(
      'an administrator without a tenant phone can message a live tenant',
      accepted.success,
      true,
    );
  } finally {
    auth.getUser = originalGetUser;
  }
}

async function testDurableAdminNotificationsAndReviewLifecyclePrivacy() {
  section('administrator notifications and review lifecycles are durable and private');

  await reset();
  await seedUser('admin-1', 'admin');
  await seedUser('admin-2', 'admin');
  await seedUser('student-1', 'student');
  await seedUser('student-2', 'student');
  await seedUser('owner-1', 'owner');
  await seedRoom('RM-PRIVATE', 'owner-1');
  await seedRequest('JRQ-PRIVATE', {
    roomId: 'RM-PRIVATE',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: 'ownerConfirmed',
  });

  const reviewId = 'REV-RM-PRIVATE-student-1';
  await db.collection('roomReviews').doc(reviewId).set({
    reviewId,
    reviewInstanceId: 'review-lifecycle-1',
    roomId: 'RM-PRIVATE',
    studentId: 'student-1',
    ownerId: 'owner-1',
    rating: 1,
    comment: 'Private review text',
    studentName: 'Alice',
    createdAt: firestore.Timestamp.now(),
    updatedAt: firestore.Timestamp.now(),
  });
  await db.collection('users').doc('student-1').update({ name: 'Alice' });

  // Model the notification and attribution created for the original 1/5
  // review. The edit must update this deterministic copy in place.
  const deterministicReviewNotificationId = reviewNotificationId(
    reviewId,
    'review-lifecycle-1',
    'owner-1',
  );
  const originalReviewNotificationCreatedAt = firestore.Timestamp.now();
  await db
    .collection('notifications')
    .doc(deterministicReviewNotificationId)
    .set({
      userId: 'owner-1',
      title: 'New review',
      body: 'Alice rated your room 1/5',
      type: 'review',
      data: { roomId: 'RM-PRIVATE' },
      read: false,
      createdAt: originalReviewNotificationCreatedAt,
    });
  await db
    .collection('notificationAttributions')
    .doc(deterministicReviewNotificationId)
    .set({
      notificationId: deterministicReviewNotificationId,
      userId: 'owner-1',
      sourceType: 'roomReview',
      sourceAuthorUid: 'student-1',
      sourceRecipientUid: 'owner-1',
      sourceId: 'review-lifecycle-1',
      sourceReviewId: reviewId,
      createdAt: firestore.Timestamp.now(),
      updatedAt: firestore.Timestamp.now(),
    });

  const unrelatedStudentView = await invoke(
    getRoomReviews,
    { roomId: 'RM-PRIVATE' },
    'student-2',
  );
  const unrelatedReview = unrelatedStudentView.reviews?.[0] || {};
  check(
    'an unrelated tenant cannot read the reviewer uid',
    unrelatedReview.studentId,
    '',
  );
  check(
    'an unrelated tenant sees an anonymized reviewer',
    unrelatedReview.studentName,
    'A student',
  );
  check(
    'an unrelated tenant receives an opaque review id',
    unrelatedReview.reviewId?.startsWith('PUBLIC-'),
    true,
  );

  const ownerView = await invoke(
    getRoomReviews,
    { roomId: 'RM-PRIVATE' },
    'owner-1',
  );
  check(
    'the room owner can identify the reviewer for moderation',
    ownerView.reviews?.[0]?.studentId,
    'student-1',
  );
  const adminView = await invoke(
    getRoomReviews,
    { roomId: 'RM-PRIVATE' },
    'admin-1',
  );
  check(
    'an administrator can identify the reviewer for moderation',
    adminView.reviews?.[0]?.studentId,
    'student-1',
  );

  await expectDenied(
    'a delayed moderation request cannot delete another lifecycle',
    () =>
      invoke(
        deleteAnyRoomReview,
        {
          reviewId,
          expectedReviewInstanceId: 'review-lifecycle-2',
        },
        'admin-1',
      ),
    'failed-precondition',
  );
  check(
    'the mismatched moderation request kept the current review',
    (await db.collection('roomReviews').doc(reviewId).get()).exists,
    true,
  );

  const edited = await invoke(
    submitRoomReview,
    {
      roomId: 'RM-PRIVATE',
      rating: 5,
      comment: 'Updated private review text',
      expectedReviewInstanceId: 'review-lifecycle-1',
    },
    'student-1',
  );
  check(
    'the student edit keeps the expected lifecycle',
    edited.reviewInstanceId,
    'review-lifecycle-1',
  );

  const reviewNotifications = await db
    .collection('notifications')
    .where('userId', '==', 'owner-1')
    .get();
  check(
    'the review owner receives one notification',
    reviewNotifications.size,
    1,
  );
  check(
    'the edited review keeps the deterministic notification id',
    reviewNotifications.docs[0]?.id,
    deterministicReviewNotificationId,
  );
  check(
    'the edited review notification contains the current rating',
    reviewNotifications.docs[0]?.get('body'),
    'Alice rated your room 5/5',
  );
  check(
    'the edited review notification keeps its original creation time',
    reviewNotifications.docs[0]?.get('createdAt')?.toMillis(),
    originalReviewNotificationCreatedAt.toMillis(),
  );
  check(
    'the review notification does not persist the comment',
    String(reviewNotifications.docs[0]?.get('body') || '').includes(
      'Updated private review text',
    ),
    false,
  );
  const reviewAttributions = await db
    .collection('notificationAttributions')
    .where('sourceReviewId', '==', reviewId)
    .get();
  check(
    'the review notification has server-only attribution',
    reviewAttributions.size,
    1,
  );
  check(
    'the review attribution names the reviewer author',
    reviewAttributions.docs[0]?.get('sourceAuthorUid'),
    'student-1',
  );
  check(
    'the edited review attribution keeps the same lifecycle',
    reviewAttributions.docs[0]?.get('sourceId'),
    'review-lifecycle-1',
  );

  await db.collection('notifications').doc('legacy-review-notification').set({
    userId: 'owner-1',
    title: 'New review',
    body: 'Private review text',
    type: 'review',
    data: { roomId: 'RM-PRIVATE', reviewId },
    read: false,
  });
  await invoke(
    deleteAnyRoomReview,
    {
      reviewId,
      expectedReviewInstanceId: 'review-lifecycle-1',
    },
    'admin-1',
  );
  check(
    'moderation removes a legacy notification copy of the review',
    (await db
      .collection('notifications')
      .doc('legacy-review-notification')
      .get()).exists,
    false,
  );
  check(
    'moderation removes the attributable review notification',
    (await db
      .collection('notifications')
      .where('userId', '==', 'owner-1')
      .get()).size,
    0,
  );
  check(
    'moderation removes the server-only review attribution',
    (await db
      .collection('notificationAttributions')
      .where('sourceReviewId', '==', reviewId)
      .get()).size,
    0,
  );

  await expectDenied(
    'a delayed student edit cannot resurrect a moderated review',
    () =>
      invoke(
        submitRoomReview,
        {
          roomId: 'RM-PRIVATE',
          rating: 4,
          comment: 'Late resurrection',
          expectedReviewInstanceId: 'review-lifecycle-1',
        },
        'student-1',
      ),
    'failed-precondition',
  );
  check(
    'the delayed edit did not recreate the review',
    (await db.collection('roomReviews').doc(reviewId).get()).exists,
    false,
  );

  // Recreate the review as a new lifecycle. A retry for the old lifecycle
  // remains idempotent, but it must not delete or report success for the new
  // one.
  await db.collection('roomReviews').doc(reviewId).set({
    reviewId,
    reviewInstanceId: 'review-lifecycle-2',
    roomId: 'RM-PRIVATE',
    studentId: 'student-1',
    ownerId: 'owner-1',
    rating: 3,
    comment: 'New lifecycle',
    studentName: 'Alice',
    createdAt: firestore.Timestamp.now(),
    updatedAt: firestore.Timestamp.now(),
  });
  const oldLifecycleRetry = await invoke(
    deleteAnyRoomReview,
    {
      reviewId,
      expectedReviewInstanceId: 'review-lifecycle-1',
    },
    'admin-2',
  );
  check(
    'a historical lifecycle retry is idempotent for another administrator',
    oldLifecycleRetry.alreadyDeleted,
    true,
  );
  check(
    'the historical retry did not delete the recreated review',
    (await db.collection('roomReviews').doc(reviewId).get()).exists,
    true,
  );
  await invoke(
    deleteAnyRoomReview,
    {
      reviewId,
      expectedReviewInstanceId: 'review-lifecycle-2',
    },
    'admin-2',
  );
  check(
    'each review lifecycle keeps its own moderation state',
    (await db
      .collection('reviewDeletionState')
      .where('reviewId', '==', reviewId)
      .get()).size,
    2,
  );

  // The administrator message notification is deterministic and contains no
  // copy of the private support text.
  await db
    .collection('users')
    .doc('student-1')
    .update({ fcmToken: 'device-token-1' });
  const originalGetMessaging = messagingSdk.getMessaging;
  const pushes = [];
  let failPush = true;
  messagingSdk.getMessaging = () => ({
    send: async (message) => {
      if (failPush) throw new Error('simulated FCM failure');
      pushes.push(message);
      return 'message-id';
    },
  });
  let sent;
  try {
    sent = await invoke(
      sendAdminMessage,
      {
        userId: 'student-1',
        content: 'This private support text must not be copied.',
        requestId: 'durable-admin-message-1',
      },
      'admin-1',
    );
  } finally {
    messagingSdk.getMessaging = originalGetMessaging;
  }
  check('the administrator message is stored', sent.success, true);
  const operationId = sent.messageId;
  const operationRef = db
    .collection('adminMessageNotificationOperations')
    .doc(operationId);
  const operation = await operationRef.get();
  check(
    'the delivery operation attributes the administrator author',
    operation.get('sourceAuthorUid'),
    'admin-1',
  );
  check(
    'the delivery operation keeps the push retryable',
    operation.get('pushDeliveryState'),
    'pending',
  );
  const adminNotifications = await db
    .collection('notifications')
    .where('userId', '==', 'student-1')
    .get();
  check(
    'the recipient gets one in-app administrator notification',
    adminNotifications.size,
    1,
  );
  check(
    'the administrator notification does not copy the message text',
    String(adminNotifications.docs[0]?.get('body') || '').includes(
      'This private support text must not be copied.',
    ),
    false,
  );

  // Simulate a failed in-app delivery. Retrying the original request must
  // repair the deterministic notification without duplicating the message.
  const notificationId = operation.get('notificationId');
  await db.collection('notifications').doc(notificationId).delete();
  await invoke(
    sendAdminMessage,
    {
      userId: 'student-1',
      content: 'This private support text must not be copied.',
      requestId: 'durable-admin-message-1',
    },
    'admin-1',
  );
  check(
    'the idempotent retry repairs the missing in-app notification',
    (await db.collection('notifications').doc(notificationId).get()).exists,
    true,
  );
  check(
    'the notification repair did not duplicate the message',
    (await db
      .collection('conversations')
      .doc(sent.conversationId)
      .collection('messages')
      .get()).size,
    1,
  );

  // A failed FCM delivery is also repairable by the same request id.
  failPush = false;
  messagingSdk.getMessaging = () => ({
    send: async (message) => {
      pushes.push(message);
      return 'message-id';
    },
  });
  try {
    await invoke(
      sendAdminMessage,
      {
        userId: 'student-1',
        content: 'This private support text must not be copied.',
        requestId: 'durable-admin-message-1',
      },
      'admin-1',
    );
  } finally {
    messagingSdk.getMessaging = originalGetMessaging;
  }
  check('the FCM retry delivered one device push', pushes.length, 1);
  check(
    'the durable operation records the successful push',
    (await operationRef.get()).get('pushDeliveryState'),
    'delivered',
  );

  // A delayed retry cannot recreate a notification after the administrator
  // has been fenced.
  await db.collection('notifications').doc(notificationId).delete();
  await db.collection('users').doc('admin-1').update({ isActive: false });
  await expectDenied(
    'a fenced administrator cannot retry the delayed message',
    () =>
      invoke(
        sendAdminMessage,
        {
          userId: 'student-1',
          content: 'This private support text must not be copied.',
          requestId: 'durable-admin-message-1',
        },
        'admin-1',
      ),
    'permission-denied',
  );
  check(
    'a fenced administrator cannot recreate a delayed notification',
    (await db.collection('notifications').doc(notificationId).get()).exists,
    false,
  );
  await db.collection('users').doc('admin-1').update({ isActive: true });

  // Account cleanup removes notification copies attributed to the deleted
  // author, including copies addressed to somebody else.
  await invoke(
    sendAdminMessage,
    {
      userId: 'student-1',
      content: 'A second support message.',
      requestId: 'durable-admin-message-2',
    },
    'admin-1',
  );
  const secondNotification = await db
    .collection('notifications')
    .where('userId', '==', 'student-1')
    .get();
  check(
    'the second administrator message has a recipient notification',
    secondNotification.size,
    1,
  );
  await deleteAttributedNotificationsForUser('admin-1');
  check(
    'account cleanup removes a notification attributed to the author',
    (await db
      .collection('notifications')
      .where('userId', '==', 'student-1')
      .get()).size,
    0,
  );
  check(
    'account cleanup removes the administrator delivery operation',
    (await db
      .collection('adminMessageNotificationOperations')
      .where('sourceAuthorUid', '==', 'admin-1')
      .get()).size,
    0,
  );
}

async function testUserProfileBootstrapRepairsMalformedFcmDocument() {
  section('the Auth bootstrap repairs a malformed FCM-only profile');

  await reset();
  const profileRef = db.collection('users').doc('bootstrap-user');
  await profileRef.set({
    fcmToken: 'device-token',
    updatedAt: firestore.Timestamp.now(),
  });

  const result = await ensureUserProfile({
    uid: 'bootstrap-user',
    displayName: 'Bootstrap User',
    email: 'bootstrap@example.test',
    emailVerified: true,
    phoneNumber: '+919876500001',
    providerData: [{ providerId: 'google.com' }, { providerId: 'phone' }],
  });
  const profile = await profileRef.get();

  check('the malformed profile was repaired', result, 'repaired');
  check('the repaired profile has the account uid', profile.get('uid'), 'bootstrap-user');
  check('the repaired profile has a display name', profile.get('name'), 'Bootstrap User');
  check(
    'the repaired profile has the live email',
    profile.get('email'),
    'bootstrap@example.test',
  );
  check(
    'the repaired profile has the live verification state',
    profile.get('emailVerified'),
    true,
  );
  check(
    'the repaired profile has the live phone',
    profile.get('phone'),
    '+919876500001',
  );
  check(
    'the repaired profile has the live phone verification state',
    profile.get('phoneVerified'),
    false,
  );
  check(
    'a linked phone without a server proof is not marked verified',
    profile.get('phoneVerifiedAt') == null,
    true,
  );
  check('the repaired profile has the live providers', profile.get('authProviders'), [
    'google.com',
    'phone',
  ]);
  check('the repaired profile has the default role', profile.get('role'), 'student');
  check(
    'the repaired profile has an explicit unclaimed role marker',
    profile.get('roleClaimed'),
    false,
  );
  check(
    'the repaired profile has an explicit inactive-state marker',
    profile.get('isActive'),
    true,
  );
  check(
    'the repaired profile has an explicit registration marker',
    profile.get('registrationCompleted'),
    false,
  );
  check('the repaired profile kept the FCM token', profile.get('fcmToken'), 'device-token');
  check('the repaired profile has a creation timestamp', profile.get('createdAt') !== undefined, true);

  const retryResult = await ensureUserProfile({
    uid: 'bootstrap-user',
    displayName: 'Bootstrap User',
    email: 'bootstrap@example.test',
    emailVerified: true,
    phoneNumber: '+919876500001',
    providerData: [{ providerId: 'google.com' }, { providerId: 'phone' }],
  });
  check('a trigger retry preserves the complete profile', retryResult, 'preserved');

  // A profile which was repaired after the account already completed the
  // phone challenge keeps its verified state: the server-issued proof is
  // read from the signed claim (or the durable proof document).
  await ensureUserProfile({
    uid: 'proven-bootstrap-user',
    displayName: 'Proven Bootstrap User',
    email: 'proven-bootstrap@example.test',
    emailVerified: true,
    phoneNumber: '+919876500002',
    customClaims: { stayServeVerifiedPhone: '+919876500002' },
    providerData: [
      { providerId: 'google.com' },
      { providerId: 'phone', phoneNumber: '+919876500002' },
    ],
  });
  const provenProfile = await db
    .collection('users')
    .doc('proven-bootstrap-user')
    .get();
  check(
    'a repaired profile keeps a proven phone verified',
    provenProfile.get('phoneVerified'),
    true,
  );
  check(
    'a repaired profile records when the phone was verified',
    provenProfile.get('phoneVerifiedAt') !== undefined,
    true,
  );

  const forgedAdminRef = db.collection('users').doc('forged-admin');
  await forgedAdminRef.set({
    fcmToken: 'another-token',
    role: 'admin',
    roleClaimed: true,
  });
  await ensureUserProfile({
    uid: 'forged-admin',
    email: 'forged@example.test',
    emailVerified: false,
    phoneNumber: null,
    providerData: [{ providerId: 'password' }],
  });
  const forgedAdmin = await forgedAdminRef.get();
  check(
    'a client-written admin role is not preserved',
    forgedAdmin.get('role'),
    'student',
  );
  check(
    'a client-written admin role is not treated as claimed',
    forgedAdmin.get('roleClaimed'),
    false,
  );
  check(
    'a client-written admin role does not complete registration',
    forgedAdmin.get('registrationCompleted'),
    false,
  );
}

async function testIncompleteRegistrationRollback() {
  section('an incomplete registration can be rolled back safely');

  await reset();
  await db.collection('users').doc('incomplete-user').set({
    uid: 'incomplete-user',
    role: 'student',
    roleClaimed: false,
    registrationCompleted: false,
    isActive: true,
    createdAt: firestore.Timestamp.now(),
  });
  await db.collection('users').doc('complete-user').set({
    uid: 'complete-user',
    role: 'student',
    roleClaimed: true,
    registrationCompleted: true,
    isActive: true,
    createdAt: firestore.Timestamp.now(),
  });

  const originalDeleteUser = auth.deleteUser;
  const deletedUids = [];
  auth.deleteUser = async (uid) => {
    deletedUids.push(uid);
  };
  try {
    await expectDenied(
      'a rollback cannot target a different account',
      () =>
        invoke(
          rollbackIncompleteRegistration,
          { uid: 'another-user' },
          'incomplete-user',
        ),
      'failed-precondition',
    );
    check(
      'the mismatched rollback did not delete an Auth account',
      deletedUids,
      [],
    );

    const rolledBack = await invoke(
      rollbackIncompleteRegistration,
      { uid: 'incomplete-user' },
      'incomplete-user',
    );
    check('the incomplete account was rolled back', rolledBack.rolledBack, true);
    check(
      'the rollback deleted only the incomplete Auth account',
      deletedUids,
      ['incomplete-user'],
    );
    check(
      'the rollback left a durable server-only marker',
      (await db
        .collection('registrationRollbackOperations')
        .doc('incomplete-user')
        .get()).get('status'),
      'authDeleted',
    );

    const completed = await invoke(
      rollbackIncompleteRegistration,
      { uid: 'complete-user' },
      'complete-user',
    );
    check('a committed registration is not rolled back', completed.rolledBack, false);
    check(
      'the committed Auth account was kept',
      deletedUids,
      ['incomplete-user'],
    );
    check(
      'the committed registration was reported as complete',
      completed.registrationCompleted,
      true,
    );
  } finally {
    auth.deleteUser = originalDeleteUser;
  }

  // A rollback marker which wins the race prevents the registration
  // transaction from committing the account afterwards.
  await db.collection('users').doc('race-user').set({
    uid: 'race-user',
    role: 'student',
    roleClaimed: false,
    registrationCompleted: false,
    isActive: true,
    createdAt: firestore.Timestamp.now(),
  });
  await db.collection('registrationRollbackOperations').doc('race-user').set({
    uid: 'race-user',
    status: 'rollbackRequested',
  });
  const originalGetUser = auth.getUser;
  auth.getUser = async (uid) => ({
    uid,
    email: null,
    emailVerified: false,
    phoneNumber: '+919876500001',
    providerData: [{ providerId: 'phone' }],
  });
  try {
    await expectDenied(
      'a rolled-back registration cannot complete afterwards',
      () =>
        invoke(
          completeRegistration,
          { name: 'Race User', role: 'student' },
          'race-user',
        ),
      'failed-precondition',
    );
  } finally {
    auth.getUser = originalGetUser;
  }
  check(
    'the rolled-back profile did not become complete',
    (await db.collection('users').doc('race-user').get()).get(
      'registrationCompleted',
    ),
    false,
  );
}

async function main() {
  await testPhoneAndGoogleRegistrationIdentities();
  await testUserProfileBootstrapRepairsMalformedFcmDocument();
  await testAuthProfileSyncAndEmailLink();
  await testConcurrentEmailLinksAreSerialized();
  await testIncompleteRegistrationRollback();
  await testSupportRepliesUseTheTrustedRoute();
  await testLegacyAdminUnreadCounterSurvivesTheConversion();
  await testSupportReplyNotificationDeliveryIsRetryable();
  await testDraftListingsArePublishedByTheServer();
  await testAdminMessagingAndReviewDeletion();
  await testLegacyAdminSupportPrivacyMigration();
  await testReviewAndAdminMessagingEnforceLiveVerifiedPhone();
  await testDurableAdminNotificationsAndReviewLifecyclePrivacy();
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
  await testAccountCleanupRemovesReviewNotificationDependents();
  await testAccountDeletionPreservesPendingRegistrationRollback();
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
