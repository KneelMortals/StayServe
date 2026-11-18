// Regression tests for the StayServe Cloud Storage security rules.
//
// The Storage emulator accepts the same unsigned JWT payload as the
// Firestore emulator. `user_id` is the signed-in uid and `admin` is the
// optional custom claim. The live account state is read from Firestore by
// the cross-service `firestore.get(...)` calls in `storage.rules`.
//
// The emulator does not enforce production's two-Firestore-document limit for
// Storage Rules, so the suite also checks the rule source for that invariant.

import { readFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9199);
const PROJECT = process.argv[3] || 'demo-stayserve-rules';
const FIRESTORE_PORT = Number(process.argv[4] || 8181);
const BUCKET = `${PROJECT}.firebasestorage.app`;
const STORAGE_HOST = `http://127.0.0.1:${PORT}`;
const FIRESTORE_HOST =
  `http://127.0.0.1:${FIRESTORE_PORT}` +
  `/v1/projects/${PROJECT}/databases/(default)/documents`;

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function jwt(claims) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.`;
}

const TOKENS = {
  owner: jwt({ sub: 'owner1', user_id: 'owner1', role: 'owner' }),
  owner2: jwt({ sub: 'owner2', user_id: 'owner2', role: 'owner' }),
  student: jwt({ sub: 'student1', user_id: 'student1', role: 'student' }),
  pending: jwt({ sub: 'pending1', user_id: 'pending1', role: 'student' }),
  inactive: jwt({ sub: 'inactive1', user_id: 'inactive1', role: 'owner' }),
  unregistered: jwt({
    sub: 'unregistered1',
    user_id: 'unregistered1',
    role: 'owner',
  }),
  admin: jwt({
    sub: 'admin1',
    user_id: 'admin1',
    role: 'admin',
    admin: true,
  }),
  demotedOwner: jwt({ sub: 'owner1', user_id: 'owner1', role: 'owner' }),
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
} = {}) {
  const response = await fetch(`${FIRESTORE_HOST}/users/${uid}`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer owner',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        uid: string(uid),
        name: string(uid),
        email: string(`${uid}@example.com`),
        role: string(role),
        isActive: bool(isActive),
        registrationCompleted: bool(registrationCompleted),
        createdAt: timestamp(),
        updatedAt: timestamp(),
      },
    }),
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

async function main() {
  await seedUser('owner1', { role: 'owner' });
  await seedUser('owner2', { role: 'owner' });
  await seedUser('student1', { role: 'student' });
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
    '\n--- room-photo write stays within the production Firestore access limit ---',
  );
  const storageRulesSource = readFileSync(
    new URL('../storage.rules', import.meta.url),
    'utf8',
  );
  const roomPhotoGuard =
    storageRulesSource.match(
      /function roomPhotoWriteIsAllowed\([^)]*\)\s*\{[\s\S]*?\n    \}/,
    )?.[0] || '';
  const roomPhotoGuardReadsRoomDocument =
    roomPhotoGuard.includes('/documents/rooms/');
  const roomPhotoGuardChecksTombstone =
    roomPhotoGuard.includes('/documents/roomDeletionTombstones/');
  check(
    'the room-photo guard does not read a third Firestore document',
    roomPhotoGuardReadsRoomDocument
      ? { status: 400, body: { error: { message: 'room document read' } } }
      : { status: 200, body: {} },
    !roomPhotoGuardReadsRoomDocument,
  );
  check(
    'the room-photo guard uses the durable deletion tombstone',
    roomPhotoGuardChecksTombstone
      ? { status: 200, body: {} }
      : { status: 400, body: { error: { message: 'tombstone read missing' } } },
    true,
  );

  console.log('\n--- live owners may write only below their own folder ---');
  check(
    'a live owner may upload a room photo',
    await upload(TOKENS.owner, OWN_OBJECT),
    true,
  );
  check(
    'a live owner may overwrite their own room photo',
    await upload(TOKENS.owner, OWN_OBJECT),
    true,
  );
  check(
    'a live owner may not write below another owner folder',
    await upload(TOKENS.owner, OTHER_OBJECT),
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

  console.log('\n--- every other account is denied room-image writes ---');
  check(
    'a live student may not upload a room photo',
    await upload(TOKENS.student, 'rooms/student1/room/photo.jpg'),
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
  check(
    'the second owner may create their own room photo',
    await upload(TOKENS.owner2, OTHER_OBJECT),
    true,
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
    'an anonymous caller may not read a room photo',
    await get(null, OWN_OBJECT),
    false,
  );
  check(
    'an inactive account may not read a room photo',
    await get(TOKENS.inactive, OWN_OBJECT),
    false,
  );

  console.log('\n--- image type and size are validated ---');
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
    'an owner may upload an object of exactly 5 MiB',
    await upload(TOKENS.owner, 'rooms/owner1/room1/max.jpg', {
      bytes: Buffer.alloc(5 * 1024 * 1024),
    }),
    true,
  );

  console.log('\n--- deletes follow the same owner boundary ---');
  check(
    'a live owner may delete their own room photo',
    await remove(TOKENS.owner, OWN_OBJECT),
    true,
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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
