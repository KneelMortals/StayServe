// Regression tests for the StayServe Firestore security rules.
//
// The emulator accepts an unsigned JWT in the Authorization header.  The
// `sub` claim is request.auth.uid and the other claims are exposed as
// request.auth.token.  The `owner` token is the emulator's administrative
// token and is used only to seed and clean up test data.
//
// IMPORTANT: a real, freshly-created account has no custom claims at all.
// The tests therefore use tokens without an `admin` claim for ordinary
// accounts and exercise the optional-claim lint separately.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES_FILE = process.argv[4] || path.resolve(HERE, '..', 'firestore.rules');

const PORT = process.argv[2] || '8181';
const PROJECT = process.argv[3] || 'demo-stayserve-rules';
const HOST = `http://127.0.0.1:${PORT}/v1/projects/${PROJECT}/databases/(default)/documents`;

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function jwt(claims) {
  // The emulator only decodes the payload.
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.`;
}

const OPAQUE_ADMIN_IDENTITY = 'adminIdentities/support/profile';

/**
 * A tenant token with the signed verified-phone proof.
 *
 * The rules require the server-issued `stayServeVerifiedPhone` claim to
 * match the live `phone_number` claim. A token which only carries a phone
 * number is not enough: the Admin SDK can attach a number without the SMS
 * challenge ever being completed.
 */
function tenantToken(uid, role, phoneNumber) {
  return jwt({
    sub: uid,
    user_id: uid,
    role,
    phone_number: phoneNumber,
    stayServeVerifiedPhone: phoneNumber,
  });
}

const TOKENS = {
  student: tenantToken('student1', 'student', '+919876500001'),
  student2: tenantToken('student2', 'student', '+919876500002'),
  bootstrap: tenantToken('student-bootstrap', 'student', '+919876500003'),
  bootstrapMissingMarker: tenantToken('student-bootstrap-missing', 'student', '+919876500004'),
  bootstrapOldProfile: tenantToken('student-bootstrap-old', 'student', '+919876500005'),
  bootstrapInactive: tenantToken('student-bootstrap-inactive', 'student', '+919876500006'),
  bootstrapRoleClaimed: tenantToken('student-bootstrap-role-claimed', 'student', '+919876500007'),
  owner: tenantToken('owner1', 'owner', '+919876500008'),
  admin: jwt({ sub: 'admin1', user_id: 'admin1', role: 'admin', admin: true }),
  // A stale/forged admin claim without a live admin profile must not work.
  fakeAdmin: jwt({ sub: 'fakeAdmin1', user_id: 'fakeAdmin1', role: 'student', admin: true }),
  stranger: tenantToken('someoneelse', 'student', '+919876500009'),
  pending: tenantToken('pending1', 'student', '+919876500010'),
  inactive: tenantToken('inactive1', 'student', '+919876500011'),
  unverifiedPhone: jwt({ sub: 'unverifiedPhone1', user_id: 'unverifiedPhone1', role: 'student' }),
  studentWithoutPhoneToken: jwt({ sub: 'student-without-phone-token', user_id: 'student-without-phone-token', role: 'student' }),
  studentWithEmptyPhoneToken: jwt({ sub: 'student-with-empty-phone-token', user_id: 'student-with-empty-phone-token', role: 'student', phone_number: '' }),
  // A number which an administrator attached with the Admin SDK carries the
  // phone attribute but no server-issued proof.
  adminProvisionedPhone: jwt({ sub: 'admin-provisioned', user_id: 'admin-provisioned', role: 'student', phone_number: '+919876500013' }),
  legacy: tenantToken('legacy1', 'student', '+919876500012'),
};

async function call(token, method, requestPath, body) {
  const res = await fetch(`${HOST}${requestPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function callAnon(method, requestPath, body) {
  const res = await fetch(`${HOST}${requestPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// A missing document is an allowed read (the permission check passed and
// the answer is simply NOT_FOUND).
async function readAllowed(token, requestPath) {
  const result = await call(token, 'GET', requestPath);
  if (result.status === 404) {
    return { status: 200, body: { note: 'document does not exist' } };
  }
  return result;
}

async function readAllowedAnon(requestPath) {
  const result = await callAnon('GET', requestPath);
  if (result.status === 404) {
    return { status: 200, body: { note: 'document does not exist' } };
  }
  return result;
}

function reason(result) {
  const error = result.body?.error;
  if (!error) return `HTTP ${result.status}`;
  return `${error.status || error.code}: ${error.message}`;
}

let pass = 0;
let fail = 0;

function check(label, actual, expectedOk) {
  const ok = expectedOk ? actual.status < 400 : actual.status >= 400;
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}  (${reason(actual)})`);
  } else {
    fail++;
    console.log(
      `  FAIL  ${label}  expected ${expectedOk ? 'allow' : 'deny'} but got ${reason(actual)}`,
    );
  }
}

function checkCondition(label, condition) {
  if (condition) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}

function updateMask(fields) {
  return Object.keys(fields)
    .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
    .join('&');
}

async function update(token, collection, id, fields) {
  const mask = updateMask(fields);
  return call(
    token,
    'PATCH',
    `/${collection}/${id}${mask ? `?${mask}` : ''}`,
    { fields },
  );
}

async function create(token, collection, id, fields) {
  return call(token, 'PATCH', `/${collection}/${id}`, { fields });
}

function timestamp(value = new Date().toISOString()) {
  return { timestampValue: value };
}

function string(value) {
  return { stringValue: String(value) };
}

function bool(value) {
  return { booleanValue: Boolean(value) };
}

function integer(value) {
  return { integerValue: String(value) };
}

function double(value) {
  return { doubleValue: Number(value) };
}

function array(values) {
  return { arrayValue: { values: values.map(string) } };
}

function mixedArray(values) {
  return {
    arrayValue: {
      values: values.map((value) =>
        typeof value === 'string' ? string(value) : integer(value),
      ),
    },
  };
}

function map(values) {
  return { mapValue: { fields: values } };
}

async function seedUser(uid, {
  role = 'student',
  isActive = true,
  registrationCompleted = true,
  emailVerified = true,
  phoneVerified = true,
  createdAt = new Date().toISOString(),
  includeMarkers = true,
  includePhoneVerification = true,
} = {}) {
  const fields = {
    uid: string(uid),
    name: string(uid === 'admin1' ? 'Admin' : uid),
    email: string(`${uid}@example.com`),
    emailVerified: bool(emailVerified),
    phone: string(`+9198765${String(uid).replace(/\D/g, '').padStart(5, '0').slice(-5)}`),
    authProviders: array([role === 'admin' ? 'admin' : 'password']),
    role: string(role),
    createdAt: timestamp(createdAt),
    updatedAt: timestamp(),
  };
  if (includePhoneVerification) {
    fields.phoneVerified = bool(phoneVerified);
  }
  if (includeMarkers) {
    fields.isActive = bool(isActive);
    fields.registrationCompleted = bool(registrationCompleted);
  }
  const result = await call('owner', 'PATCH', `/users/${uid}`, { fields });
  if (result.status >= 400) {
    throw new Error(`seed user ${uid} failed: ${reason(result)}`);
  }
}

async function seedRoom(id = 'room1', ownerId = 'owner1') {
  const result = await call('owner', 'PATCH', `/rooms/${id}`, {
    fields: {
      roomId: string(id),
      ownerId: string(ownerId),
      title: string('Test Room'),
      description: string('A room for the rules test'),
      monthlyRent: double(10000),
      securityDeposit: double(5000),
      location: map({
        address: string('Test Street'),
        city: string('Bengaluru'),
        state: string('Karnataka'),
        pincode: string('560001'),
      }),
      roomType: string('single'),
      furnishing: string('unfurnished'),
      availableFrom: timestamp(),
      amenities: array(['Wi-Fi']),
      occupancy: integer(2),
      currentOccupancy: integer(0),
      genderPreference: string('any'),
      images: array([]),
      status: string('available'),
      listingGeneration: string(`server-generation-${id}`),
      createdAt: timestamp(),
      updatedAt: timestamp(),
      latitude: double(12.9716),
      longitude: double(77.5946),
      homeId: string('home1'),
      homeName: string('Test Home'),
    },
  });
  if (result.status >= 400) {
    throw new Error(`seed room ${id} failed: ${reason(result)}`);
  }
}

async function seed() {
  // The migration switch is an Admin-SDK-only document.  The emulator's
  // owner token bypasses rules, which is equivalent to that Admin SDK write.
  const cutoff = new Date();
  await call('owner', 'PATCH', '/system/registration', {
    fields: {
      legacyMode: bool(true),
      legacyCutoff: timestamp(cutoff.toISOString()),
    },
  });
  // The exact-location compatibility switch starts closed. The staged
  // migration may open it temporarily while old app versions are retired.
  await call('owner', 'PATCH', '/system/locationPrivacy', {
    fields: { allowClientExactLocationWrites: bool(false) },
  });

  await seedUser('student1');
  await seedUser('student2');
  await seedUser('owner1', { role: 'owner' });
  await seedUser('admin1', { role: 'admin', phoneVerified: false });
  await seedUser('fakeAdmin1');
  await seedUser('someoneelse');
  await seedUser('pending1', { registrationCompleted: false });
  await seedUser('inactive1', { isActive: false });
  await seedUser('unverifiedPhone1', {
    emailVerified: false,
    phoneVerified: false,
  });
  // The Firestore cache says the phone was verified, but the current Auth
  // token has no phone provider. This is the stale-grant case which the rules
  // must refuse.
  await seedUser('student-without-phone-token');
  await seedUser('student-with-empty-phone-token');

  // This is the shape of an old profile which predates both marker fields and
  // the server-owned phone cache. Its creation time is before the migration
  // cutoff, so it is usable only while legacyMode is true. The current token
  // proves that Firebase still has a linked phone.
  await seedUser('legacy1', {
    includeMarkers: false,
    includePhoneVerification: false,
    createdAt: new Date(cutoff.getTime() - 60 * 60 * 1000).toISOString(),
  });

  await seedRoom();
  await seedRoom('room-private-missing');
  await seedRoom('room-private-mismatch');
  await seedRoom('room-deleting');

  // The server reserves a deleted room id until its old Storage objects and
  // reviews have really been removed. The client cannot write the tombstone,
  // but its existence must block a new listing with the same id.
  await call('owner', 'PATCH', '/roomDeletionTombstones/room-reserved', {
    fields: {
      type: string('roomDeletionTombstone'),
      roomId: string('room-reserved'),
      ownerId: string('owner1'),
      listingGeneration: string('server-generation-old'),
      deletionOperationId: string('operation-old'),
      createdAt: timestamp(),
    },
  });
  await call('owner', 'PATCH', '/roomDeletionTombstones/room-admin-tombstone', {
    fields: {
      type: string('roomDeletionTombstone'),
      roomId: string('room-admin-tombstone'),
      ownerId: string('owner1'),
      listingGeneration: string('server-generation-old'),
      deletionOperationId: string('operation-old'),
      createdAt: timestamp(),
    },
  });
  await call(
    'owner',
    'PATCH',
    '/rooms/room-deleting?updateMask.fieldPaths=deletionInProgress',
    {
      fields: { deletionInProgress: bool(true) },
    },
  );
  await create('owner', 'roomPrivate', 'room1', {
    roomId: string('room1'),
    ownerId: string('owner1'),
    address: string('Test Street'),
    city: string('Bengaluru'),
    state: string('Karnataka'),
    pincode: string('560001'),
    latitude: double(12.9716),
    longitude: double(77.5946),
    updatedAt: timestamp(),
  });
  await create('owner', 'roomPrivate', 'room-private-mismatch', {
    roomId: string('room-private-mismatch'),
    // Deliberately corrupt. The public listing owner is canonical and the
    // account named here must not gain access to the exact location.
    ownerId: string('someoneelse'),
    address: string('Mismatched Owner Street'),
    city: string('Bengaluru'),
    state: string('Karnataka'),
    pincode: string('560001'),
    latitude: double(12.9716),
    longitude: double(77.5946),
    updatedAt: timestamp(),
  });

  // This room has two server-owned occupants.  It is used to verify that
  // an owner cannot reduce the advertised capacity below that count.
  await call('owner', 'PATCH', '/rooms/room-occupied', {
    fields: {
      roomId: string('room-occupied'),
      ownerId: string('owner1'),
      title: string('Occupied room'),
      monthlyRent: double(10000),
      occupancy: integer(2),
      currentOccupancy: integer(2),
      status: string('occupied'),
      createdAt: timestamp(),
      updatedAt: timestamp(),
    },
  });

  await call('owner', 'PATCH', '/joinRequests/JRQ-TEST-1', {
    fields: {
      requestId: string('JRQ-TEST-1'),
      roomId: string('room1'),
      studentId: string('student1'),
      ownerId: string('owner1'),
      status: string('pending'),
      monthlyRentAtJoin: double(10000),
      commissionPercentageAtJoin: double(30),
      createdAt: timestamp(),
      updatedAt: timestamp(),
      advancePaid: bool(false),
      advancePaymentStatus: { nullValue: null },
    },
  });

  await call('owner', 'PATCH', '/payments/JRQ-TEST-1', {
    fields: {
      requestId: string('JRQ-TEST-1'),
      studentId: string('student1'),
      ownerId: string('owner1'),
      roomId: string('room1'),
      amount: double(3000),
      status: string('submitted'),
      submittedAt: timestamp(),
    },
  });

  await call('owner', 'PATCH', '/commissionInvoices/INV-TEST-1', {
    fields: {
      invoiceId: string('INV-TEST-1'),
      roomId: string('room1'),
      ownerId: string('owner1'),
      tenantId: string('student1'),
      joinRequestId: string('JRQ-TEST-1'),
      monthlyRent: double(10000),
      commissionPercentage: double(30),
      commissionAmount: double(3000),
      status: string('pending'),
      createdAt: timestamp(),
      updatedAt: timestamp(),
    },
  });
  await call('owner', 'PATCH', '/commissionInvoices/INV-CANCEL-TEST', {
    fields: {
      invoiceId: string('INV-CANCEL-TEST'),
      roomId: string('room1'),
      ownerId: string('owner1'),
      tenantId: string('student1'),
      joinRequestId: string('JRQ-TEST-1'),
      monthlyRent: double(10000),
      commissionPercentage: double(30),
      commissionAmount: double(3000),
      status: string('pending'),
      createdAt: timestamp(),
      updatedAt: timestamp(),
    },
  });

  await call('owner', 'PATCH', '/notifications/n-own', {
    fields: {
      userId: string('student1'),
      title: string('Test notification'),
      body: string('Test body'),
      type: string('general'),
      data: map({ requestId: string('JRQ-TEST-1') }),
      read: bool(false),
      createdAt: timestamp(),
    },
  });
  await call('owner', 'PATCH', '/notifications/n-other', {
    fields: {
      userId: string('someoneelse'),
      title: string('Other notification'),
      body: string('Other body'),
      type: string('general'),
      read: bool(false),
      createdAt: timestamp(),
    },
  });

  await call('owner', 'PATCH', '/roomReviews/REV-TEST-1', {
    fields: {
      reviewId: string('REV-TEST-1'),
      roomId: string('room1'),
      studentId: string('student1'),
      ownerId: string('owner1'),
      rating: integer(5),
      comment: string('Good room'),
    },
  });

  await call('owner', 'PATCH', '/conversations/conv1', {
    fields: {
      conversationId: string('conv1'),
      participantIds: array(['student1', 'owner1']),
      lastMessage: string('hello'),
      createdAt: timestamp(),
      updatedAt: timestamp(),
      unreadCount: map({ student1: integer(0), owner1: integer(0) }),
    },
  });
  await call('owner', 'PATCH', '/conversations/conv-deleting', {
    fields: {
      conversationId: string('conv-deleting'),
      participantIds: array(['student1', 'owner1']),
      createdAt: timestamp(),
      updatedAt: timestamp(),
      deletionInProgress: bool(true),
    },
  });
  await call('owner', 'PATCH', '/conversations/conv1/messages/msg1', {
    fields: {
      messageId: string('msg1'),
      conversationId: string('conv1'),
      senderId: string('owner1'),
      receiverId: string('student1'),
      content: string('hello'),
      createdAt: timestamp(),
    },
  });

  await call('owner', 'PATCH', '/conversations/conv-admin', {
    fields: {
      conversationId: string('conv-admin'),
      participantIds: array(['admin1', 'student1']),
      conversationType: string('adminSupport'),
      adminId: string('admin1'),
      adminVerified: bool(true),
      createdByServer: bool(true),
      createdAt: timestamp(),
      updatedAt: timestamp(),
      unreadCount: map({ admin1: integer(0), student1: integer(0) }),
    },
  });
  await call(
    'owner',
    'PATCH',
    '/conversations/conv-admin/messages/msg-legacy-raw-admin',
    {
      fields: {
        messageId: string('msg-legacy-raw-admin'),
        conversationId: string('conv-admin'),
        senderId: string('admin1'),
        receiverId: string('student1'),
        content: string('Legacy administrator message.'),
        type: string('text'),
        createdAt: timestamp(),
      },
    },
  );
  await call('owner', 'PATCH', '/conversations/conv-admin-owner', {
    fields: {
      conversationId: string('conv-admin-owner'),
      participantIds: array(['admin1', 'owner1']),
      conversationType: string('adminSupport'),
      adminId: string('admin1'),
      adminVerified: bool(true),
      createdByServer: bool(true),
      createdAt: timestamp(),
      updatedAt: timestamp(),
      unreadCount: map({ admin1: integer(0), owner1: integer(0) }),
    },
  });

  const opaqueAdminIdentity = OPAQUE_ADMIN_IDENTITY;
  await call('owner', 'PATCH', '/conversations/conv-admin-opaque', {
    fields: {
      conversationId: string('conv-admin-opaque'),
      participantIds: array([opaqueAdminIdentity, 'student1']),
      conversationType: string('adminSupport'),
      adminId: string(opaqueAdminIdentity),
      adminVerified: bool(true),
      createdByServer: bool(true),
      createdAt: timestamp(),
      updatedAt: timestamp(),
      unreadCount: map({
        [opaqueAdminIdentity]: integer(1),
        student1: integer(1),
      }),
    },
  });
  await call(
    'owner',
    'PATCH',
    '/conversations/conv-admin-opaque/messages/msg-admin-opaque',
    {
      fields: {
        messageId: string('msg-admin-opaque'),
        conversationId: string('conv-admin-opaque'),
        senderId: string(opaqueAdminIdentity),
        receiverId: string('student1'),
        content: string('Please update your room details.'),
        type: string('text'),
        createdAt: timestamp(),
      },
    },
  );
  await call(
    'owner',
    'PATCH',
    '/adminSupportConversationOperations/conv-admin-opaque',
    {
      fields: {
        operationId: string('conv-admin-opaque'),
        conversationId: string('conv-admin-opaque'),
        adminUid: string('admin1'),
        adminIdentity: string(opaqueAdminIdentity),
        targetUid: string('student1'),
        sourceType: string('adminSupportConversation'),
        createdAt: timestamp(),
      },
    },
  );

  await call(
    'owner',
    'PATCH',
    '/conversations/conv-admin-opaque-owner',
    {
      fields: {
        conversationId: string('conv-admin-opaque-owner'),
        participantIds: array([opaqueAdminIdentity, 'owner1']),
        conversationType: string('adminSupport'),
        adminId: string(opaqueAdminIdentity),
        adminVerified: bool(true),
        createdByServer: bool(true),
        createdAt: timestamp(),
        updatedAt: timestamp(),
        unreadCount: map({ owner1: integer(0) }),
      },
    },
  );
  await call(
    'owner',
    'PATCH',
    '/adminSupportConversationOperations/conv-admin-opaque-owner',
    {
      fields: {
        operationId: string('conv-admin-opaque-owner'),
        conversationId: string('conv-admin-opaque-owner'),
        adminUid: string('admin1'),
        adminIdentity: string(opaqueAdminIdentity),
        targetUid: string('owner1'),
        sourceType: string('adminSupportConversation'),
        createdAt: timestamp(),
      },
    },
  );

  await call('owner', 'PATCH', '/settings/platform', {
    fields: { commissionPercentage: double(30), updatedAt: timestamp() },
  });
  await call('owner', 'PATCH', '/publicSettings/platform', {
    fields: { maintenanceMode: bool(false), updatedAt: timestamp() },
  });
}

/**
 * Static check for optional custom claims.
 *
 * Reading a missing map key with `request.auth.token.admin` raises an
 * evaluation error in production.  The emulator absorbs that error, so a
 * lint is the only reliable guard against accidentally locking out every
 * account which has no custom claim.
 */
function lintOptionalClaims(file) {
  const raw = readFileSync(file, 'utf8');
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

  const problems = [];
  const claim = /request\.auth\.token\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let match;
  while ((match = claim.exec(source)) !== null) {
    const name = match[1];
    const after = source[match.index + match[0].length];
    if (after === '(') continue;
    const line = source.slice(0, match.index).split('\n').length;
    problems.push(
      `line ${line}: direct access to the optional claim '${name}' — ` +
        `use request.auth.token.get('${name}', <default>) instead`,
    );
  }
  return problems;
}

async function filteredList(token, collection, field, value, orderBy = 'createdAt') {
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: {
        fieldFilter: {
          field: { fieldPath: field },
          op: 'EQUAL',
          value: string(value),
        },
      },
      orderBy: [{ field: { fieldPath: orderBy }, direction: 'DESCENDING' }],
    },
  };
  const res = await fetch(
    `http://127.0.0.1:${PORT}/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  return { status: res.status, body: text };
}

async function main() {
  console.log('--- lint: optional custom claims ---');
  const lintProblems = lintOptionalClaims(RULES_FILE);
  if (lintProblems.length === 0) {
    pass++;
    console.log(`  PASS  ${RULES_FILE} reads every custom claim safely`);
  } else {
    fail++;
    lintProblems.forEach((problem) => console.log(`  FAIL  ${problem}`));
  }

  console.log('\n--- seeding live, pending, inactive, and legacy profiles ---');
  await seed();

  console.log('\n--- account state is required for protected access ---');
  check(
    'pending account cannot read a room',
    await call(TOKENS.pending, 'GET', '/rooms/room1'),
    false,
  );
  check(
    'inactive account cannot read a room',
    await call(TOKENS.inactive, 'GET', '/rooms/room1'),
    false,
  );
  check(
    'legacy account can use the transitional path during migration',
    await call(TOKENS.legacy, 'GET', '/rooms/room1'),
    true,
  );
  check(
    'pending account cannot create a room',
    await create(TOKENS.pending, 'rooms', 'pending-room', {
      ownerId: string('pending1'),
      currentOccupancy: integer(0),
      status: string('available'),
    }),
    false,
  );
  check(
    'inactive account cannot create a room',
    await create(TOKENS.inactive, 'rooms', 'inactive-room', {
      ownerId: string('inactive1'),
      currentOccupancy: integer(0),
      status: string('available'),
    }),
    false,
  );
  check(
    'clients cannot read the rules-migration switch',
    await call(TOKENS.student, 'GET', '/system/registration'),
    false,
  );

  console.log('\n--- profile creation cannot self-promote ---');
  check(
    'student cannot create a profile with role=admin',
    await create(TOKENS.student, 'users', 'student-admin', {
      uid: string('student-admin'),
      name: string('Student'),
      role: string('admin'),
      isActive: bool(true),
      registrationCompleted: bool(false),
    }),
    false,
  );
  check(
    'student cannot create a profile with registrationCompleted=true',
    await create(TOKENS.student, 'users', 'student-registration', {
      uid: string('student-registration'),
      name: string('Student'),
      role: string('student'),
      isActive: bool(true),
      registrationCompleted: bool(true),
    }),
    false,
  );
  check(
    'student cannot create a profile for another uid',
    await create(TOKENS.student, 'users', 'someoneelse-2', {
      uid: string('someoneelse-2'),
      name: string('Not mine'),
      role: string('student'),
      isActive: bool(true),
      registrationCompleted: bool(false),
    }),
    false,
  );
  check(
    'student can bootstrap an ordinary own profile',
    await create(TOKENS.bootstrap, 'users', 'student-bootstrap', {
      uid: string('student-bootstrap'),
      name: string('Student'),
      role: string('student'),
      isActive: bool(true),
      registrationCompleted: bool(false),
    }),
    true,
  );
  check(
    'a client cannot bootstrap a profile with a forged phone verification',
    await create(TOKENS.bootstrap, 'users', 'student-bootstrap-verified-phone', {
      uid: string('student-bootstrap-verified-phone'),
      name: string('Student'),
      role: string('student'),
      isActive: bool(true),
      registrationCompleted: bool(false),
      phone: string('+919876543210'),
      phoneVerified: bool(true),
    }),
    false,
  );
  check(
    'a client cannot bootstrap a profile with a forged email verification',
    await create(TOKENS.bootstrap, 'users', 'student-bootstrap-verified-email', {
      uid: string('student-bootstrap-verified-email'),
      name: string('Student'),
      role: string('student'),
      isActive: bool(true),
      registrationCompleted: bool(false),
      email: string('student@example.com'),
      emailVerified: bool(true),
    }),
    false,
  );
  check(
    'a client cannot bootstrap a forged legacy email-proof marker',
    await create(TOKENS.bootstrap, 'users', 'student-bootstrap-legacy-proof', {
      uid: string('student-bootstrap-legacy-proof'),
      name: string('Student'),
      role: string('student'),
      isActive: bool(true),
      registrationCompleted: bool(false),
      legacyEmailProofSource: string('stayServeOtp'),
      legacyEmailProofEmail: string('student@example.com'),
    }),
    false,
  );
  check(
    'a client cannot mark its own role as already claimed',
    await create(TOKENS.bootstrapRoleClaimed, 'users', 'student-bootstrap-role-claimed', {
      uid: string('student-bootstrap-role-claimed'),
      name: string('Student'),
      role: string('student'),
      roleClaimed: bool(true),
      isActive: bool(true),
      registrationCompleted: bool(false),
    }),
    false,
  );
  check(
    'student can bootstrap without the marker but it is not a live account',
    await create(TOKENS.bootstrapMissingMarker, 'users', 'student-bootstrap-missing', {
      uid: string('student-bootstrap-missing'),
      name: string('Student'),
      role: string('student'),
      isActive: bool(true),
      createdAt: timestamp(),
    }),
    true,
  );
  check(
    'a client cannot backdate a marker-less profile into the legacy window',
    await create(TOKENS.bootstrapOldProfile, 'users', 'student-bootstrap-old', {
      uid: string('student-bootstrap-old'),
      name: string('Student'),
      role: string('student'),
      isActive: bool(true),
      createdAt: timestamp(new Date(Date.now() - 60 * 60 * 1000).toISOString()),
    }),
    false,
  );
  check(
    'a marker-less newly-created profile cannot use protected room reads',
    await call(TOKENS.bootstrapMissingMarker, 'GET', '/rooms/room1'),
    false,
  );
  check(
    'a student without a verified phone cannot use protected room reads',
    await call(TOKENS.unverifiedPhone, 'GET', '/rooms/room1'),
    false,
  );
  check(
    'a stale cached phone grant without a phone token cannot use protected room reads',
    await call(TOKENS.studentWithoutPhoneToken, 'GET', '/rooms/room1'),
    false,
  );
  check(
    'an empty phone token cannot use protected room reads',
    await call(TOKENS.studentWithEmptyPhoneToken, 'GET', '/rooms/room1'),
    false,
  );
  // The Admin SDK can attach a phone number to an account without the SMS
  // challenge. The live record then carries the number, but the server never
  // issued the signed proof, so the tenant gate stays closed.
  await seedUser('admin-provisioned');
  check(
    'an administrator-provisioned phone cannot use protected room reads',
    await call(TOKENS.adminProvisionedPhone, 'GET', '/rooms/room1'),
    false,
  );
  check(
    'an administrator-provisioned phone cannot create a listing',
    await create(TOKENS.adminProvisionedPhone, 'rooms', 'room-admin-provisioned', {
      roomId: string('room-admin-provisioned'),
      ownerId: string('admin-provisioned'),
      title: string('Admin provisioned room'),
      monthlyRent: integer(12000),
      securityDeposit: integer(6000),
      occupancy: integer(2),
      genderPreference: string('any'),
      images: array([]),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'an administrator without a verified phone can still use protected room reads',
    await call(TOKENS.admin, 'GET', '/rooms/room1'),
    true,
  );
  check(
    'student cannot create a profile with isActive=false',
    await create(TOKENS.bootstrapInactive, 'users', 'student-bootstrap-inactive', {
      uid: string('student-bootstrap'),
      name: string('Student'),
      role: string('student'),
      isActive: bool(false),
      registrationCompleted: bool(false),
    }),
    false,
  );

  console.log('\n--- self profile fields are writable, server fields are not ---');
  check(
    'student can change their own name',
    await update(TOKENS.student, 'users', 'student1', { name: string('Student One') }),
    true,
  );
  check(
    'student cannot change their own phone',
    await update(TOKENS.student, 'users', 'student1', { phone: string('+919999999999') }),
    false,
  );
  check(
    'student cannot forge their own phone verification',
    await update(TOKENS.unverifiedPhone, 'users', 'unverifiedPhone1', {
      phoneVerified: bool(true),
    }),
    false,
  );
  check(
    'student cannot forge their own email verification',
    await update(TOKENS.unverifiedPhone, 'users', 'unverifiedPhone1', {
      emailVerified: bool(true),
    }),
    false,
  );
  check(
    'student cannot forge their own Auth provider list',
    await update(TOKENS.student, 'users', 'student1', { authProviders: array(['phone']) }),
    false,
  );
  check(
    'student can save a room',
    await update(TOKENS.student, 'users', 'student1', {
      savedRooms: array(['room1']),
    }),
    true,
  );
  check(
    'student cannot promote their own profile to admin',
    await update(TOKENS.student, 'users', 'student1', { role: string('admin') }),
    false,
  );
  check(
    'student cannot mark their own role as already claimed',
    await update(TOKENS.student, 'users', 'student1', {
      roleClaimed: bool(true),
    }),
    false,
  );
  await call('owner', 'PATCH', '/users/student1?updateMask.fieldPaths=registrationCompleted', {
    fields: { registrationCompleted: bool(false) },
  });
  check(
    'student cannot self-mark registrationCompleted=true',
    await update(TOKENS.student, 'users', 'student1', { registrationCompleted: bool(true) }),
    false,
  );
  await call('owner', 'PATCH', '/users/student1?updateMask.fieldPaths=registrationCompleted', {
    fields: { registrationCompleted: bool(true) },
  });
  await call('owner', 'PATCH', '/users/student1?updateMask.fieldPaths=isActive', {
    fields: { isActive: bool(false) },
  });
  check(
    'student cannot re-activate their own banned account',
    await update(TOKENS.student, 'users', 'student1', { isActive: bool(true) }),
    false,
  );
  await call('owner', 'PATCH', '/users/student1?updateMask.fieldPaths=isActive', {
    fields: { isActive: bool(true) },
  });

  check(
    'a client cannot read a moderation audit record',
    await call(TOKENS.admin, 'GET', '/reviewDeletionAudit/REV-TEST-1'),
    false,
  );
  check(
    'a client cannot write a moderation audit record',
    await create(TOKENS.admin, 'reviewDeletionAudit', 'REV-TEST-1', {
      reviewId: string('REV-TEST-1'),
      deletedByAdminId: string('admin1'),
      deletedAt: timestamp(),
    }),
    false,
  );
  check(
    'a client cannot read a review-deletion idempotency pointer',
    await call(TOKENS.admin, 'GET', '/reviewDeletionState/REV-TEST-1'),
    false,
  );
  check(
    'a client cannot write a review-deletion idempotency pointer',
    await create(TOKENS.admin, 'reviewDeletionState', 'REV-TEST-1', {
      reviewId: string('REV-TEST-1'),
      auditEventId: string('server-only-event'),
      deletedByAdminId: string('admin1'),
      deletedAt: timestamp(),
    }),
    false,
  );
  check(
    'a client cannot read a durable verified-email linking operation',
    await call(TOKENS.student, 'GET', '/emailLinkOperations/LINK-TEST-1'),
    false,
  );
  check(
    'a client cannot write a durable verified-email linking operation',
    await create(TOKENS.student, 'emailLinkOperations', 'LINK-TEST-1', {
      uid: string('student1'),
      email: string('student@example.com'),
      challengeHash: string('server-only-hash'),
      expiresAt: timestamp(),
    }),
    false,
  );
  check(
    'an administrator cannot bypass the server-only email linking operation rule',
    await call(TOKENS.admin, 'GET', '/emailLinkOperations/LINK-TEST-1'),
    false,
  );

  console.log('\n--- live admin role, not a token claim, controls admin access ---');
  check(
    'admin can update a platform setting',
    await update(TOKENS.admin, 'settings', 'platform', {
      commissionPercentage: double(31),
    }),
    true,
  );
  check(
    'regular user cannot update a platform setting',
    await update(TOKENS.student, 'settings', 'platform', {
      commissionPercentage: double(0),
    }),
    false,
  );
  check(
    'admin claim without a live admin profile cannot update settings',
    await update(TOKENS.fakeAdmin, 'settings', 'platform', {
      commissionPercentage: double(32),
    }),
    false,
  );
  await call('owner', 'PATCH', '/users/student1?updateMask.fieldPaths=isActive', {
    fields: { isActive: bool(false) },
  });
  check(
    'admin cannot directly re-activate a user (unbanUser is server-owned)',
    await update(TOKENS.admin, 'users', 'student1', { isActive: bool(true) }),
    false,
  );
  // Restore the seeded state through the Admin SDK equivalent used by the
  // callable, so the remaining account-state assertions can continue.
  await call('owner', 'PATCH', '/users/student1?updateMask.fieldPaths=isActive', {
    fields: { isActive: bool(true) },
  });
  check(
    'admin cannot delete a user profile directly',
    await call(TOKENS.admin, 'DELETE', '/users/student2'),
    false,
  );
  check(
    'a user cannot delete their own profile directly',
    await call(TOKENS.student, 'DELETE', '/users/student1'),
    false,
  );

  // Demote the live profile while leaving the old admin claim in the token.
  await call('owner', 'PATCH', '/users/admin1?updateMask.fieldPaths=role', {
    fields: { role: string('student') },
  });
  check(
    'demoted admin loses settings access despite a stale admin claim',
    await update(TOKENS.admin, 'settings', 'platform', {
      commissionPercentage: double(33),
    }),
    false,
  );
  await call('owner', 'PATCH', '/users/admin1?updateMask.fieldPaths=role', {
    fields: { role: string('admin') },
  });
  check(
    'restored live admin can update settings again',
    await update(TOKENS.admin, 'settings', 'platform', {
      commissionPercentage: double(30),
    }),
    true,
  );

  console.log('\n--- rooms: live owner, immutable ownership, server-owned state ---');
  check(
    'an anonymous caller cannot read a room',
    await callAnon('GET', '/rooms/room1'),
    false,
  );
  check(
    'an anonymous caller cannot list rooms',
    await callAnon('GET', '/rooms'),
    false,
  );
  check(
    'a live student can read a room and its image URLs',
    await call(TOKENS.student, 'GET', '/rooms/room1'),
    true,
  );
  check(
    'a live student can still list the rooms collection',
    await call(TOKENS.student, 'GET', '/rooms'),
    true,
  );
  check(
    'a signed-in stranger cannot edit another owner room',
    await update(TOKENS.stranger, 'rooms', 'room1', {
      title: string('Hijacked room'),
    }),
    false,
  );

  // ------------------------------------------------------------------
  // An unpublished draft is private to its owner and to a live admin.
  // A direct single-document read of somebody else's draft is refused;
  // the collection query stays open because the student search pages
  // through the collection without a status filter.
  // ------------------------------------------------------------------
  check(
    'the live owner can create a draft listing for the draft-visibility checks',
    await create(TOKENS.owner, 'rooms', 'owner-draft-room', {
      roomId: string('owner-draft-room'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Unfinished listing'),
      monthlyRent: double(10000),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    true,
  );
  check(
    'the owner can read their own draft listing',
    await call(TOKENS.owner, 'GET', '/rooms/owner-draft-room'),
    true,
  );
  check(
    'a live student cannot read a foreign draft listing',
    await call(TOKENS.student, 'GET', '/rooms/owner-draft-room'),
    false,
  );
  check(
    'a signed-in stranger cannot read a foreign draft listing',
    await call(TOKENS.stranger, 'GET', '/rooms/owner-draft-room'),
    false,
  );
  check(
    'an anonymous caller cannot read a draft listing',
    await callAnon('GET', '/rooms/owner-draft-room'),
    false,
  );
  check(
    'a live admin can read a draft listing',
    await call(TOKENS.admin, 'GET', '/rooms/owner-draft-room'),
    true,
  );
  check(
    'a forged admin claim without a live admin profile cannot read a draft listing',
    await call(TOKENS.fakeAdmin, 'GET', '/rooms/owner-draft-room'),
    false,
  );
  check(
    'a pending registration cannot read a draft listing',
    await call(TOKENS.pending, 'GET', '/rooms/owner-draft-room'),
    false,
  );
  check(
    'a tenant without a verified phone cannot read a draft listing',
    await call(TOKENS.unverifiedPhone, 'GET', '/rooms/owner-draft-room'),
    false,
  );
  check(
    'live owner can create a room without server-owned state fields',
    await create(TOKENS.owner, 'rooms', 'owner-room', {
      roomId: string('owner-room'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('New room'),
      monthlyRent: double(10000),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    true,
  );
  check(
    'live owner can create a room as a draft',
    await create(TOKENS.owner, 'rooms', 'owner-room-with-state', {
      roomId: string('owner-room-with-state'),
      ownerId: string('owner1'),
      title: string('New room with state'),
      monthlyRent: double(10000),
      occupancy: integer(2),
      status: string('draft'),
      currentOccupancy: integer(0),
      createdAt: timestamp(),
    }),
    true,
  );
  check(
    'live owner cannot create a room which publishes itself',
    await create(TOKENS.owner, 'rooms', 'owner-room-published', {
      roomId: string('owner-room-published'),
      ownerId: string('owner1'),
      title: string('Room which publishes itself'),
      monthlyRent: double(10000),
      occupancy: integer(2),
      status: string('available'),
      currentOccupancy: integer(0),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'live owner cannot create a room without a status',
    await create(TOKENS.owner, 'rooms', 'owner-room-without-status', {
      roomId: string('owner-room-without-status'),
      ownerId: string('owner1'),
      title: string('Room without a status'),
      monthlyRent: double(10000),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'live owner cannot create a room with a forged photo-cleanup lock',
    await create(TOKENS.owner, 'rooms', 'owner-room-forged-cleanup-lock', {
      roomId: string('owner-room-forged-cleanup-lock'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Forged cleanup lock room'),
      monthlyRent: double(10000),
      occupancy: integer(2),
      photoCleanupLock: map({
        token: string('forged-lock'),
        expiresAt: timestamp(),
      }),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'live owner cannot create a room with a forged listing generation',
    await create(TOKENS.owner, 'rooms', 'owner-room-forged-generation', {
      roomId: string('owner-room-forged-generation'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Forged generation room'),
      monthlyRent: double(10000),
      occupancy: integer(2),
      listingGeneration: string('client-chosen-generation'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'live owner cannot change the server-owned listing generation',
    await update(TOKENS.owner, 'rooms', 'room1', {
      listingGeneration: string('replacement-generation'),
    }),
    false,
  );
  check(
    'live owner cannot create a listing which reuses a deleted room id',
    await create(TOKENS.owner, 'rooms', 'room-reserved', {
      roomId: string('room-reserved'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Reused reserved room id'),
      monthlyRent: double(10000),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'live owner cannot edit a listing while its deletion marker is active',
    await update(TOKENS.owner, 'rooms', 'room-deleting', {
      title: string('Edit during deletion'),
    }),
    false,
  );

  // Once the durable cleanup has removed the server-owned tombstone, the id
  // may be used by a new listing generation.
  await call('owner', 'DELETE', '/roomDeletionTombstones/room-reserved');
  check(
    'the room id can be reused after its cleanup tombstone is removed',
    await create(TOKENS.owner, 'rooms', 'room-reserved', {
      roomId: string('room-reserved'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Reused room after cleanup'),
      monthlyRent: double(10000),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    true,
  );

  check(
    'live owner can create a room with coarse public location data',
    await create(TOKENS.owner, 'rooms', 'owner-room-coarse-location', {
      roomId: string('owner-room-coarse-location'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Coarse location room'),
      monthlyRent: double(10000),
      location: map({
        city: string('Bengaluru'),
        state: string('Karnataka'),
      }),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    true,
  );
  check(
    'live owner cannot create a room with a string location',
    await create(TOKENS.owner, 'rooms', 'owner-room-string-location', {
      roomId: string('owner-room-string-location'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('String location room'),
      location: string('42 Exact Street, Bengaluru 560001'),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'live owner cannot create a room with a numeric location',
    await create(TOKENS.owner, 'rooms', 'owner-room-number-location', {
      roomId: string('owner-room-number-location'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Numeric location room'),
      location: double(12.9716),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'live owner cannot create a room with a null location',
    await create(TOKENS.owner, 'rooms', 'owner-room-null-location', {
      roomId: string('owner-room-null-location'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Null location room'),
      location: { nullValue: null },
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'live owner cannot create a room with an exact public address',
    await create(TOKENS.owner, 'rooms', 'owner-room-exact-location', {
      roomId: string('owner-room-exact-location'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Exact location room'),
      location: map({
        address: string('12 Exact Street'),
        city: string('Bengaluru'),
        state: string('Karnataka'),
        pincode: string('560001'),
      }),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );

  // Old app versions may still write the exact location during the
  // compatibility window. The server-owned switch is the only way to allow
  // that write, and clients cannot read or change the switch themselves.
  await update('owner', 'system', 'locationPrivacy', {
    allowClientExactLocationWrites: bool(true),
  });
  check(
    'the transitional switch permits a legacy exact-location create',
    await create(TOKENS.owner, 'rooms', 'owner-room-legacy-location', {
      roomId: string('owner-room-legacy-location'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Legacy exact location room'),
      monthlyRent: double(10000),
      location: map({
        address: string('12 Exact Street'),
        city: string('Bengaluru'),
        state: string('Karnataka'),
        pincode: string('560001'),
      }),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    true,
  );
  check(
    'the transitional switch still rejects a non-map public location',
    await create(TOKENS.owner, 'rooms', 'owner-room-legacy-string-location', {
      roomId: string('owner-room-legacy-string-location'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Legacy string location room'),
      location: string('42 Exact Street, Bengaluru 560001'),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );

  // The durable finalization latch is stronger than the transitional switch.
  // Even if a stale operator or deployment tries to reopen the switch, a
  // legacy exact-field create must remain rejected after finalization.
  await update('owner', 'system', 'locationPrivacy', {
    allowClientExactLocationWrites: bool(true),
    finalized: bool(true),
  });
  check(
    'the finalization latch rejects a legacy exact-location create',
    await create(TOKENS.owner, 'rooms', 'owner-room-latched-location', {
      roomId: string('owner-room-latched-location'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Latched exact location room'),
      location: map({
        address: string('12 Exact Street'),
        city: string('Bengaluru'),
        state: string('Karnataka'),
        pincode: string('560001'),
      }),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );

  await update('owner', 'system', 'locationPrivacy', {
    allowClientExactLocationWrites: bool(false),
    finalized: bool(false),
  });
  check(
    'closing the transitional switch rejects exact-location creates again',
    await create(TOKENS.owner, 'rooms', 'owner-room-exact-location-2', {
      roomId: string('owner-room-exact-location-2'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Rejected exact location room'),
      location: map({
        address: string('12 Exact Street'),
        city: string('Bengaluru'),
        state: string('Karnataka'),
        pincode: string('560001'),
      }),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'live owner cannot create a room with a client-supplied image URL',
    await create(TOKENS.owner, 'rooms', 'owner-room-client-image', {
      roomId: string('owner-room-client-image'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Room with a client image'),
      occupancy: integer(2),
      images: array([
        'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/rooms%2Fowner1%2Fowner-room-client-image%2Froom.jpg?alt=media&token=abc',
      ]),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'live owner cannot create a room with a malformed image list',
    await create(TOKENS.owner, 'rooms', 'owner-room-invalid-images', {
      roomId: string('owner-room-invalid-images'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('New room with invalid images'),
      occupancy: integer(2),
      images: mixedArray([
        'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/rooms%2Fowner1%2Froom.jpg?alt=media&token=abc',
        42,
      ]),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'owner cannot create a room that already has tenants',
    await create(TOKENS.owner, 'rooms', 'room-with-occupancy', {
      roomId: string('room-with-occupancy'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Client occupancy'),
      occupancy: integer(2),
      currentOccupancy: integer(1),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'owner cannot create a room that is already occupied',
    await create(TOKENS.owner, 'rooms', 'room-with-status', {
      roomId: string('room-with-status'),
      ownerId: string('owner1'),
      title: string('Client status'),
      occupancy: integer(2),
      status: string('occupied'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'owner cannot create a room that is already inactive',
    await create(TOKENS.owner, 'rooms', 'room-with-inactive-status', {
      roomId: string('room-with-inactive-status'),
      ownerId: string('owner1'),
      title: string('Client inactive status'),
      occupancy: integer(2),
      status: string('inactive'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'owner cannot create a room with non-positive capacity',
    await create(TOKENS.owner, 'rooms', 'zero-capacity-room', {
      roomId: string('zero-capacity-room'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('No capacity'),
      occupancy: integer(0),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'owner cannot create a room without a monthly rent',
    await create(TOKENS.owner, 'rooms', 'missing-rent-room', {
      roomId: string('missing-rent-room'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Missing rent'),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'owner cannot create a room with a rent below the lower limit',
    await create(TOKENS.owner, 'rooms', 'low-rent-room', {
      roomId: string('low-rent-room'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Low rent'),
      monthlyRent: double(999),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'owner cannot create a room with a numeric-string rent',
    await create(TOKENS.owner, 'rooms', 'string-rent-room', {
      roomId: string('string-rent-room'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('String rent'),
      monthlyRent: string('5000'),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'owner cannot create a room with a fractional capacity',
    await create(TOKENS.owner, 'rooms', 'fractional-capacity-room', {
      roomId: string('fractional-capacity-room'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Fractional capacity'),
      monthlyRent: double(5000),
      occupancy: double(1.5),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'owner cannot create a room with a capacity above the limit',
    await create(TOKENS.owner, 'rooms', 'oversized-capacity-room', {
      roomId: string('oversized-capacity-room'),
      ownerId: string('owner1'),
      status: string('draft'),
      title: string('Oversized capacity'),
      monthlyRent: double(5000),
      occupancy: integer(21),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'owner cannot change a valid rent to an invalid value',
    await update(TOKENS.owner, 'rooms', 'room1', {
      monthlyRent: double(1000001),
    }),
    false,
  );
  check(
    'owner cannot change a valid capacity to a fractional value',
    await update(TOKENS.owner, 'rooms', 'room1', {
      occupancy: double(1.5),
    }),
    false,
  );
  check(
    'a live student cannot create a room',
    await create(TOKENS.student, 'rooms', 'student-room', {
      roomId: string('student-room'),
      ownerId: string('student1'),
      title: string('Not an owner room'),
      currentOccupancy: integer(0),
      status: string('available'),
    }),
    false,
  );
  check(
    'owner cannot create a room with non-zero occupancy',
    await create(TOKENS.owner, 'rooms', 'occupied-room', {
      roomId: string('occupied-room'),
      ownerId: string('owner1'),
      title: string('Bad occupancy'),
      currentOccupancy: integer(1),
      status: string('available'),
    }),
    false,
  );
  check(
    'owner cannot create a room for another uid',
    await create(TOKENS.owner, 'rooms', 'forged-room', {
      roomId: string('forged-room'),
      ownerId: string('student1'),
      title: string('Forged room'),
      currentOccupancy: integer(0),
      status: string('available'),
    }),
    false,
  );
  check(
    'owner can edit legitimate room fields',
    await update(TOKENS.owner, 'rooms', 'room1', {
      title: string('Renamed room'),
      description: string('Updated description'),
      monthlyRent: double(12000),
      securityDeposit: double(6000),
      amenities: array(['Wi-Fi', 'Power backup']),
      occupancy: integer(3),
      homeName: string('Updated home'),
      updatedAt: timestamp(),
    }),
    true,
  );
  check(
    'owner cannot replace the public room location directly',
    await update(TOKENS.owner, 'rooms', 'room1', {
      location: map({
        city: string('Bengaluru'),
        state: string('Karnataka'),
      }),
    }),
    false,
  );
  check(
    'owner cannot forge a server-owned public geo cell',
    await update(TOKENS.owner, 'rooms', 'room1', {
      geoCell: string('12.97,77.59'),
    }),
    false,
  );
  check(
    'owner cannot publish room image URLs directly (the server commit owns them)',
    await update(TOKENS.owner, 'rooms', 'room1', {
      images: array([
        'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/rooms%2Fowner1%2Froom1%2Froom-1.jpg?alt=media&token=one',
        'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/rooms%2Fowner1%2Froom1%2Froom-2.jpg?alt=media&token=two',
      ]),
    }),
    false,
  );
  check(
    'owner cannot publish an image URL from an unrelated host',
    await update(TOKENS.owner, 'rooms', 'room1', {
      images: array(['https://tracker.example/room.jpg']),
    }),
    false,
  );
  check(
    'owner cannot publish an attacker-project bucket URL',
    await update(TOKENS.owner, 'rooms', 'room1', {
      images: array([
        'https://firebasestorage.googleapis.com/v0/b/attacker-project.appspot.com/o/rooms%2Fowner1%2Froom1%2Froom.jpg?alt=media&token=abc',
      ]),
    }),
    false,
  );
  check(
    'owner cannot publish a trusted-bucket URL for another owner path',
    await update(TOKENS.owner, 'rooms', 'room1', {
      images: array([
        'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/rooms%2Fowner2%2Froom1%2Froom.jpg?alt=media&token=abc',
      ]),
    }),
    false,
  );
  check(
    'owner cannot publish a trusted-bucket URL for another room path',
    await update(TOKENS.owner, 'rooms', 'room1', {
      images: array([
        'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/rooms%2Fowner1%2Froom2%2Froom.jpg?alt=media&token=abc',
      ]),
    }),
    false,
  );
  check(
    'owner cannot publish a malformed room image list',
    await update(TOKENS.owner, 'rooms', 'room1', {
      images: mixedArray([
        'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/rooms%2Fowner1%2Froom.jpg?alt=media&token=abc',
        42,
      ]),
    }),
    false,
  );
  check(
    'owner cannot publish more than ten room images',
    await update(TOKENS.owner, 'rooms', 'room1', {
      images: array(
        Array.from(
          { length: 11 },
          (_, index) =>
            `https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/rooms%2Fowner1%2Froom1%2F${index}.jpg?alt=media&token=${index}`,
        ),
      ),
    }),
    false,
  );
  check(
    'owner cannot change currentOccupancy',
    await update(TOKENS.owner, 'rooms', 'room1', {
      currentOccupancy: integer(1),
    }),
    false,
  );
  check(
    'owner cannot change status directly (the availability callable owns it)',
    await update(TOKENS.owner, 'rooms', 'room1', {
      status: string('occupied'),
    }),
    false,
  );
  check(
    'owner cannot change ownerId',
    await update(TOKENS.owner, 'rooms', 'room1', {
      ownerId: string('student1'),
    }),
    false,
  );
  check(
    'owner cannot change createdAt',
    await update(TOKENS.owner, 'rooms', 'room1', {
      createdAt: timestamp(new Date(2000, 1, 1).toISOString()),
    }),
    false,
  );
  check(
    'admin cannot update listing status directly (the callable owns it)',
    await update(TOKENS.admin, 'rooms', 'room1', {
      status: string('available'),
    }),
    false,
  );
  check(
    'admin cannot change currentOccupancy directly',
    await update(TOKENS.admin, 'rooms', 'room1', {
      currentOccupancy: integer(1),
    }),
    false,
  );
  check(
    'owner cannot delete a room directly (deleteRoomListing is server-owned)',
    await call(TOKENS.owner, 'DELETE', '/rooms/room1'),
    false,
  );
  check(
    'admin cannot delete a room directly (deleteRoomListing is server-owned)',
    await call(TOKENS.admin, 'DELETE', '/rooms/room1'),
    false,
  );
  check(
    'owner cannot reduce the capacity below the current occupancy',
    await update(TOKENS.owner, 'rooms', 'room-occupied', {
      occupancy: integer(1),
    }),
    false,
  );
  check(
    'owner can raise the capacity above the current occupancy',
    await update(TOKENS.owner, 'rooms', 'room-occupied', {
      occupancy: integer(3),
    }),
    true,
  );

  await call('owner', 'PATCH', '/users/owner1?updateMask.fieldPaths=role', {
    fields: { role: string('student') },
  });
  check(
    'an owner demoted to student cannot keep editing with an old token',
    await update(TOKENS.owner, 'rooms', 'room1', {
      title: string('Stale owner write'),
    }),
    false,
  );
  await call('owner', 'PATCH', '/users/owner1?updateMask.fieldPaths=role', {
    fields: { role: string('owner') },
  });

  await call('owner', 'PATCH', '/users/owner1?updateMask.fieldPaths=isActive', {
    fields: { isActive: bool(false) },
  });
  check(
    'an inactive owner cannot edit a room',
    await update(TOKENS.owner, 'rooms', 'room1', {
      title: string('Inactive owner write'),
    }),
    false,
  );
  await call('owner', 'PATCH', '/users/owner1?updateMask.fieldPaths=isActive', {
    fields: { isActive: bool(true) },
  });

  console.log('\n--- private room locations are owner/admin-readable and server-written ---');
  check(
    'the listing owner can read their own private location',
    await readAllowed(TOKENS.owner, '/roomPrivate/room1'),
    true,
  );
  check(
    'the listing owner can read a missing private location during migration',
    await readAllowed(TOKENS.owner, '/roomPrivate/room-private-missing'),
    true,
  );
  check(
    'the listing owner can recover a private location with a corrupt owner id',
    await readAllowed(TOKENS.owner, '/roomPrivate/room-private-mismatch'),
    true,
  );
  check(
    'a corrupt private owner id does not grant another account access',
    await readAllowed(TOKENS.stranger, '/roomPrivate/room-private-mismatch'),
    false,
  );
  check(
    'a student cannot read a missing private location directly',
    await readAllowed(TOKENS.student, '/roomPrivate/room-private-missing'),
    false,
  );
  check(
    'a client cannot list the private-location collection',
    await call(TOKENS.owner, 'GET', '/roomPrivate'),
    false,
  );
  check(
    'a corrupt private owner id does not grant collection access',
    await call(TOKENS.stranger, 'GET', '/roomPrivate'),
    false,
  );
  check(
    'a live administrator can list private locations for support work',
    await call(TOKENS.admin, 'GET', '/roomPrivate'),
    true,
  );
  check(
    'a live administrator can read a private location for support work',
    await readAllowed(TOKENS.admin, '/roomPrivate/room1'),
    true,
  );
  check(
    'a student cannot read a private room location directly',
    await readAllowed(TOKENS.student, '/roomPrivate/room1'),
    false,
  );
  check(
    'a signed-in stranger cannot read a private room location',
    await readAllowed(TOKENS.stranger, '/roomPrivate/room1'),
    false,
  );
  check(
    'the listing owner cannot write the private location directly',
    await update(TOKENS.owner, 'roomPrivate', 'room1', {
      address: string('Client-written address'),
    }),
    false,
  );
  check(
    'an administrator cannot write the private location directly',
    await update(TOKENS.admin, 'roomPrivate', 'room1', {
      address: string('Client-written address'),
    }),
    false,
  );
  check(
    'a client cannot create a private room location',
    await create(TOKENS.owner, 'roomPrivate', 'client-room-private', {
      roomId: string('client-room-private'),
      ownerId: string('owner1'),
      address: string('Client-written address'),
      city: string('Bengaluru'),
      state: string('Karnataka'),
      pincode: string('560001'),
    }),
    false,
  );
  check(
    'a client cannot delete a private room location',
    await call(TOKENS.owner, 'DELETE', '/roomPrivate/room1'),
    false,
  );
  check(
    'clients cannot read the exact-location compatibility switch',
    await readAllowed(TOKENS.student, '/system/locationPrivacy'),
    false,
  );

  console.log('\n--- notifications are server-owned except read bookkeeping ---');
  check(
    'student cannot create a notification for themselves',
    await create(TOKENS.student, 'notifications', 'n-client', {
      userId: string('student1'),
      title: string('forged'),
      body: string('forged'),
      type: string('general'),
    }),
    false,
  );
  check(
    'student cannot change notification content',
    await update(TOKENS.student, 'notifications', 'n-own', {
      title: string('tampered'),
    }),
    false,
  );
  check(
    'student cannot change notification routing',
    await update(TOKENS.student, 'notifications', 'n-own', {
      userId: string('someoneelse'),
    }),
    false,
  );
  check(
    'student can mark their own notification read',
    await update(TOKENS.student, 'notifications', 'n-own', {
      read: bool(true),
      readAt: timestamp(),
    }),
    true,
  );
  check(
    'student can use the isRead bookkeeping field',
    await update(TOKENS.student, 'notifications', 'n-own', {
      isRead: bool(true),
    }),
    true,
  );
  check(
    'student cannot delete a notification',
    await call(TOKENS.student, 'DELETE', '/notifications/n-own'),
    false,
  );
  check(
    'student can read their own notification',
    await call(TOKENS.student, 'GET', '/notifications/n-own'),
    true,
  );
  check(
    'student cannot read another notification',
    await call(TOKENS.student, 'GET', '/notifications/n-other'),
    false,
  );

  console.log('\n--- messaging is limited to the two real participants ---');
  check(
    'a participant can read the conversation',
    await call(TOKENS.student, 'GET', '/conversations/conv1'),
    true,
  );
  check(
    'a stranger cannot read the conversation',
    await call(TOKENS.stranger, 'GET', '/conversations/conv1'),
    false,
  );
  check(
    'a stranger cannot read the messages',
    await call(TOKENS.stranger, 'GET', '/conversations/conv1/messages/msg1'),
    false,
  );
  check(
    'a participant can send a legitimate two-party message',
    await create(TOKENS.student, 'conversations/conv1/messages', 'msg-legit', {
      messageId: string('msg-legit'),
      conversationId: string('conv1'),
      senderId: string('student1'),
      receiverId: string('owner1'),
      content: string('Hello owner'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    true,
  );
  check(
    'an ordinary booking conversation message remains allowed',
    await create(TOKENS.student, 'conversations/conv1/messages', 'msg-ordinary-booking', {
      messageId: string('msg-ordinary-booking'),
      conversationId: string('conv1'),
      senderId: string('student1'),
      receiverId: string('owner1'),
      content: string('Ordinary booking reply'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    true,
  );

  console.log('\n--- administrator support messages are callable-only ---');
  check(
    'a support target can read an opaque support conversation',
    await call(TOKENS.student, 'GET', '/conversations/conv-admin-opaque'),
    true,
  );
  check(
    'a support target can read the opaque support messages',
    await call(
      TOKENS.student,
      'GET',
      '/conversations/conv-admin-opaque/messages/msg-admin-opaque',
    ),
    true,
  );
  check(
    'the mapped administrator can read an opaque support conversation',
    await call(TOKENS.admin, 'GET', '/conversations/conv-admin-opaque'),
    true,
  );
  check(
    'the mapped administrator can read the opaque support messages',
    await call(
      TOKENS.admin,
      'GET',
      '/conversations/conv-admin-opaque/messages/msg-admin-opaque',
    ),
    true,
  );
  check(
    'a tenant cannot directly read a legacy raw-uid support conversation',
    await call(TOKENS.student, 'GET', '/conversations/conv-admin'),
    false,
  );
  check(
    'a tenant cannot directly read a legacy raw-uid support message',
    await call(
      TOKENS.student,
      'GET',
      '/conversations/conv-admin/messages/msg-legacy-raw-admin',
    ),
    false,
  );
  check(
    'the mapped administrator cannot directly read a legacy raw-uid support conversation',
    await call(TOKENS.admin, 'GET', '/conversations/conv-admin'),
    false,
  );
  check(
    'an unmapped administrator cannot read an opaque support conversation',
    await call(TOKENS.fakeAdmin, 'GET', '/conversations/conv-admin-opaque'),
    false,
  );
  check(
    'an ordinary user cannot read an opaque support conversation',
    await call(TOKENS.stranger, 'GET', '/conversations/conv-admin-opaque'),
    false,
  );
  check(
    'the mapped administrator cannot read the server-only support operation',
    await call(
      TOKENS.admin,
      'GET',
      '/adminSupportConversationOperations/conv-admin-opaque',
    ),
    false,
  );
  check(
    'a support target cannot reply to the opaque administrator identity directly',
    await create(
      TOKENS.student,
      'conversations/conv-admin-opaque/messages',
      'msg-opaque-support-reply',
      {
        messageId: string('msg-opaque-support-reply'),
        conversationId: string('conv-admin-opaque'),
        senderId: string('student1'),
        receiverId: string(OPAQUE_ADMIN_IDENTITY),
        content: string('Student support reply'),
        type: string('text'),
        createdAt: timestamp(),
      },
    ),
    false,
  );
  // The trusted `sendAdminSupportReply` callable writes the reply with the
  // Admin SDK, which bypasses the rules. The emulator's owner token is
  // equivalent to that write.
  await call('owner', 'PATCH', '/conversations/conv-admin-opaque/messages/msg-opaque-support-reply', {
    fields: {
      messageId: string('msg-opaque-support-reply'),
      conversationId: string('conv-admin-opaque'),
      senderId: string('student1'),
      receiverId: string(OPAQUE_ADMIN_IDENTITY),
      content: string('Student support reply'),
      type: string('text'),
      senderType: string('user'),
      createdAt: timestamp(),
    },
  });
  check(
    'the mapped administrator can read a tenant support reply',
    await call(
      TOKENS.admin,
      'GET',
      '/conversations/conv-admin-opaque/messages/msg-opaque-support-reply',
    ),
    true,
  );
  const mappedAdminMessageList = await call(
    TOKENS.admin,
    'GET',
    '/conversations/conv-admin-opaque/messages?pageSize=100',
  );
  checkCondition(
    'the mapped administrator can list the opaque support messages',
    Array.isArray(mappedAdminMessageList.body?.documents),
  );
  checkCondition(
    'the mapped administrator message list includes the tenant reply',
    (mappedAdminMessageList.body?.documents || []).some((document) =>
      String(document.name || '').endsWith('/msg-opaque-support-reply'),
    ),
  );
  check(
    'the mapped administrator cannot write directly to the opaque support conversation',
    await create(
      TOKENS.admin,
      'conversations/conv-admin-opaque/messages',
      'msg-opaque-admin-direct',
      {
        messageId: string('msg-opaque-admin-direct'),
        conversationId: string('conv-admin-opaque'),
        senderId: string('admin1'),
        receiverId: string('student1'),
        content: string('Direct opaque administrator write'),
        type: string('text'),
        createdAt: timestamp(),
      },
    ),
    false,
  );
  check(
    'an administrator cannot write directly to an adminSupport conversation',
    await create(TOKENS.admin, 'conversations/conv-admin/messages', 'msg-admin-direct', {
      messageId: string('msg-admin-direct'),
      conversationId: string('conv-admin'),
      senderId: string('admin1'),
      receiverId: string('student1'),
      content: string('Direct administrator write'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a legacy support target cannot reply while the raw uid remains',
    await create(TOKENS.student, 'conversations/conv-admin/messages', 'msg-support-student-reply', {
      messageId: string('msg-support-student-reply'),
      conversationId: string('conv-admin'),
      senderId: string('student1'),
      receiverId: string('admin1'),
      content: string('Student support reply'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'an owner support target cannot reply directly with the ordinary message schema',
    await create(TOKENS.owner, 'conversations/conv-admin-opaque-owner/messages', 'msg-support-owner-reply', {
      messageId: string('msg-support-owner-reply'),
      conversationId: string('conv-admin-opaque-owner'),
      senderId: string('owner1'),
      receiverId: string(OPAQUE_ADMIN_IDENTITY),
      content: string('Owner support reply'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a support target cannot update the support conversation bookkeeping',
    await update(TOKENS.student, 'conversations', 'conv-admin-opaque', {
      lastMessage: string('Student support reply'),
      lastMessageAt: timestamp(),
      updatedAt: timestamp(),
    }),
    false,
  );
  check(
    'the mapped administrator cannot clear the support unread counter directly',
    await update(TOKENS.admin, 'conversations', 'conv-admin-opaque', {
      unreadCount: map({
        [OPAQUE_ADMIN_IDENTITY]: integer(0),
        student1: integer(0),
      }),
    }),
    false,
  );
  check(
    'a support target cannot clear the opaque administrator unread counter',
    await update(TOKENS.student, 'conversations', 'conv-admin-opaque', {
      unreadCount: map({
        [OPAQUE_ADMIN_IDENTITY]: integer(0),
        student1: integer(0),
      }),
    }),
    false,
  );
  check(
    'a support target cannot increment the opaque administrator unread counter',
    await update(TOKENS.student, 'conversations', 'conv-admin-opaque', {
      unreadCount: map({
        [OPAQUE_ADMIN_IDENTITY]: integer(2),
        student1: integer(1),
      }),
    }),
    false,
  );
  check(
    'a support target cannot clear only its own unread counter',
    await update(TOKENS.student, 'conversations', 'conv-admin-opaque', {
      unreadCount: map({
        [OPAQUE_ADMIN_IDENTITY]: integer(2),
        student1: integer(0),
      }),
    }),
    false,
  );
  check(
    'a support target cannot forge the support conversation preview',
    await update(TOKENS.student, 'conversations', 'conv-admin-opaque', {
      lastMessage: string('Forged preview'),
      lastMessageAt: timestamp(),
      updatedAt: timestamp(),
      unreadCount: map({
        [OPAQUE_ADMIN_IDENTITY]: integer(9),
        student1: integer(0),
      }),
    }),
    false,
  );
  check(
    'a participant cannot send a message while the conversation is being deleted',
    await create(TOKENS.student, 'conversations/conv-deleting/messages', 'msg-late', {
      messageId: string('msg-late'),
      conversationId: string('conv-deleting'),
      senderId: string('student1'),
      receiverId: string('owner1'),
      content: string('Too late'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a participant cannot update a conversation while it is being deleted',
    await update(TOKENS.owner, 'conversations', 'conv-deleting', {
      lastMessage: string('Still here'),
    }),
    false,
  );
  check(
    'a sender cannot forge the receiver of a message',
    await create(TOKENS.student, 'conversations/conv1/messages', 'msg-forged-receiver', {
      messageId: string('msg-forged-receiver'),
      conversationId: string('conv1'),
      senderId: string('student1'),
      receiverId: string('someoneelse'),
      content: string('Not for this participant'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a sender cannot spoof the sender id of a message',
    await create(TOKENS.student, 'conversations/conv1/messages', 'msg-forged-sender', {
      messageId: string('msg-forged-sender'),
      conversationId: string('conv1'),
      senderId: string('owner1'),
      receiverId: string('owner1'),
      content: string('Spoofed'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a message cannot claim a different conversation id',
    await create(TOKENS.student, 'conversations/conv1/messages', 'msg-wrong-conversation', {
      messageId: string('msg-wrong-conversation'),
      conversationId: string('conv-other'),
      senderId: string('student1'),
      receiverId: string('owner1'),
      content: string('Wrong path'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a user cannot forge the verified Admin sender type',
    await create(TOKENS.student, 'conversations/conv-admin/messages', 'msg-fake-admin', {
      messageId: string('msg-fake-admin'),
      conversationId: string('conv-admin'),
      senderId: string('student1'),
      receiverId: string('admin1'),
      content: string('I am the administrator'),
      type: string('text'),
      senderType: string('admin'),
      adminVerified: bool(true),
      adminId: string('admin1'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a user cannot forge the Admin verification marker without the sender type',
    await create(TOKENS.student, 'conversations/conv-admin/messages', 'msg-fake-admin-marker', {
      messageId: string('msg-fake-admin-marker'),
      conversationId: string('conv-admin'),
      senderId: string('student1'),
      receiverId: string('admin1'),
      content: string('Still an administrator'),
      type: string('text'),
      adminVerified: bool(true),
      adminId: string('admin1'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a user cannot forge only the Admin sender type',
    await create(TOKENS.student, 'conversations/conv-admin/messages', 'msg-forged-sender-type', {
      messageId: string('msg-forged-sender-type'),
      conversationId: string('conv-admin'),
      senderId: string('student1'),
      receiverId: string('admin1'),
      content: string('Forged sender type'),
      type: string('text'),
      senderType: string('admin'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a user cannot forge only the Admin verification marker',
    await create(TOKENS.student, 'conversations/conv-admin/messages', 'msg-forged-admin-verified', {
      messageId: string('msg-forged-admin-verified'),
      conversationId: string('conv-admin'),
      senderId: string('student1'),
      receiverId: string('admin1'),
      content: string('Forged verification marker'),
      type: string('text'),
      adminVerified: bool(true),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a user cannot forge only the Admin id marker',
    await create(TOKENS.student, 'conversations/conv-admin/messages', 'msg-forged-admin-id', {
      messageId: string('msg-forged-admin-id'),
      conversationId: string('conv-admin'),
      senderId: string('student1'),
      receiverId: string('admin1'),
      content: string('Forged admin id'),
      type: string('text'),
      adminId: string('admin1'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a user cannot create a support conversation with forged Admin markers',
    await create(TOKENS.student, 'conversations', 'conv-fake-admin', {
      conversationId: string('conv-fake-admin'),
      participantIds: array(['student1', 'admin1']),
      conversationType: string('adminSupport'),
      adminId: string('admin1'),
      adminVerified: bool(true),
      createdByServer: bool(true),
      createdAt: timestamp(),
      updatedAt: timestamp(),
    }),
    false,
  );
  check(
    'a client administrator cannot create an adminSupport conversation',
    await create(TOKENS.admin, 'conversations', 'conv-fake-admin-client', {
      conversationId: string('conv-fake-admin-client'),
      participantIds: array(['admin1', 'student1']),
      conversationType: string('adminSupport'),
      createdAt: timestamp(),
      updatedAt: timestamp(),
    }),
    false,
  );
  check(
    'a participant cannot change an adminSupport conversation type',
    await update(TOKENS.student, 'conversations', 'conv-admin', {
      conversationType: string('booking'),
    }),
    false,
  );
  check(
    'an administrator client cannot change the adminSupport admin id',
    await update(TOKENS.admin, 'conversations', 'conv-admin', {
      adminId: string('student1'),
    }),
    false,
  );
  check(
    'a participant cannot change the adminSupport verification marker',
    await update(TOKENS.student, 'conversations', 'conv-admin', {
      adminVerified: bool(false),
    }),
    false,
  );
  check(
    'a participant cannot change the adminSupport server-created marker',
    await update(TOKENS.student, 'conversations', 'conv-admin', {
      createdByServer: bool(false),
    }),
    false,
  );
  check(
    'a client cannot create a conversation with a third participant',
    await create(TOKENS.student, 'conversations', 'conv-third-party', {
      conversationId: string('conv-third-party'),
      participantIds: array(['student1', 'owner1', 'someoneelse']),
      lastMessage: string(''),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a client cannot create a conversation with a duplicated participant',
    await create(TOKENS.student, 'conversations', 'conv-duplicate', {
      conversationId: string('conv-duplicate'),
      participantIds: array(['student1', 'student1']),
      lastMessage: string(''),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a client cannot create even a plausible conversation (the server owns creation)',
    await create(TOKENS.student, 'conversations', 'conv-legit', {
      conversationId: string('conv-legit'),
      participantIds: array(['student1', 'owner1']),
      lastMessage: string(''),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a participant cannot add a third party to an existing conversation',
    await update(TOKENS.owner, 'conversations', 'conv1', {
      participantIds: array(['student1', 'owner1', 'someoneelse']),
    }),
    false,
  );
  check(
    'a participant cannot change the conversation id',
    await update(TOKENS.owner, 'conversations', 'conv1', {
      conversationId: string('conv-forged'),
    }),
    false,
  );

  console.log('\n--- personal blocks and server-owned conversation metadata ---');
  await call('owner', 'PATCH', '/userBlocks/student1/blockedUsers/owner1', {
    fields: {
      blockerId: string('student1'),
      blockedUserId: string('owner1'),
      scope: string('person'),
    },
  });
  await call('owner', 'PATCH', '/conversations/conv1/contexts/request-1', {
    fields: {
      contextId: string('request-1'),
      roomId: string('room1'),
      roomTitle: string('Test Room'),
      requestId: string('request-1'),
    },
  });

  check(
    'a client cannot read a personal block document',
    await call(TOKENS.student, 'GET', '/userBlocks/student1/blockedUsers/owner1'),
    false,
  );
  check(
    'a client cannot create a personal block document',
    await create(TOKENS.student, 'userBlocks/student1/blockedUsers', 'owner2', {
      blockerId: string('student1'),
      blockedUserId: string('owner2'),
    }),
    false,
  );
  check(
    'a client cannot remove a personal block document',
    await call(TOKENS.student, 'DELETE', '/userBlocks/student1/blockedUsers/owner1'),
    false,
  );
  check(
    'a client cannot read a server-owned conversation context',
    await call(TOKENS.student, 'GET', '/conversations/conv1/contexts/request-1'),
    false,
  );
  check(
    'a client cannot write a server-owned conversation context',
    await update(TOKENS.owner, 'conversations/conv1/contexts', 'request-1', {
      roomTitle: string('Forged title'),
    }),
    false,
  );
  check(
    'a participant cannot overwrite the server-owned participant names',
    await update(TOKENS.student, 'conversations', 'conv1', {
      participantNames: map({ owner1: string('Forged owner') }),
    }),
    false,
  );
  check(
    'a participant cannot overwrite the server-owned room title',
    await update(TOKENS.student, 'conversations', 'conv1', {
      roomTitle: string('Forged room title'),
    }),
    false,
  );
  check(
    'a participant cannot re-point a conversation to another room',
    await update(TOKENS.student, 'conversations', 'conv1', {
      roomId: string('room2'),
    }),
    false,
  );
  check(
    'the existing chat history stays readable after a block',
    await call(TOKENS.student, 'GET', '/conversations/conv1/messages/msg1'),
    true,
  );
  check(
    'the blocking student cannot send a new message',
    await create(TOKENS.student, 'conversations/conv1/messages', 'msg-blocked-student', {
      messageId: string('msg-blocked-student'),
      conversationId: string('conv1'),
      senderId: string('student1'),
      receiverId: string('owner1'),
      content: string('Blocked message'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'the blocked owner cannot send a new message either',
    await create(TOKENS.owner, 'conversations/conv1/messages', 'msg-blocked-owner', {
      messageId: string('msg-blocked-owner'),
      conversationId: string('conv1'),
      senderId: string('owner1'),
      receiverId: string('student1'),
      content: string('Blocked reply'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    false,
  );
  check(
    'a participant cannot update the last message while the pair is blocked',
    await update(TOKENS.student, 'conversations', 'conv1', {
      lastMessage: string('Bypassing the block'),
      lastMessageAt: timestamp(),
    }),
    false,
  );
  check(
    'a participant can still update unread bookkeeping while blocked',
    await update(TOKENS.student, 'conversations', 'conv1', {
      unreadCount: map({ student1: integer(0), owner1: integer(0) }),
    }),
    true,
  );

  await call('owner', 'DELETE', '/userBlocks/student1/blockedUsers/owner1');
  check(
    'the same participant can send again after the block is removed',
    await create(TOKENS.student, 'conversations/conv1/messages', 'msg-after-unblock', {
      messageId: string('msg-after-unblock'),
      conversationId: string('conv1'),
      senderId: string('student1'),
      receiverId: string('owner1'),
      content: string('Message after unblock'),
      type: string('text'),
      createdAt: timestamp(),
    }),
    true,
  );

  console.log('\n--- server-owned booking and payment collections ---');
  check(
    'student cannot create a join request',
    await create(TOKENS.student, 'joinRequests', 'JRQ-CLIENT', {
      requestId: string('JRQ-CLIENT'),
      roomId: string('room1'),
      studentId: string('student1'),
      ownerId: string('owner1'),
      status: string('pending'),
    }),
    false,
  );
  check(
    'student cannot update a join request',
    await update(TOKENS.student, 'joinRequests', 'JRQ-TEST-1', {
      status: string('cancelled'),
    }),
    false,
  );
  check(
    'owner cannot create a join request',
    await create(TOKENS.owner, 'joinRequests', 'JRQ-OWNER-CLIENT', {
      requestId: string('JRQ-OWNER-CLIENT'),
      roomId: string('room1'),
      studentId: string('student1'),
      ownerId: string('owner1'),
      status: string('pending'),
    }),
    false,
  );
  check(
    'admin cannot create a join request',
    await create(TOKENS.admin, 'joinRequests', 'JRQ-ADMIN-CLIENT', {
      requestId: string('JRQ-ADMIN-CLIENT'),
      roomId: string('room1'),
      studentId: string('student1'),
      ownerId: string('owner1'),
      status: string('pending'),
    }),
    false,
  );
  check(
    'owner cannot update a join request',
    await update(TOKENS.owner, 'joinRequests', 'JRQ-TEST-1', {
      status: string('rejected'),
    }),
    false,
  );
  check(
    'admin cannot update a join request',
    await update(TOKENS.admin, 'joinRequests', 'JRQ-TEST-1', {
      status: string('rejected'),
    }),
    false,
  );
  check(
    'owner cannot delete a join request (the room-deletion callable keeps history)',
    await call(TOKENS.owner, 'DELETE', '/joinRequests/JRQ-TEST-1'),
    false,
  );
  check(
    'admin cannot delete a join request (the room-deletion callable keeps history)',
    await call(TOKENS.admin, 'DELETE', '/joinRequests/JRQ-TEST-1'),
    false,
  );
  check(
    'student cannot delete a payment',
    await call(TOKENS.student, 'DELETE', '/payments/JRQ-TEST-1'),
    false,
  );
  check(
    'student cannot write a payment',
    await create(TOKENS.student, 'payments', 'p-client', {
      requestId: string('JRQ-TEST-1'),
      amount: double(1),
    }),
    false,
  );
  check(
    'student cannot write a room review',
    await create(TOKENS.student, 'roomReviews', 'REV-CLIENT', {
      roomId: string('room1'),
      studentId: string('student1'),
      rating: integer(5),
    }),
    false,
  );
  check(
    'a tenant cannot list the room-review collection directly',
    await call(TOKENS.student, 'GET', '/roomReviews'),
    false,
  );
  check(
    'a tenant cannot read one room-review record directly',
    await readAllowed(TOKENS.student, '/roomReviews/REV-TEST-1'),
    false,
  );
  check(
    'even an administrator cannot bypass the server review boundary',
    await call(TOKENS.admin, 'GET', '/roomReviews'),
    false,
  );
  check(
    'a client cannot read server-only notification attribution',
    await readAllowed(TOKENS.student, '/notificationAttributions/attribution-1'),
    false,
  );
  check(
    'a client cannot read administrator notification delivery state',
    await readAllowed(
      TOKENS.student,
      '/adminMessageNotificationOperations/operation-1',
    ),
    false,
  );
  check(
    'student cannot read an OTP code',
    await readAllowed(TOKENS.student, '/otpCodes/email'),
    false,
  );

  console.log('\n--- admin operations on requests, invoices, rooms, and settings ---');
  check(
    'admin can read the requests list',
    await call(TOKENS.admin, 'GET', '/joinRequests'),
    true,
  );
  check(
    'admin cannot create an invoice (the booking activation owns it)',
    await create(TOKENS.admin, 'commissionInvoices', 'INV-ADMIN', {
      invoiceId: string('INV-ADMIN'),
      ownerId: string('owner1'),
      tenantId: string('student1'),
      commissionAmount: double(3000),
      status: string('paid'),
    }),
    false,
  );
  check(
    'owner cannot create an invoice',
    await create(TOKENS.owner, 'commissionInvoices', 'INV-OWNER', {
      invoiceId: string('INV-OWNER'),
      ownerId: string('owner1'),
      tenantId: string('student1'),
      commissionAmount: double(3000),
      status: string('paid'),
    }),
    false,
  );
  check(
    'admin can mark an invoice paid',
    await update(TOKENS.admin, 'commissionInvoices', 'INV-TEST-1', {
      status: string('paid'),
      paidAt: timestamp(),
      paymentReference: string('upi-test'),
    }),
    true,
  );
  check(
    'owner can read their own invoice',
    await call(TOKENS.owner, 'GET', '/commissionInvoices/INV-TEST-1'),
    true,
  );
  check(
    'owner cannot mark their own invoice paid',
    await update(TOKENS.owner, 'commissionInvoices', 'INV-TEST-1', {
      status: string('paid'),
    }),
    false,
  );
  check(
    'admin cannot tamper with the invoice amount',
    await update(TOKENS.admin, 'commissionInvoices', 'INV-TEST-1', {
      commissionAmount: double(1),
    }),
    false,
  );
  check(
    'admin cannot tamper with the invoice rent',
    await update(TOKENS.admin, 'commissionInvoices', 'INV-TEST-1', {
      monthlyRent: double(1),
    }),
    false,
  );
  check(
    'admin cannot re-point an invoice to another tenant',
    await update(TOKENS.admin, 'commissionInvoices', 'INV-TEST-1', {
      tenantId: string('student2'),
    }),
    false,
  );
  check(
    'admin cannot delete an invoice',
    await call(TOKENS.admin, 'DELETE', '/commissionInvoices/INV-TEST-1'),
    false,
  );

  console.log('\n--- participant access and public settings ---');
  check(
    'student can read their own join request',
    await call(TOKENS.student, 'GET', '/joinRequests/JRQ-TEST-1'),
    true,
  );
  check(
    'stranger cannot read somebody else join request',
    await call(TOKENS.stranger, 'GET', '/joinRequests/JRQ-TEST-1'),
    false,
  );

  // The relationship helpers use the caller's live role, not only the role
  // copied into an already-issued token.
  await call('owner', 'PATCH', '/users/owner1?updateMask.fieldPaths=role', {
    fields: { role: string('student') },
  });
  check(
    'a demoted owner cannot read owner-side join-request data',
    await call(TOKENS.owner, 'GET', '/joinRequests/JRQ-TEST-1'),
    false,
  );
  await call('owner', 'PATCH', '/users/owner1?updateMask.fieldPaths=role', {
    fields: { role: string('owner') },
  });

  await call('owner', 'PATCH', '/users/student1?updateMask.fieldPaths=role', {
    fields: { role: string('owner') },
  });
  check(
    'a demoted student cannot read tenant-side join-request data',
    await call(TOKENS.student, 'GET', '/joinRequests/JRQ-TEST-1'),
    false,
  );
  await call('owner', 'PATCH', '/users/student1?updateMask.fieldPaths=role', {
    fields: { role: string('student') },
  });

  check(
    'a client cannot create a room-deletion tombstone',
    await create(TOKENS.owner, 'roomDeletionTombstones', 'client-tombstone', {
      roomId: string('client-tombstone'),
      ownerId: string('owner1'),
    }),
    false,
  );
  check(
    'a client cannot update a room-deletion tombstone',
    await update(TOKENS.owner, 'roomDeletionTombstones', 'room-admin-tombstone', {
      listingGeneration: string('client-generation'),
    }),
    false,
  );
  check(
    'a client cannot delete a room-deletion tombstone',
    await call(
      TOKENS.owner,
      'DELETE',
      '/roomDeletionTombstones/room-admin-tombstone',
    ),
    false,
  );
  check(
    'a live administrator can read a room-deletion tombstone',
    await call(TOKENS.admin, 'GET', '/roomDeletionTombstones/room-admin-tombstone'),
    true,
  );
  check(
    'a client cannot read a role-claim publication job',
    await call(TOKENS.student, 'GET', '/roleClaimJobs/student1'),
    false,
  );
  check(
    'a client admin cannot write a role-claim publication job',
    await create(TOKENS.admin, 'roleClaimJobs', 'client-role-job', {
      uid: string('student1'),
      type: string('roleClaimPublication'),
      status: string('pending'),
    }),
    false,
  );
  check(
    'a client cannot read server-owned cleanup jobs',
    await call(TOKENS.student, 'GET', '/cleanupJobs/job-1'),
    false,
  );
  check(
    'a client admin cannot read server-owned cleanup jobs',
    await call(TOKENS.admin, 'GET', '/cleanupJobs/job-1'),
    false,
  );
  check(
    'a client cannot read an account-deletion job',
    await call(TOKENS.student, 'GET', '/accountDeletionJobs/job-1'),
    false,
  );
  const accountDeletionJobWrite = await create(
    TOKENS.admin,
    'accountDeletionJobs',
    'job-1',
    {
      uid: string('student1'),
      status: string('pending'),
    },
  );
  checkCondition(
    'a client admin cannot write an account-deletion job',
    accountDeletionJobWrite.status === 403 &&
      String(accountDeletionJobWrite.body?.error?.status || '').includes(
        'PERMISSION_DENIED',
      ),
  );

  check(
    'student can list their own notifications with the app query',
    await filteredList(TOKENS.student, 'notifications', 'userId', 'student1'),
    true,
  );
  check(
    'student cannot list somebody else notifications with a filter',
    await filteredList(TOKENS.student, 'notifications', 'userId', 'someoneelse'),
    false,
  );
  check(
    'student can list their own payments with the app query',
    await filteredList(TOKENS.student, 'payments', 'studentId', 'student1', 'submittedAt'),
    true,
  );
  check(
    'admin can list all payments',
    await filteredList(TOKENS.admin, 'payments', 'status', 'submitted', 'submittedAt'),
    true,
  );
  check(
    'anonymous can read publicSettings',
    await readAllowedAnon('/publicSettings/platform'),
    true,
  );
  check(
    'regular user cannot write publicSettings',
    await update(TOKENS.student, 'publicSettings', 'platform', {
      maintenanceMode: bool(true),
    }),
    false,
  );
  check(
    'admin can write publicSettings',
    await update(TOKENS.admin, 'publicSettings', 'platform', {
      maintenanceMode: bool(false),
    }),
    true,
  );
  check(
    'anonymous cannot write publicSettings',
    await updateAnonSafe('publicSettings', 'platform', {
      maintenanceMode: bool(true),
    }),
    false,
  );

  console.log('\n--- tightening the migration removes the legacy exception ---');
  await call('owner', 'PATCH', '/system/registration?updateMask.fieldPaths=legacyMode', {
    fields: { legacyMode: bool(false) },
  });
  check(
    'legacy account is denied after the marker migration is tightened',
    await call(TOKENS.legacy, 'GET', '/rooms/room1'),
    false,
  );
  check(
    'a completed and active account remains allowed after tightening',
    await call(TOKENS.student, 'GET', '/rooms/room1'),
    true,
  );

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

// A small helper for the anonymous write assertion above.  Keeping it
// separate makes it obvious that no Authorization header is sent.
async function updateAnonSafe(collection, id, fields) {
  const mask = updateMask(fields);
  return callAnon(
    'PATCH',
    `/${collection}/${id}${mask ? `?${mask}` : ''}`,
    { fields },
  );
}

main().catch((error) => {
  console.error('ERROR:', error.message);
  process.exit(2);
});
