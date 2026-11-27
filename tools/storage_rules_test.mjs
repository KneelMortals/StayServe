// Regression tests for the StayServe Cloud Storage security rules.
//
// The Storage emulator accepts the same unsigned JWT payload as the
// Firestore emulator. `user_id` is the signed-in uid and `admin` is the
// optional custom claim. The live account state is read from Firestore by
// the cross-service `firestore.get(...)` calls in `storage.rules`.
//
// The emulator does not enforce production's two-Firestore-document limit for
// Storage Rules, so the suite also checks the rule source for that invariant.

import { createRequire } from 'node:module';

const PORT = Number(process.argv[2] || 9199);
const PROJECT = process.argv[3] || 'demo-stayserve-rules';
const FIRESTORE_PORT = Number(process.argv[4] || 8181);
const BUCKET = `${PROJECT}.firebasestorage.app`;
const STORAGE_HOST = `http://127.0.0.1:${PORT}`;
process.env.FIREBASE_STORAGE_EMULATOR_HOST = `127.0.0.1:${PORT}`;
const requireFunctions = createRequire(
  new URL('../functions/package.json', import.meta.url),
);
const { initializeApp } = requireFunctions('firebase-admin/app');
const { getStorage } = requireFunctions('firebase-admin/storage');
const FIRESTORE_HOST =
  `http://127.0.0.1:${FIRESTORE_PORT}` +
  `/v1/projects/${PROJECT}/databases/(default)/documents`;

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function jwt(claims) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.`;
}

/**
 * A tenant token with the signed verified-phone proof.
 *
 * The Storage rules require the server-issued `stayServeVerifiedPhone` claim
 * to match the live `phone_number` claim. A token which only carries a phone
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
  owner: tenantToken('owner1', 'owner', '+919876500001'),
  owner2: tenantToken('owner2', 'owner', '+919876500002'),
  student: tenantToken('student1', 'student', '+919876500003'),
  pending: tenantToken('pending1', 'student', '+919876500004'),
  inactive: tenantToken('inactive1', 'owner', '+919876500005'),
  unregistered: tenantToken('unregistered1', 'owner', '+919876500006'),
  unverifiedOwner: jwt({
    sub: 'unverified-owner1',
    user_id: 'unverified-owner1',
    role: 'owner',
  }),
  unverifiedStudent: jwt({
    sub: 'unverified-student1',
    user_id: 'unverified-student1',
    role: 'student',
  }),
  ownerWithoutPhoneToken: jwt({
    sub: 'owner-without-phone-token',
    user_id: 'owner-without-phone-token',
    role: 'owner',
  }),
  ownerWithEmptyPhoneToken: jwt({
    sub: 'owner-with-empty-phone-token',
    user_id: 'owner-with-empty-phone-token',
    role: 'owner',
    phone_number: '',
  }),
  // A number which an administrator attached with the Admin SDK carries the
  // phone attribute but no server-issued proof.
  adminProvisionedOwner: jwt({
    sub: 'admin-provisioned-owner1',
    user_id: 'admin-provisioned-owner1',
    role: 'owner',
    phone_number: '+919876500014',
  }),
  legacyOwner: tenantToken('legacy-owner1', 'owner', '+919876500013'),
  admin: jwt({
    sub: 'admin1',
    user_id: 'admin1',
    role: 'admin',
    admin: true,
  }),
  demotedOwner: tenantToken('owner1', 'owner', '+919876500001'),
  demotedAdmin: jwt({
    sub: 'admin1',
    user_id: 'admin1',
    role: 'admin',
    admin: true,
  }),
};

function string(value) {
  return { stringValue: String(value) };
}

function bool(value) {
  return { booleanValue: Boolean(value) };
}

function timestamp(value = new Date().toISOString()) {
  return { timestampValue: value };
}

async function seedUser(uid, {
  role = 'student',
  isActive = true,
  registrationCompleted = true,
  phoneVerified = role !== 'admin',
  includePhoneVerification = true,
} = {}) {
  const fields = {
    uid: string(uid),
    name: string(uid),
    email: string(`${uid}@example.com`),
    role: string(role),
    isActive: bool(isActive),
    registrationCompleted: bool(registrationCompleted),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  };
  if (includePhoneVerification) {
    fields.phoneVerified = bool(phoneVerified);
  }

  const response = await fetch(`${FIRESTORE_HOST}/users/${uid}`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer owner',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    throw new Error(
      `Could not seed ${uid}: ${response.status} ${await response.text()}`,
    );
  }
}

async function seedRoomDeletionTombstone(roomId) {
  const response = await fetch(
    `${FIRESTORE_HOST}/roomDeletionTombstones/${roomId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          type: string('roomDeletionTombstone'),
          roomId: string(roomId),
          ownerId: string('owner1'),
          listingGeneration: string('server-generation-old'),
          deletionOperationId: string('operation-old'),
          createdAt: timestamp(),
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not seed the room tombstone ${roomId}: ${response.status} ${await response.text()}`,
    );
  }
}

async function seedDeletingRoom(roomId) {
  const response = await fetch(`${FIRESTORE_HOST}/rooms/${roomId}`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer owner',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        roomId: string(roomId),
        ownerId: string('owner1'),
        title: string('Deleting room'),
        monthlyRent: { doubleValue: 10000 },
        occupancy: { integerValue: '2' },
        currentOccupancy: { integerValue: '0' },
        status: string('inactive'),
        listingGeneration: string('server-generation-deleting'),
        deletionInProgress: bool(true),
        createdAt: timestamp(),
        updatedAt: timestamp(),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Could not seed the deleting room ${roomId}: ${response.status} ${await response.text()}`,
    );
  }

  // The production deletion transaction commits the room marker and the
  // durable id-reservation tombstone together. Storage Rules rely on the
  // tombstone so a room-photo write needs only two Firestore documents:
  // the live profile and the tombstone.
  await seedRoomDeletionTombstone(roomId);
}

/**
 * @param {string | null | undefined} token
 * @param {string} method
 * @param {string} objectPath
 * @param {{ body?: BodyInit, contentType?: string }} [options]
 */
async function storageRequest(
  token,
  method,
  objectPath,
  { body, contentType = 'image/jpeg' } = {},
) {
  const encodedPath = encodeURIComponent(objectPath);
  const url =
    method === 'POST'
      ? `${STORAGE_HOST}/v0/b/${BUCKET}/o?name=${encodedPath}`
      : `${STORAGE_HOST}/v0/b/${BUCKET}/o/${encodedPath}`;

  /** @type {Record<string, string>} */
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = contentType;

  const response = await fetch(url, {
    method,
    headers,
    body,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

/**
 * @param {string | null | undefined} token
 * @param {string} objectPath
 * @param {{ bytes?: Uint8Array<ArrayBuffer>, contentType?: string }} [options]
 */
function upload(
  token,
  objectPath,
  {
    bytes = new Uint8Array([
      105, 109, 97, 103, 101, 45, 98, 121, 116, 101, 115,
    ]),
    contentType = 'image/jpeg',
  } = {},
) {
  return storageRequest(token, 'POST', objectPath, {
    body: bytes,
    contentType,
  });
}

function get(token, objectPath) {
  return storageRequest(token, 'GET', objectPath);
}

function remove(token, objectPath) {
  return storageRequest(token, 'DELETE', objectPath);
}

function reason(result) {
  const error = result.body?.error;
  if (!error) return `HTTP ${result.status}`;
  return `${error.code || error.status}: ${error.message || ''}`;
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

const OWN_OBJECT = 'rooms/owner1/room1/photo.jpg';
const OTHER_OBJECT = 'rooms/owner2/room2/photo.jpg';
const ADMIN_OBJECT = 'admin/report.pdf';
const PROFILE_OBJECT = 'profile-images/owner1/picture';
const OTHER_PROFILE_OBJECT = 'profile-images/owner2/picture';
const adminApp = initializeApp(
  {
    projectId: PROJECT,
    storageBucket: BUCKET,
  },
  `storage-rules-seed-${process.pid}`,
);
const adminBucket = getStorage(adminApp).bucket(BUCKET);

async function seedStorageObject(objectPath, bytes = Buffer.from('image')) {
  await adminBucket.file(objectPath).save(bytes, {
    resumable: false,
    metadata: { contentType: 'image/jpeg' },
  });
}

async function main() {
  await seedUser('owner1', { role: 'owner' });
  await seedUser('owner2', { role: 'owner' });
  await seedUser('student1', { role: 'student' });
  await seedUser('unverified-owner1', {
    role: 'owner',
    phoneVerified: false,
  });
  await seedUser('unverified-student1', {
    role: 'student',
    phoneVerified: false,
  });
  // The Firestore cache still says the phone was verified, but this token has
  // no phone provider. The stale grant must not reach Storage.
  await seedUser('owner-without-phone-token', { role: 'owner' });
  await seedUser('owner-with-empty-phone-token', { role: 'owner' });
  await seedUser('legacy-owner1', {
    role: 'owner',
    includePhoneVerification: false,
  });
  await seedUser('pending1', {
    role: 'owner',
    registrationCompleted: false,
  });
  await seedUser('inactive1', {
    role: 'owner',
    isActive: false,
  });
  await seedUser('unregistered1', {
    role: 'owner',
    isActive: false,
    registrationCompleted: false,
  });
  await seedUser('admin1', { role: 'admin' });
  await seedRoomDeletionTombstone('reserved-room');
  await seedDeletingRoom('deleting-room');

  console.log(
    '\n--- clients cannot write the room-photo namespace directly ---',
  );
  check(
    'a live owner may not upload a room photo directly',
    await upload(TOKENS.owner, OWN_OBJECT),
    false,
  );
  check(
    'a live owner may not overwrite their own room photo',
    await upload(TOKENS.owner, OWN_OBJECT),
    false,
  );
  check(
    'a live owner may not write below another owner folder',
    await upload(TOKENS.owner, OTHER_OBJECT),
    false,
  );
  check(
    'a live owner may not upload under a nonexistent room id',
    await upload(TOKENS.owner, 'rooms/owner1/RM-NOT-CREATED/orphan.jpg'),
    false,
  );
  check(
    'a live owner may not upload into a room id reserved by a deletion tombstone',
    await upload(TOKENS.owner, 'rooms/owner1/reserved-room/photo.jpg'),
    false,
  );
  check(
    'a live owner may not upload while the room deletion marker is active',
    await upload(TOKENS.owner, 'rooms/owner1/deleting-room/photo.jpg'),
    false,
  );

  console.log('\n--- every tenant account is denied room-image writes ---');
  check(
    'a live student may not upload a room photo',
    await upload(TOKENS.student, 'rooms/student1/room/photo.jpg'),
    false,
  );
  check(
    'an owner without a verified phone may not upload a room photo',
    await upload(
      TOKENS.unverifiedOwner,
      'rooms/unverified-owner1/room/photo.jpg',
    ),
    false,
  );
  check(
    'an owner with a stale cached phone but no phone token may not upload a room photo',
    await upload(
      TOKENS.ownerWithoutPhoneToken,
      'rooms/owner-without-phone-token/room/photo.jpg',
    ),
    false,
  );
  check(
    'an owner with an empty phone token may not upload a room photo',
    await upload(
      TOKENS.ownerWithEmptyPhoneToken,
      'rooms/owner-with-empty-phone-token/room/photo.jpg',
    ),
    false,
  );
  check(
    'a legacy owner may not bypass the server-mediated upload path',
    await upload(
      TOKENS.legacyOwner,
      'rooms/legacy-owner1/room/photo.jpg',
    ),
    false,
  );
  check(
    'an anonymous caller may not upload a room photo',
    await upload(null, 'rooms/anonymous/room/photo.jpg'),
    false,
  );
  check(
    'an incomplete owner may not upload a room photo',
    await upload(TOKENS.pending, 'rooms/pending1/room/photo.jpg'),
    false,
  );
  check(
    'an inactive owner may not upload a room photo',
    await upload(TOKENS.inactive, 'rooms/inactive1/room/photo.jpg'),
    false,
  );
  check(
    'an unregistered owner may not upload a room photo',
    await upload(TOKENS.unregistered, 'rooms/unregistered1/room/photo.jpg'),
    false,
  );

  console.log('\n--- the admin namespace does not grant access to room photos ---');
  check(
    'a live admin may not overwrite an owner room photo',
    await upload(TOKENS.admin, OWN_OBJECT),
    false,
  );
  check(
    'a live admin may not delete an owner room photo',
    await remove(TOKENS.admin, OWN_OBJECT),
    false,
  );
  check(
    'a live admin may write in the explicit admin namespace',
    await upload(TOKENS.admin, ADMIN_OBJECT, {
      contentType: 'application/pdf',
    }),
    true,
  );

  console.log('\n--- live roles, not stale token claims, control writes ---');
  await seedUser('owner1', { role: 'student' });
  check(
    'an owner demoted to student cannot keep writing with an old token',
    await upload(TOKENS.demotedOwner, OWN_OBJECT),
    false,
  );
  await seedUser('admin1', { role: 'student' });
  check(
    'an admin demoted to student cannot keep writing with an old admin claim',
    await upload(TOKENS.demotedAdmin, ADMIN_OBJECT, {
      contentType: 'application/pdf',
    }),
    false,
  );

  // Restore the owner and administrator for the remaining read/delete
  // checks. The stale-token cases above already proved that the demotion
  // took effect immediately.
  await seedUser('owner1', { role: 'owner' });
  await seedUser('admin1', { role: 'admin' });

  console.log('\n--- room photos are readable by live registered accounts ---');
  await seedStorageObject(OWN_OBJECT);
  await seedStorageObject(OTHER_OBJECT);
  check(
    'the second owner may not create their own room photo directly',
    await upload(TOKENS.owner2, OTHER_OBJECT),
    false,
  );
  check(
    'a live student may read a room photo',
    await get(TOKENS.student, OWN_OBJECT),
    true,
  );
  check(
    'a live owner may read another owner photo',
    await get(TOKENS.owner, OTHER_OBJECT),
    true,
  );
  check(
    'a student without a verified phone may not read a room photo',
    await get(TOKENS.unverifiedStudent, OWN_OBJECT),
    false,
  );
  check(
    'an owner with a stale cached phone but no phone token may not read a room photo',
    await get(TOKENS.ownerWithoutPhoneToken, OWN_OBJECT),
    false,
  );
  check(
    'an owner with an empty phone token may not read a room photo',
    await get(TOKENS.ownerWithEmptyPhoneToken, OWN_OBJECT),
    false,
  );
  // The Admin SDK can attach a phone number to an account without the SMS
  // challenge. The live record then carries the number, but the server never
  // issued the signed proof, so the tenant gate stays closed.
  check(
    'an owner with an administrator-provisioned phone may not read a room photo',
    await get(TOKENS.adminProvisionedOwner, OWN_OBJECT),
    false,
  );
  check(
    'an anonymous caller may not read a room photo',
    await get(null, OWN_OBJECT),
    false,
  );
  check(
    'an inactive account may not read a room photo',
    await get(TOKENS.inactive, OWN_OBJECT),
    false,
  );

  console.log('\n--- metadata cannot bypass the room-namespace denial ---');
  check(
    'an owner may not upload a non-image object',
    await upload(TOKENS.owner, 'rooms/owner1/room1/file.txt', {
      contentType: 'text/plain',
      bytes: Buffer.from('not an image'),
    }),
    false,
  );
  check(
    'an owner may not upload an empty object',
    await upload(TOKENS.owner, 'rooms/owner1/room1/empty.jpg', {
      bytes: Buffer.alloc(0),
    }),
    false,
  );
  check(
    'an owner may not upload an object larger than 5 MiB',
    await upload(TOKENS.owner, 'rooms/owner1/room1/large.jpg', {
      bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
    }),
    false,
  );
  check(
    'an owner may not upload an object of exactly 5 MiB directly',
    await upload(TOKENS.owner, 'rooms/owner1/room1/max.jpg', {
      bytes: Buffer.alloc(5 * 1024 * 1024),
    }),
    false,
  );

  console.log('\n--- room-object deletion is server-owned too ---');
  check(
    'a live owner may not delete their own room photo directly',
    await remove(TOKENS.owner, OWN_OBJECT),
    false,
  );
  check(
    'a live student may not delete a room photo',
    await remove(TOKENS.student, 'rooms/owner1/room1/max.jpg'),
    false,
  );
  check(
    'a live owner may not delete another owner photo',
    await remove(TOKENS.owner, OTHER_OBJECT),
    false,
  );
  check(
    'a live admin may delete an object in the admin namespace',
    await remove(TOKENS.admin, ADMIN_OBJECT),
    true,
  );

  console.log('\n--- the profile-picture namespace is server-mediated too ---');
  await seedStorageObject(PROFILE_OBJECT);
  await seedStorageObject(OTHER_PROFILE_OBJECT);
  check(
    'a live owner may not upload a profile picture directly',
    await upload(TOKENS.owner, PROFILE_OBJECT),
    false,
  );
  check(
    'a live owner may not overwrite their own profile picture',
    await upload(TOKENS.owner, PROFILE_OBJECT),
    false,
  );
  check(
    'a live owner may not write below another account folder',
    await upload(TOKENS.owner, OTHER_PROFILE_OBJECT),
    false,
  );
  check(
    'a live student may not upload a profile picture',
    await upload(TOKENS.student, 'profile-images/student1/picture'),
    false,
  );
  check(
    'an anonymous caller may not upload a profile picture',
    await upload(null, 'profile-images/anonymous/picture'),
    false,
  );
  check(
    'a live admin may not upload a profile picture directly',
    await upload(TOKENS.admin, PROFILE_OBJECT),
    false,
  );
  check(
    'a live owner may not delete their own profile picture directly',
    await remove(TOKENS.owner, PROFILE_OBJECT),
    false,
  );
  check(
    'a live student may read a profile picture',
    await get(TOKENS.student, PROFILE_OBJECT),
    true,
  );
  check(
    'a live owner may read another account profile picture',
    await get(TOKENS.owner, OTHER_PROFILE_OBJECT),
    true,
  );
  check(
    'a student without a verified phone may not read a profile picture',
    await get(TOKENS.unverifiedStudent, PROFILE_OBJECT),
    false,
  );
  check(
    'an anonymous caller may not read a profile picture',
    await get(null, PROFILE_OBJECT),
    false,
  );
  check(
    'an inactive account may not read a profile picture',
    await get(TOKENS.inactive, PROFILE_OBJECT),
    false,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
