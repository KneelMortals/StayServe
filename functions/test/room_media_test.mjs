// Integration regressions for the server-mediated room-photo protocol.
//
//   node functions/test/room_media_test.mjs <firestore-port> <project>
//
// The suite uses the Firestore emulator and a deterministic Storage mock.
// It exercises the real callable handlers, transactions, quota accounting,
// canonical URL checks and cleanup state transitions.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const PORT = process.argv[2] || '8181';
const PROJECT = process.argv[3] || 'demo-stayserve-room-media';

process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORT}`;
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GCLOUD_PROJECT_ID = PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT });
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.ROOM_PHOTO_BUCKET =
  process.env.ROOM_PHOTO_BUCKET || 'demo.appspot.com';

const firestore = require('firebase-admin/firestore');
const authSdk = require('firebase-admin/auth');
const storageSdk = require('firebase-admin/storage');

const objects = new Map();
const storageWrites = [];
let bucketName = '';
let beforeStorageSave = null;
let afterStorageSave = null;
let storageSaveDelayMs = 0;

storageSdk.getStorage = () => ({
  bucket: (requestedBucket) => {
    bucketName = String(requestedBucket || '');
    return {
      file: (objectPath) => ({
        name: objectPath,
        bucket: { name: bucketName },
        save: async (bytes, options = {}) => {
          const token =
            options.metadata?.metadata?.firebaseStorageDownloadTokens || '';
          if (beforeStorageSave) await beforeStorageSave(objectPath, token);
          if (storageSaveDelayMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, storageSaveDelayMs),
            );
          }
          objects.set(objectPath, {
            bytes: Buffer.from(bytes),
            metadata: options.metadata || {},
          });
          storageWrites.push({ objectPath, token });
          if (afterStorageSave) await afterStorageSave(objectPath, token);
        },
        delete: async () => {
          if (!objects.has(objectPath)) {
            const error = new Error('not found');
            error.code = 404;
            throw error;
          }
          objects.delete(objectPath);
        },
      }),
    };
  },
});
storageSdk.getDownloadURL = async (file) => {
  const stored = objects.get(file.name);
  const token =
    stored?.metadata?.metadata?.firebaseStorageDownloadTokens || 'test-token';
  return (
    `https://firebasestorage.googleapis.com/v0/b/${file.bucket.name}/o/` +
    `${encodeURIComponent(file.name)}?alt=media&token=${token}`
  );
};

const {
  ROOM_PHOTO_BUCKET,
  MAX_PENDING_ROOM_PHOTO_UPLOADS,
  MAX_ROOM_PHOTO_BYTES,
  isCanonicalRoomImageUrl,
  stageRoomPhoto,
  commitRoomPhotoChanges,
  discardRoomPhotoUpload,
  cleanupExpiredRoomPhotoUploads,
} = require(path.join(ROOT, 'lib', 'roomMedia.js'));

const db = firestore.getFirestore();
const auth = authSdk.getAuth();

auth.getUser = async (uid) => ({
  uid,
  email: `${uid}@example.test`,
  emailVerified: false,
  phoneNumber: '+919876500001',
  // The server-issued proof that the account completed Firebase's phone
  // challenge. A linked phone without this fact is not verified.
  customClaims: { stayServeVerifiedPhone: '+919876500001' },
  providerData: [
    { providerId: 'password', uid },
    { providerId: 'phone', uid, phoneNumber: '+919876500001' },
  ],
});

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(
      `  FAIL  ${label}  expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function invoke(callable, data, uid = 'owner-media') {
  return callable.run(data, {
    auth: uid
      ? {
          uid,
          token: {
            email: `${uid}@example.test`,
            email_verified: true,
            phone_number: '+919876500001',
            stayServeVerifiedPhone: '+919876500001',
          },
        }
      : undefined,
    rawRequest: {},
    instanceIdToken: null,
  });
}

async function expectFailure(label, operation, expectedCode) {
  try {
    await operation();
    check(label, 'accepted', expectedCode);
  } catch (error) {
    check(label, String(error?.code || error?.message || error), expectedCode);
  }
}

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0xff, 0xd9,
]);
const OTHER_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0xff, 0xd9,
]);

async function seedOwner(uid) {
  await db.collection('users').doc(uid).set(
    {
      uid,
      role: 'owner',
      registrationCompleted: true,
      isActive: true,
      phoneVerified: true,
      phone: '+919876500001',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { merge: true },
  );
}

async function seedRoom(roomId, ownerId, images = []) {
  await db.collection('rooms').doc(roomId).set(
    {
      roomId,
      ownerId,
      title: `Room ${roomId}`,
      monthlyRent: 12000,
      securityDeposit: 6000,
      occupancy: 2,
      currentOccupancy: 0,
      status: 'available',
      images,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { merge: true },
  );
}

async function reset() {
  const collections = [
    'users',
    'rooms',
    'roomDrafts',
    'roomPhotoUploadOperations',
    'roomPhotoUploadQuotas',
    'roomPhotoRoomQuotas',
    'roomPhotoCommitOperations',
  ];
  for (const collection of collections) {
    const snapshot = await db.collection(collection).get();
    await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
  }
  objects.clear();
}

async function stage(
  roomId,
  uploadId,
  bytes = JPEG,
  uid = 'owner-media',
  plannedRemovalUrls = [],
) {
  const result = await invoke(
    stageRoomPhoto,
    {
      roomId,
      uploadId,
      data: bytes.toString('base64'),
      removeUrls: plannedRemovalUrls,
    },
    uid,
  );
  return result;
}

async function main() {
  await reset();
  await seedOwner('owner-media');
  await seedOwner('other-owner-media');
  await seedRoom('room-media', 'owner-media');
  await seedRoom('quota-room-media', 'owner-media');
  await seedRoom('other-room-media', 'other-owner-media');

  section('room-photo staging is bound to a live owner and listing');
  const staged = await stage('room-media', 'upload-one');
  const stagedUrl = new URL(staged.url);
  check(
    'the staged URL uses the trusted bucket and exact owner/room path',
    [
      stagedUrl.protocol,
      stagedUrl.hostname,
      stagedUrl.pathname,
      stagedUrl.searchParams.get('alt'),
      Boolean(stagedUrl.searchParams.get('token')),
    ],
    [
      'https:',
      'firebasestorage.googleapis.com',
      `/v0/b/${ROOM_PHOTO_BUCKET}/o/` +
        encodeURIComponent('rooms/owner-media/room-media/room-photo-upload-one'),
      'media',
      true,
    ],
  );
  check(
    'the server set a private download token while uploading',
    /^[0-9a-f-]{36}$/.test(
      objects.get('rooms/owner-media/room-media/room-photo-upload-one')?.metadata
        ?.metadata?.firebaseStorageDownloadTokens || '',
    ),
    true,
  );
  check(
    'the server wrote exactly one canonical room object',
    [...objects.keys()],
    ['rooms/owner-media/room-media/room-photo-upload-one'],
  );
  check(
    'the staged photo reserved one room slot',
    (
      await db.collection('roomPhotoRoomQuotas').doc('room-media').get()
    ).get('pendingCount'),
    1,
  );
  check(
    'the canonical URL accepts only the exact trusted owner/room path',
    [
      isCanonicalRoomImageUrl(
        staged.url,
        'owner-media',
        'room-media',
        'rooms/owner-media/room-media/room-photo-upload-one',
      ),
      isCanonicalRoomImageUrl(
        staged.url,
        'other-owner-media',
        'room-media',
        'rooms/owner-media/room-media/room-photo-upload-one',
      ),
      isCanonicalRoomImageUrl(
        staged.url,
        'owner-media',
        'other-room-media',
        'rooms/owner-media/room-media/room-photo-upload-one',
      ),
      isCanonicalRoomImageUrl(
        staged.url.replace(ROOM_PHOTO_BUCKET, 'attacker.appspot.com'),
        'owner-media',
        'room-media',
        'rooms/owner-media/room-media/room-photo-upload-one',
      ),
    ],
    [true, false, false, false],
  );

  const retried = await stage('room-media', 'upload-one');
  check('the same upload id is idempotent', retried.url, staged.url);
  check(
    'the idempotent retry did not consume another pending slot',
    [
      (
        await db
          .collection('roomPhotoUploadQuotas')
          .doc('owner-media')
          .get()
      ).get('pendingCount'),
      (
        await db.collection('roomPhotoRoomQuotas').doc('room-media').get()
      ).get('pendingCount'),
    ],
    [1, 1],
  );
  await expectFailure(
    'the same upload id cannot be reused for different bytes',
    () => stage('room-media', 'upload-one', OTHER_JPEG),
    'failed-precondition',
  );
  await expectFailure(
    'an owner cannot stage a photo for a nonexistent listing',
    () => stage('room-media-not-created', 'upload-missing-room'),
    'not-found',
  );
  await expectFailure(
    'an owner cannot stage a photo for another owner listing',
    () => stage('other-room-media', 'upload-other-room', JPEG, 'owner-media'),
    'permission-denied',
  );
  await expectFailure(
    'a non-image payload is rejected before Storage is written',
    () =>
      stage(
        'room-media',
        'upload-not-image',
        Buffer.from('this is not an image'),
      ),
    'invalid-argument',
  );
  await expectFailure(
    'malformed base64 is rejected before Storage is written',
    () =>
      invoke(
        stageRoomPhoto,
        {
          roomId: 'room-media',
          uploadId: 'upload-malformed-base64',
          data: 'not-valid-base64!',
        },
        'owner-media',
      ),
    'invalid-argument',
  );
  await expectFailure(
    'a photo larger than 5 MiB is rejected before Storage is written',
    () =>
      stage(
        'room-media',
        'upload-too-large',
        Buffer.alloc(MAX_ROOM_PHOTO_BYTES + 1),
      ),
    'invalid-argument',
  );
  await expectFailure(
    'an unauthenticated caller cannot stage a photo',
    () =>
      invoke(
        stageRoomPhoto,
        {
          roomId: 'room-media',
          uploadId: 'upload-anonymous',
          data: JPEG.toString('base64'),
        },
        null,
      ),
    'unauthenticated',
  );

  section('the server commits canonical images atomically');
  const oldUrl =
    `https://firebasestorage.googleapis.com/v0/b/${ROOM_PHOTO_BUCKET}/o/` +
    `${encodeURIComponent('rooms/owner-media/room-media/old-photo')}` +
    '?alt=media&token=old-token';
  await seedRoom('room-media', 'owner-media', [oldUrl]);
  const committedUpload = await stage('room-media', 'upload-two');
  const commit = await invoke(commitRoomPhotoChanges, {
    roomId: 'room-media',
    commitId: 'commit-one',
    uploadIds: ['upload-two'],
    removeUrls: [oldUrl],
  });
  check(
    'the commit returns the final canonical image list',
    commit.images,
    [committedUpload.url],
  );
  check(
    'the live listing contains the committed canonical URL',
    (
      await db.collection('rooms').doc('room-media').get()
    ).get('images'),
    [committedUpload.url],
  );
  check(
    'the committed operation released its pending quota',
    [
      (
        await db
          .collection('roomPhotoUploadQuotas')
          .doc('owner-media')
          .get()
      ).get('pendingCount'),
      (
        await db.collection('roomPhotoRoomQuotas').doc('room-media').get()
      ).get('pendingCount'),
    ],
    [1, 1],
  );

  const repeatedCommit = await invoke(commitRoomPhotoChanges, {
    roomId: 'room-media',
    commitId: 'commit-one',
    uploadIds: ['upload-two'],
    removeUrls: [oldUrl],
  });
  check(
    'the same commit id is idempotent',
    repeatedCommit.alreadyCommitted,
    true,
  );
  check(
    'the idempotent commit did not duplicate the image',
    (
      await db.collection('rooms').doc('room-media').get()
    ).get('images'),
    [committedUpload.url],
  );
  await expectFailure(
    'the same commit id cannot be reused for different changes',
    () =>
      invoke(commitRoomPhotoChanges, {
        roomId: 'room-media',
        commitId: 'commit-one',
        uploadIds: ['upload-two'],
        removeUrls: [],
      }),
    'failed-precondition',
  );

  const demotedUpload = await stage('room-media', 'upload-demoted-owner');
  await db.collection('users').doc('owner-media').update({ role: 'student' });
  await expectFailure(
    'a demoted owner cannot commit a staged photo',
    () =>
      invoke(commitRoomPhotoChanges, {
        roomId: 'room-media',
        commitId: 'commit-demoted-owner',
        uploadIds: [demotedUpload.uploadId],
        removeUrls: [],
      }),
    'permission-denied',
  );
  await db.collection('users').doc('owner-media').update({ role: 'owner' });
  await invoke(discardRoomPhotoUpload, {
    roomId: 'room-media',
    uploadId: demotedUpload.uploadId,
  });

  const staleUpload = await stage('room-media', 'upload-stale-generation');
  const liveGeneration = (
    await db.collection('rooms').doc('room-media').get()
  ).get('listingGeneration');
  await db.collection('rooms').doc('room-media').update({
    listingGeneration: 'replacement-listing-generation',
  });
  await expectFailure(
    'a staged photo from an earlier listing generation cannot be committed',
    () =>
      invoke(commitRoomPhotoChanges, {
        roomId: 'room-media',
        commitId: 'commit-stale-generation',
        uploadIds: [staleUpload.uploadId],
        removeUrls: [],
      }),
    'failed-precondition',
  );
  await db.collection('rooms').doc('room-media').update({
    listingGeneration: liveGeneration,
  });
  await invoke(discardRoomPhotoUpload, {
    roomId: 'room-media',
    uploadId: staleUpload.uploadId,
  });

  const fullRoomId = 'full-room-media';
  const fullRoomImages = Array.from({ length: 10 }, (_, index) =>
    `https://firebasestorage.googleapis.com/v0/b/${ROOM_PHOTO_BUCKET}/o/` +
    `${encodeURIComponent(
      `rooms/owner-media/${fullRoomId}/existing-${index}`,
    )}?alt=media&token=existing-${index}`,
  );
  await seedRoom(fullRoomId, 'owner-media', fullRoomImages);
  await expectFailure(
    'a full room cannot reserve another photo slot',
    () => stage(fullRoomId, 'upload-full-room'),
    'resource-exhausted',
  );
  const replacementUpload = await stage(
    fullRoomId,
    'upload-room-replacement',
    JPEG,
    'owner-media',
    [fullRoomImages[0]],
  );
  check(
    'a planned replacement reserves the freed room slot',
    replacementUpload.uploadId,
    'upload-room-replacement',
  );
  await invoke(discardRoomPhotoUpload, {
    roomId: fullRoomId,
    uploadId: replacementUpload.uploadId,
  });

  section('unreferenced uploads are discarded and quota-bound');
  await invoke(discardRoomPhotoUpload, {
    roomId: 'room-media',
    uploadId: 'upload-one',
  });
  const discarded = await stage('room-media', 'upload-discard');
  const discardedPath = discarded.path;
  const discardResult = await invoke(discardRoomPhotoUpload, {
    roomId: 'room-media',
    uploadId: 'upload-discard',
  });
  check(
    'an unreferenced staged object is discarded',
    discardResult.discarded,
    true,
  );
  check('the discarded object no longer exists', objects.has(discardedPath), false);
  check(
    'the discard released the pending quota',
    [
      (
        await db
          .collection('roomPhotoUploadQuotas')
          .doc('owner-media')
          .get()
      ).get('pendingCount'),
      (
        await db.collection('roomPhotoRoomQuotas').doc('room-media').get()
      ).get('pendingCount'),
    ],
    [0, 0],
  );

  const pendingIds = [];
  for (let index = 0; index < MAX_PENDING_ROOM_PHOTO_UPLOADS; index += 1) {
    const uploadId = `quota-${String(index).padStart(2, '0')}`;
    pendingIds.push(uploadId);
    await stage('quota-room-media', uploadId);
  }
  await expectFailure(
    'the pending upload count is capped',
    () => stage('room-media', 'quota-over-limit'),
    'resource-exhausted',
  );

  const expiredUpload = pendingIds[0];
  const expiredOperation = await db
    .collection('roomPhotoUploadOperations')
    .where('uploadId', '==', expiredUpload)
    .limit(1)
    .get();
  const expiredRef = expiredOperation.docs[0].ref;
  const expiredPath = expiredOperation.docs[0].get('objectPath');
  await expiredRef.update({
    cleanupAfter: new Date(Date.now() - 60_000),
  });
  const cleanup = await cleanupExpiredRoomPhotoUploads();
  check(
    'the expired unreferenced object was swept',
    cleanup.cleaned >= 1,
    true,
  );
  check('the swept object no longer exists', objects.has(expiredPath), false);

  const tamperedUpload = await stage('quota-room-media', 'upload-tampered-path');
  const tamperedOperation = await db
    .collection('roomPhotoUploadOperations')
    .where('uploadId', '==', 'upload-tampered-path')
    .limit(1)
    .get();
  const tamperedRef = tamperedOperation.docs[0].ref;
  const unrelatedPath =
    'rooms/owner-media/quota-room-media/not-the-authorized-upload-path';
  objects.set(unrelatedPath, {
    bytes: Buffer.from('must not be deleted'),
    metadata: {},
  });
  await tamperedRef.update({
    objectPath: unrelatedPath,
    cleanupAfter: new Date(Date.now() - 60_000),
  });
  const tamperedCleanup = await cleanupExpiredRoomPhotoUploads();
  check(
    'a tampered upload operation is quarantined',
    tamperedCleanup.quarantined >= 1,
    true,
  );
  check(
    'the tampered operation is durably quarantined',
    (await tamperedRef.get()).get('status'),
    'quarantined',
  );
  check(
    'cleanup never deletes the unrelated tampered path',
    objects.has(unrelatedPath),
    true,
  );
  check(
    'cleanup deletes the exact authorized path even after metadata corruption',
    objects.has(
      'rooms/owner-media/quota-room-media/room-photo-upload-tampered-path',
    ),
    false,
  );

  section('a referenced photo is never discarded by a stale client');
  await reset();
  await seedOwner('owner-media');
  await seedRoom('room-media', 'owner-media');
  const referencedUpload = await stage('room-media', 'upload-referenced');
  const referencedCommit = await invoke(commitRoomPhotoChanges, {
    roomId: 'room-media',
    commitId: 'commit-referenced',
    uploadIds: ['upload-referenced'],
    removeUrls: [],
  });
  check(
    'the referenced photo was committed to the listing',
    referencedCommit.images,
    [referencedUpload.url],
  );
  const referencedDiscard = await invoke(discardRoomPhotoUpload, {
    roomId: 'room-media',
    uploadId: 'upload-referenced',
  });
  check(
    'a discard of a referenced photo is refused',
    [referencedDiscard.discarded, referencedDiscard.referenced],
    [false, true],
  );
  check(
    'the referenced object still exists',
    objects.has(referencedUpload.path),
    true,
  );
  check(
    'the listing still references the photo',
    (await db.collection('rooms').doc('room-media').get()).get('images'),
    [referencedUpload.url],
  );

  section('the cleanup worker skips a photo which was committed meanwhile');
  const referencedOperation = await db
    .collection('roomPhotoUploadOperations')
    .where('uploadId', '==', 'upload-referenced')
    .limit(1)
    .get();
  await referencedOperation.docs[0].ref.update({
    cleanupAfter: new Date(Date.now() - 60_000),
  });
  const referencedCleanup = await cleanupExpiredRoomPhotoUploads();
  check(
    'the cleanup reported the referenced operation',
    referencedCleanup.referenced >= 1,
    true,
  );
  check(
    'the cleanup did not delete the committed object',
    objects.has(referencedUpload.path),
    true,
  );
  check(
    'the committed operation kept its referenced status',
    (
      await db
        .collection('roomPhotoUploadOperations')
        .where('uploadId', '==', 'upload-referenced')
        .limit(1)
        .get()
    ).docs[0].get('status'),
    'referenced',
  );

  section('concurrent retries of one upload id keep one download token');
  await reset();
  await seedOwner('owner-media');
  await seedRoom('room-media', 'owner-media');
  const [concurrentA, concurrentB] = await Promise.all([
    stage('room-media', 'upload-concurrent'),
    stage('room-media', 'upload-concurrent'),
  ]);
  check(
    'both concurrent retries returned the same URL',
    concurrentA.url === concurrentB.url,
    true,
  );
  const concurrentTokens = storageWrites
    .filter((write) => write.objectPath === concurrentA.path)
    .map((write) => write.token);
  check(
    'every concurrent write used the same download token',
    [
      concurrentTokens.length >= 1,
      concurrentTokens.every((token) => token === concurrentTokens[0]),
    ],
    [true, true],
  );
  check(
    'the persisted operation kept that download token',
    (
      await db
        .collection('roomPhotoUploadOperations')
        .where('uploadId', '==', 'upload-concurrent')
        .limit(1)
        .get()
    ).docs[0].get('downloadToken'),
    concurrentTokens[0],
  );

  section('an expired upload is refused by the stage and by the commit');
  await reset();
  await seedOwner('owner-media');
  await seedRoom('room-media', 'owner-media');
  const expiringUpload = await stage('room-media', 'upload-expiring');
  const expiringOperation = await db
    .collection('roomPhotoUploadOperations')
    .where('uploadId', '==', 'upload-expiring')
    .limit(1)
    .get();
  await expiringOperation.docs[0].ref.update({
    cleanupAfter: new Date(Date.now() - 60_000),
  });
  await expectFailure(
    'an expired upload cannot be staged again',
    () => stage('room-media', 'upload-expiring'),
    'failed-precondition',
  );
  await expectFailure(
    'an expired upload cannot be committed',
    () =>
      invoke(commitRoomPhotoChanges, {
        roomId: 'room-media',
        commitId: 'commit-expiring',
        uploadIds: ['upload-expiring'],
        removeUrls: [],
      }),
    'failed-precondition',
  );
  check(
    'the expired upload never reached the listing',
    (await db.collection('rooms').doc('room-media').get()).get('images'),
    [],
  );
  check(
    'the expired upload kept its object until the cleanup runs',
    objects.has(expiringUpload.path),
    true,
  );

  section('a room-id reuse does not spend the replacement quota');
  await reset();
  await seedOwner('owner-media');
  await seedRoom('room-media', 'owner-media');
  const generationUpload = await stage('room-media', 'upload-generation');
  const firstGeneration = (
    await db.collection('rooms').doc('room-media').get()
  ).get('listingGeneration');
  check(
    'the staged upload recorded the live listing generation',
    (
      await db
        .collection('roomPhotoUploadOperations')
        .where('uploadId', '==', 'upload-generation')
        .limit(1)
        .get()
    ).docs[0].get('listingGeneration'),
    firstGeneration,
  );
  // The room id is reused by a later listing: the live room and the room
  // quota now belong to a different generation.
  await db.collection('rooms').doc('room-media').update({
    listingGeneration: 'replacement-generation',
  });
  await db.collection('roomPhotoRoomQuotas').doc('room-media').set({
    roomId: 'room-media',
    ownerId: 'owner-media',
    listingGeneration: 'replacement-generation',
    pendingCount: 3,
    pendingBytes: 4096,
  });
  const generationOperation = await db
    .collection('roomPhotoUploadOperations')
    .where('uploadId', '==', 'upload-generation')
    .limit(1)
    .get();
  await generationOperation.docs[0].ref.update({
    cleanupAfter: new Date(Date.now() - 60_000),
  });
  await cleanupExpiredRoomPhotoUploads();
  check(
    'the replacement generation kept its pending room quota',
    (
      await db.collection('roomPhotoRoomQuotas').doc('room-media').get()
    ).get('pendingCount'),
    3,
  );
  check(
    'the stale object of the earlier generation was removed',
    objects.has(generationUpload.path),
    false,
  );

  section('an account deletion during an in-flight upload removes the object');
  await reset();
  await seedOwner('owner-media');
  await seedRoom('room-media', 'owner-media');
  const inFlightPath = 'rooms/owner-media/room-media/room-photo-upload-inflight';
  beforeStorageSave = async () => {
    // The owner is deleted while the bytes are still being written.
    await db.collection('users').doc('owner-media').delete();
  };
  await expectFailure(
    'an in-flight upload of a deleted owner fails',
    () => stage('room-media', 'upload-inflight'),
    'permission-denied',
  );
  beforeStorageSave = null;
  check(
    'the in-flight object of the deleted owner was removed',
    objects.has(inFlightPath),
    false,
  );

  section('a failed quarantine write stays observable and retryable');
  await reset();
  await seedOwner('owner-media');
  await seedRoom('room-media', 'owner-media');
  await stage('room-media', 'upload-quarantine-failure');
  const quarantineOperation = await db
    .collection('roomPhotoUploadOperations')
    .where('uploadId', '==', 'upload-quarantine-failure')
    .limit(1)
    .get();
  const quarantineRef = quarantineOperation.docs[0].ref;
  await quarantineRef.update({
    // A malformed identity cannot be repaired: the quarantine path has to
    // release the trustworthy owner quota and record the failure.
    roomId: 'room media invalid',
    cleanupAfter: new Date(Date.now() - 60_000),
  });
  const originalRunTransaction = db.runTransaction.bind(db);
  let injectedFailure = false;
  db.runTransaction = async (...args) => {
    if (!injectedFailure) {
      injectedFailure = true;
      throw new Error('simulated quarantine transaction failure');
    }
    return originalRunTransaction(...args);
  };
  let failedQuarantine;
  try {
    failedQuarantine = await cleanupExpiredRoomPhotoUploads();
  } finally {
    db.runTransaction = originalRunTransaction;
  }
  check(
    'the failed quarantine was reported',
    failedQuarantine.failed >= 1,
    true,
  );
  const quarantineState = await quarantineRef.get();
  check(
    'the failed quarantine recorded the error',
    String(quarantineState.get('lastError') || '').includes(
      'Failed to quarantine malformed operation',
    ),
    true,
  );
  check(
    'the failed quarantine recorded an attempt',
    quarantineState.get('attempts'),
    1,
  );
  check(
    'the failed quarantine scheduled a retry',
    quarantineState.get('cleanupAfter') != null,
    true,
  );
  check(
    'the failed quarantine did not mark the operation as cleaned',
    quarantineState.get('status') === 'cleaned',
    false,
  );

  section('a staged photo is only public through its committed URL');
  await reset();
  await seedOwner('owner-media');
  await seedRoom('room-media', 'owner-media');
  const publicUpload = await stage('room-media', 'upload-public');
  const publicUrl = new URL(publicUpload.url);
  check(
    'the staged URL carries a high entropy download token',
    /^[0-9a-f-]{36}$/.test(publicUrl.searchParams.get('token') || ''),
    true,
  );
  check(
    'the staged URL is bound to the exact object path',
    publicUrl.pathname,
    `/v0/b/${ROOM_PHOTO_BUCKET}/o/` +
      encodeURIComponent('rooms/owner-media/room-media/room-photo-upload-public'),
  );
  check(
    'a staged photo is not published in the listing before the commit',
    (await db.collection('rooms').doc('room-media').get()).get('images'),
    [],
  );
  await invoke(commitRoomPhotoChanges, {
    roomId: 'room-media',
    commitId: 'commit-public',
    uploadIds: ['upload-public'],
    removeUrls: [],
  });
  check(
    'the committed listing publishes exactly the canonical URL',
    (await db.collection('rooms').doc('room-media').get()).get('images'),
    [publicUpload.url],
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(`Failed checks: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
