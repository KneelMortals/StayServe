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

const TOKENS = {
  student: jwt({ sub: 'student1', user_id: 'student1', role: 'student' }),
  student2: jwt({ sub: 'student2', user_id: 'student2', role: 'student' }),
  bootstrap: jwt({ sub: 'student-bootstrap', user_id: 'student-bootstrap', role: 'student' }),
  bootstrapMissingMarker: jwt({ sub: 'student-bootstrap-missing', user_id: 'student-bootstrap-missing', role: 'student' }),
  bootstrapOldProfile: jwt({ sub: 'student-bootstrap-old', user_id: 'student-bootstrap-old', role: 'student' }),
  bootstrapInactive: jwt({ sub: 'student-bootstrap-inactive', user_id: 'student-bootstrap-inactive', role: 'student' }),
  owner: jwt({ sub: 'owner1', user_id: 'owner1', role: 'owner' }),
  admin: jwt({ sub: 'admin1', user_id: 'admin1', role: 'admin', admin: true }),
  // A stale/forged admin claim without a live admin profile must not work.
  fakeAdmin: jwt({ sub: 'fakeAdmin1', user_id: 'fakeAdmin1', role: 'student', admin: true }),
  stranger: jwt({ sub: 'someoneelse', user_id: 'someoneelse', role: 'student' }),
  pending: jwt({ sub: 'pending1', user_id: 'pending1', role: 'student' }),
  inactive: jwt({ sub: 'inactive1', user_id: 'inactive1', role: 'student' }),
  legacy: jwt({ sub: 'legacy1', user_id: 'legacy1', role: 'student' }),
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

function map(values) {
  return { mapValue: { fields: values } };
}

async function seedUser(uid, {
  role = 'student',
  isActive = true,
  registrationCompleted = true,
  createdAt = new Date().toISOString(),
  includeMarkers = true,
} = {}) {
  const fields = {
    uid: string(uid),
    name: string(uid === 'admin1' ? 'Admin' : uid),
    email: string(`${uid}@example.com`),
    role: string(role),
    createdAt: timestamp(createdAt),
    updatedAt: timestamp(),
  };
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

  await seedUser('student1');
  await seedUser('student2');
  await seedUser('owner1', { role: 'owner' });
  await seedUser('admin1', { role: 'admin' });
  await seedUser('fakeAdmin1');
  await seedUser('someoneelse');
  await seedUser('pending1', { registrationCompleted: false });
  await seedUser('inactive1', { isActive: false });

  // This is the shape of an old profile which predates both marker fields.
  // Its creation time is before the migration cutoff, so it is usable only
  // while legacyMode is true.
  await seedUser('legacy1', {
    includeMarkers: false,
    createdAt: new Date(cutoff.getTime() - 60 * 60 * 1000).toISOString(),
  });

  await seedRoom();

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
    'student can change their own phone',
    await update(TOKENS.student, 'users', 'student1', { phone: string('+919999999999') }),
    true,
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
    'live owner can create a room without server-owned state fields',
    await create(TOKENS.owner, 'rooms', 'owner-room', {
      roomId: string('owner-room'),
      ownerId: string('owner1'),
      title: string('New room'),
      occupancy: integer(2),
      createdAt: timestamp(),
    }),
    true,
  );
  check(
    'live owner can create a room with the initial server-owned state',
    await create(TOKENS.owner, 'rooms', 'owner-room-with-state', {
      roomId: string('owner-room-with-state'),
      ownerId: string('owner1'),
      title: string('New room with state'),
      occupancy: integer(2),
      status: string('available'),
      currentOccupancy: integer(0),
      createdAt: timestamp(),
    }),
    true,
  );
  check(
    'owner cannot create a room that already has tenants',
    await create(TOKENS.owner, 'rooms', 'room-with-occupancy', {
      roomId: string('room-with-occupancy'),
      ownerId: string('owner1'),
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
      title: string('No capacity'),
      occupancy: integer(0),
      createdAt: timestamp(),
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
      images: array(['https://example.test/room.jpg']),
      occupancy: integer(3),
      homeName: string('Updated home'),
      updatedAt: timestamp(),
    }),
    true,
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
    'a client can create a legitimate two-party conversation',
    await create(TOKENS.student, 'conversations', 'conv-legit', {
      conversationId: string('conv-legit'),
      participantIds: array(['student1', 'owner1']),
      lastMessage: string(''),
      createdAt: timestamp(),
    }),
    true,
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
