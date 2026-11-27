// Integration regressions for the server-mediated profile-picture protocol.
//
//   node functions/test/profile_media_test.mjs <firestore-port> <project>
//
// The suite uses the Firestore emulator and a deterministic Storage mock.
// It exercises the real callable handlers: the live-account check, the
// image validation, the Admin-SDK write, the canonical URL, the sweep of
// the replaced picture and the removal of the picture.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const PORT = process.argv[2] || '8181';
const PROJECT = process.argv[3] || 'demo-stayserve-profile-media';

process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORT}`;
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GCLOUD_PROJECT_ID = PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT });
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.ROOM_PHOTO_BUCKET =
  process.env.ROOM_PHOTO_BUCKET || 'demo.appspot.com';
process.env.PROFILE_PICTURE_BUCKET =
  process.env.PROFILE_PICTURE_BUCKET || 'demo.appspot.com';

const firestore = require('firebase-admin/firestore');
const authSdk = require('firebase-admin/auth');
const storageSdk = require('firebase-admin/storage');

const objects = new Map();
let bucketName = '';

storageSdk.getStorage = () => ({
  bucket: (requestedBucket) => {
    bucketName = String(requestedBucket || '');
    return {
      name: bucketName,
      file: (objectPath) => ({
        name: objectPath,
        bucket: { name: bucketName },
        save: async (bytes, options = {}) => {
          objects.set(objectPath, {
            bytes: Buffer.from(bytes),
            metadata: options.metadata || {},
          });
        },
        delete: async () => {
          objects.delete(objectPath);
        },
      }),
      getFiles: async ({ prefix } = {}) => {
        const files = [];
        for (const name of Array.from(objects.keys())) {
          if (prefix && !name.startsWith(prefix)) continue;
          files.push({
            name,
            delete: async () => {
              objects.delete(name);
            },
          });
        }
        return [files];
      },
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
  MAX_PROFILE_PICTURE_BYTES,
  PROFILE_PICTURE_PREFIX,
  decodeProfilePictureBytes,
  googleProfilePictureUrl,
  importGoogleProfilePicture,
  isOwnProfilePictureUrl,
  isTrustedGooglePhotoUrl,
  profilePictureDownloadToken,
  profilePictureObjectPath,
  uploadProfilePicture,
  removeProfilePicture,
  validProfilePictureUploadId,
} = require(path.join(ROOT, 'lib', 'profileMedia.js'));

const db = firestore.getFirestore();
const auth = authSdk.getAuth();

const liveUsers = new Set(['profile-media', 'disabled-media', 'unverified-media']);
const verifiedPhoneUsers = new Set(['profile-media', 'disabled-media']);

auth.getUser = async (uid) => {
  if (!liveUsers.has(uid)) {
    const error = new Error('user not found');
    error.code = 'auth/user-not-found';
    throw error;
  }
  const customClaims = verifiedPhoneUsers.has(uid)
    ? { stayServeVerifiedPhone: '+919876500001' }
    : {};
  return {
    uid,
    email: `${uid}@example.test`,
    emailVerified: false,
    phoneNumber: '+919876500001',
    customClaims,
    providerData: [
      { providerId: 'password', uid },
      { providerId: 'phone', uid, phoneNumber: '+919876500001' },
    ],
  };
};

// The Auth record of the account which holds the imported picture.
const authPhotos = new Map();
auth.updateUser = async (uid, properties) => {
  authPhotos.set(uid, properties?.photoURL || '');
  return { uid };
};

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

async function invoke(callable, data, uid = 'profile-media') {
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

/// A minimal JPEG header — the server detects the type from the bytes.
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

async function reset() {
  const users = await db.collection('users').get();
  for (const doc of users.docs) {
    await doc.ref.delete();
  }
  objects.clear();
}

async function seedUser(uid, overrides = {}) {
  await db.collection('users').doc(uid).set({
    uid,
    name: uid,
    email: `${uid}@example.test`,
    role: 'student',
    roleClaimed: true,
    registrationCompleted: true,
    isActive: true,
    phone: '+919876500001',
    phoneVerified: true,
    emailVerified: true,
    authProviders: ['password', 'phone'],
    createdAt: firestore.Timestamp.now(),
    updatedAt: firestore.Timestamp.now(),
    ...overrides,
  });
}

async function main() {
  await reset();
  await seedUser('profile-media');

  section('the upload id and the object path');
  check(
    'a plain upload id is accepted',
    validProfilePictureUploadId('p123abc'),
    true,
  );
  check(
    'an upload id with a slash is refused',
    validProfilePictureUploadId('a/b'),
    false,
  );
  check(
    'an upload id with a dot-dot segment is refused',
    validProfilePictureUploadId('..'),
    false,
  );
  check(
    'an empty upload id is refused',
    validProfilePictureUploadId(''),
    false,
  );
  check(
    'the object path stays inside the account namespace',
    profilePictureObjectPath('uid-1', 'p1'),
    `${PROFILE_PICTURE_PREFIX}/uid-1/p1`,
  );
  check(
    'the download token is stable for the same upload',
    profilePictureDownloadToken('uid-1', 'p1'),
    profilePictureDownloadToken('uid-1', 'p1'),
  );
  check(
    'the download token differs for another account',
    profilePictureDownloadToken('uid-1', 'p1') ===
      profilePictureDownloadToken('uid-2', 'p1'),
    false,
  );

  section('the uploaded bytes');
  check(
    'a small image is decoded',
    decodeProfilePictureBytes(JPEG_BYTES.toString('base64')).length,
    JPEG_BYTES.length,
  );
  await expectFailure(
    'empty data is refused',
    async () => decodeProfilePictureBytes(''),
    'invalid-argument',
  );
  await expectFailure(
    'data which is not base64 is refused',
    async () => decodeProfilePictureBytes('not base64!!'),
    'invalid-argument',
  );
  await expectFailure(
    'an oversized upload is refused',
    async () =>
      decodeProfilePictureBytes(
        Buffer.alloc(MAX_PROFILE_PICTURE_BYTES + 1).toString('base64'),
      ),
    'invalid-argument',
  );

  section('the upload itself');
  const upload = await invoke(uploadProfilePicture, {
    uploadId: 'p-first',
    data: JPEG_BYTES.toString('base64'),
  });
  check('the upload succeeded', upload.success, true);
  check(
    'the object was written into the account namespace',
    Array.from(objects.keys()),
    [`${PROFILE_PICTURE_PREFIX}/profile-media/p-first`],
  );
  check(
    'the published URL points at the stored object',
    isOwnProfilePictureUrl(upload.url, 'profile-media'),
    true,
  );
  check(
    'the URL of another account is not owned by this account',
    isOwnProfilePictureUrl(upload.url, 'another-account'),
    false,
  );
  const profile = await db.collection('users').doc('profile-media').get();
  check(
    'the profile publishes the stored picture',
    profile.get('profileImage'),
    upload.url,
  );
  check(
    'the profile records that the user chose the picture',
    profile.get('profileImageSource'),
    'upload',
  );
  check(
    'the Auth record shows the same picture',
    authPhotos.get('profile-media'),
    upload.url,
  );

  section('a repeated upload');
  const repeated = await invoke(uploadProfilePicture, {
    uploadId: 'p-first',
    data: JPEG_BYTES.toString('base64'),
  });
  check('the repeated upload returns the same URL', repeated.url, upload.url);
  check(
    'the repeated upload did not leave a second object behind',
    objects.size,
    1,
  );

  section('the replaced picture');
  const second = await invoke(uploadProfilePicture, {
    uploadId: 'p-second',
    data: JPEG_BYTES.toString('base64'),
  });
  check('the second upload succeeded', second.success, true);
  check(
    'the replaced object was removed',
    Array.from(objects.keys()),
    [`${PROFILE_PICTURE_PREFIX}/profile-media/p-second`],
  );

  section('the refused uploads');
  await expectFailure(
    'a signed-out caller may not upload',
    async () => invoke(uploadProfilePicture, {
      uploadId: 'p-anonymous',
      data: JPEG_BYTES.toString('base64'),
    }, null),
    'unauthenticated',
  );
  await expectFailure(
    'an invalid upload id is refused',
    async () =>
      invoke(uploadProfilePicture, {
        uploadId: '../escape',
        data: JPEG_BYTES.toString('base64'),
      }),
    'invalid-argument',
  );
  await expectFailure(
    'a file which is not an image is refused',
    async () =>
      invoke(uploadProfilePicture, {
        uploadId: 'p-text',
        data: Buffer.from('this is not an image').toString('base64'),
      }),
    'invalid-argument',
  );
  await expectFailure(
    'a disabled account may not upload',
    async () => {
      await seedUser('disabled-media', { isActive: false });
      return invoke(uploadProfilePicture, {
        uploadId: 'p-disabled',
        data: JPEG_BYTES.toString('base64'),
      }, 'disabled-media');
    },
    'permission-denied',
  );
  await expectFailure(
    'an account without a verified phone may not upload',
    async () => {
      await seedUser('unverified-media', { phoneVerified: false });
      return invoke(uploadProfilePicture, {
        uploadId: 'p-unverified',
        data: JPEG_BYTES.toString('base64'),
      }, 'unverified-media');
    },
    'permission-denied',
  );

  section('the removal');
  const removal = await invoke(removeProfilePicture, {});
  check('the removal succeeded', removal.success, true);
  check('the stored object was deleted', objects.size, 0);
  const cleared = await db.collection('users').doc('profile-media').get();
  check('the profile no longer has a picture', cleared.get('profileImage'), '');
  check(
    'the profile records that the user removed the picture',
    cleared.get('profileImageSource'),
    'removed',
  );
  check(
    'the Auth record no longer shows the picture',
    authPhotos.get('profile-media'),
    '',
  );

  section('the Google profile picture');
  const GOOGLE_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8oc/pic.jpg';
  const originalFetch = globalThis.fetch;
  // Every address which the server asks for.
  const requested = [];
  globalThis.fetch = async (url) => {
    const address = String(url);
    requested.push(address);
    if (!address.startsWith('https://lh3.googleusercontent.com/')) {
      return { ok: false, status: 404, headers: { get: () => '0' } };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(JPEG_BYTES.length) },
      arrayBuffer: async () => JPEG_BYTES.buffer.slice(
        JPEG_BYTES.byteOffset,
        JPEG_BYTES.byteOffset + JPEG_BYTES.byteLength,
      ),
    };
  };
  try {
    await seedUser('google-media');
    const imported = await importGoogleProfilePicture('google-media', GOOGLE_PHOTO);
    check('the picture was imported', typeof imported === 'string', true);
    check(
      'the imported picture is owned by the account',
      isOwnProfilePictureUrl(imported, 'google-media'),
      true,
    );
    check(
      'the object was written into the account namespace',
      Array.from(objects.keys()).every((name) =>
        name.startsWith(`${PROFILE_PICTURE_PREFIX}/google-media/`),
      ),
      true,
    );
    const googleProfile = await db.collection('users').doc('google-media').get();
    check(
      'the profile publishes the imported picture',
      googleProfile.get('profileImage'),
      imported,
    );
    check(
      'the profile records the source of the picture',
      googleProfile.get('profileImageSource'),
      'google',
    );
    check(
      'the Auth record carries the picture as well',
      authPhotos.get('google-media'),
      imported,
    );

    // The picture is imported again on every start of the app. The object
    // which is already there is kept instead of being downloaded once more.
    const downloadsBefore = requested.length;
    const repeated = await importGoogleProfilePicture(
      'google-media',
      GOOGLE_PHOTO,
    );
    check('the repeated import returns the same URL', repeated, imported);
    check(
      'the repeated import did not download the picture again',
      requested.length,
      downloadsBefore,
    );

    // A picture which the user chose by hand is never replaced.
    await seedUser('chosen-media', {
      profileImage: 'https://firebasestorage.googleapis.com/v0/b/demo/o/chosen.jpg',
      profileImageSource: 'upload',
    });
    const skipped = await importGoogleProfilePicture('chosen-media', GOOGLE_PHOTO);
    check('the picture of the user was not replaced', skipped, null);
    const chosen = await db.collection('users').doc('chosen-media').get();
    check(
      'the profile still shows the picture of the user',
      chosen.get('profileImage'),
      'https://firebasestorage.googleapis.com/v0/b/demo/o/chosen.jpg',
    );

    // A picture of a foreign host is never downloaded.
    const foreign = await importGoogleProfilePicture(
      'google-media',
      'https://example.com/pic.jpg',
    );
    check('a foreign picture is refused', foreign, null);

    // A picture which the user removed on purpose stays removed. Without the
    // marker the Google picture would reappear at the next start of the app.
    await seedUser('removed-media', {
      profileImage: '',
      profileImageSource: 'removed',
    });
    const restored = await importGoogleProfilePicture(
      'removed-media',
      GOOGLE_PHOTO,
    );
    check('a removed picture is not restored', restored, null);
    const removedProfile = await db.collection('users').doc('removed-media').get();
    check(
      'the profile of the removed picture stays empty',
      removedProfile.get('profileImage'),
      '',
    );
    check(
      'the marker of the removed picture is kept',
      removedProfile.get('profileImageSource'),
      'removed',
    );

    // Google sometimes answers with the original file, which can be a HEIF
    // picture. No browser can display it, so the server asks for the picture
    // again with a size directive — Google then delivers a JPEG.
    const HEIF_BYTES = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic', 'ascii'),
      Buffer.alloc(16),
    ]);
    globalThis.fetch = async (url) => {
      const address = String(url);
      requested.push(address);
      if (!address.startsWith('https://lh3.googleusercontent.com/')) {
        return { ok: false, status: 404, headers: { get: () => '0' } };
      }
      const isJpeg = address.endsWith('=s1024-c');
      const bytes = isJpeg ? JPEG_BYTES : HEIF_BYTES;
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(bytes.length) },
        arrayBuffer: async () => bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      };
    };
    await seedUser('heif-media');
    const converted = await importGoogleProfilePicture(
      'heif-media',
      'https://lh3.googleusercontent.com/pw/ADCreHee/pic=s0-d-ip',
    );
    check('the HEIF picture was imported as a JPEG', typeof converted === 'string', true);
    check(
      'the picture was asked for again with a size directive',
      requested.some((address) => address.endsWith('=s1024-c')),
      true,
    );
    const heifProfile = await db.collection('users').doc('heif-media').get();
    check(
      'the profile publishes the converted picture',
      heifProfile.get('profileImage'),
      converted,
    );

    // The picture of the Google account changed: the object of the older
    // picture must not stay in the bucket.
    await seedUser('changed-media');
    const first = await importGoogleProfilePicture(
      'changed-media',
      'https://lh3.googleusercontent.com/a/ACg8oc/first.jpg',
    );
    const second = await importGoogleProfilePicture(
      'changed-media',
      'https://lh3.googleusercontent.com/a/ACg8oc/second.jpg',
    );
    check('the newer picture was imported', typeof second === 'string', true);
    check('the picture changed', second !== first, true);
    check(
      'the object of the older picture was removed',
      Array.from(objects.keys()).filter((name) =>
        name.startsWith(`${PROFILE_PICTURE_PREFIX}/changed-media/`),
      ).length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('failed checks:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
