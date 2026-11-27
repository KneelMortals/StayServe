// Focused tests for the pure profile-picture helpers.
//
//   npm run build
//   node test/profile_media_unit_test.mjs
//
// The helpers are loaded from the compiled output, so these checks run
// against exactly the code that is deployed.
//
// The regression they protect: the profile picture is uploaded by the
// server into a trusted namespace. The helpers decide which object paths
// the server may write and which URLs it may publish and delete — a
// mistake there would let a client put an arbitrary URL on a profile or
// make the account deletion remove an object of somebody else.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const {
  MAX_PROFILE_PICTURE_BYTES,
  PROFILE_PICTURE_PREFIX,
  decodeProfilePictureBytes,
  googlePhotoJpegUrl,
  googleProfilePictureUrl,
  isOwnProfilePictureUrl,
  isTrustedGooglePhotoUrl,
  profilePictureDownloadToken,
  profilePictureObjectPath,
  validProfilePictureUploadId,
} = require(path.join(HERE, '..', 'lib', 'profileMedia.js'));

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

function refuses(label, operation) {
  try {
    operation();
    check(label, 'accepted', 'refused');
  } catch (error) {
    check(label, String(error?.code || error?.message || error), 'invalid-argument');
  }
}

section('the upload id');
check('a plain upload id is accepted', validProfilePictureUploadId('p123abc'), true);
check(
  'an upload id with a dash and an underscore is accepted',
  validProfilePictureUploadId('p-123_abc'),
  true,
);
check('an empty upload id is refused', validProfilePictureUploadId(''), false);
check('an upload id with a slash is refused', validProfilePictureUploadId('a/b'), false);
check(
  'an upload id with a dot-dot segment is refused',
  validProfilePictureUploadId('..'),
  false,
);
check(
  'an upload id with a dot is refused',
  validProfilePictureUploadId('picture.jpg'),
  false,
);
check(
  'an upload id which is too long is refused',
  validProfilePictureUploadId('a'.repeat(65)),
  false,
);
check(
  'an upload id with a space is refused',
  validProfilePictureUploadId('a b'),
  false,
);

section('the object path');
check(
  'the path stays inside the account namespace',
  profilePictureObjectPath('uid-1', 'p1'),
  `${PROFILE_PICTURE_PREFIX}/uid-1/p1`,
);
check(
  'the path does not contain the upload id twice',
  profilePictureObjectPath('uid-1', 'p1').split('/').length,
  3,
);

section('the download token');
check(
  'the token is stable for the same upload',
  profilePictureDownloadToken('uid-1', 'p1'),
  profilePictureDownloadToken('uid-1', 'p1'),
);
check(
  'the token differs for another account',
  profilePictureDownloadToken('uid-1', 'p1') ===
    profilePictureDownloadToken('uid-2', 'p1'),
  false,
);
check(
  'the token differs for another upload',
  profilePictureDownloadToken('uid-1', 'p1') ===
    profilePictureDownloadToken('uid-1', 'p2'),
  false,
);
check(
  'the token is a hex digest',
  /^[0-9a-f]{64}$/.test(profilePictureDownloadToken('uid-1', 'p1')),
  true,
);

section('the ownership of a URL');
const token = profilePictureDownloadToken('uid-1', 'p1');
check(
  'the SDK download URL belongs to the account',
  isOwnProfilePictureUrl(
    `https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/` +
      `${encodeURIComponent(`${PROFILE_PICTURE_PREFIX}/uid-1/p1`)}` +
      `?alt=media&token=${token}`,
    'uid-1',
  ),
  true,
);
check(
  'the GCS download URL belongs to the account',
  isOwnProfilePictureUrl(
    `https://storage.googleapis.com/demo.appspot.com/` +
      `${PROFILE_PICTURE_PREFIX}/uid-1/p1?alt=media&token=${token}`,
    'uid-1',
  ),
  true,
);
check(
  'a plain object path belongs to the account',
  isOwnProfilePictureUrl(`${PROFILE_PICTURE_PREFIX}/uid-1/p1`, 'uid-1'),
  true,
);
check(
  'the URL of another account is not owned by this account',
  isOwnProfilePictureUrl(
    `https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/` +
      `${encodeURIComponent(`${PROFILE_PICTURE_PREFIX}/uid-2/p1`)}` +
      `?alt=media&token=${token}`,
    'uid-1',
  ),
  false,
);
check(
  'an external picture is never owned by the account',
  isOwnProfilePictureUrl('https://example.com/avatar.png', 'uid-1'),
  false,
);
check(
  'a URL on a foreign host is never owned by the account',
  isOwnProfilePictureUrl(
    `https://evil.example/v0/b/demo.appspot.com/o/` +
      `${encodeURIComponent(`${PROFILE_PICTURE_PREFIX}/uid-1/p1`)}`,
    'uid-1',
  ),
  false,
);
check(
  'a room photo is never owned by the account',
  isOwnProfilePictureUrl('rooms/uid-1/room1/photo.jpg', 'uid-1'),
  false,
);
check(
  'a nested path is never owned by the account',
  isOwnProfilePictureUrl(`${PROFILE_PICTURE_PREFIX}/uid-1/other/p1`, 'uid-1'),
  false,
);
check('an empty URL is never owned by the account', isOwnProfilePictureUrl('', 'uid-1'), false);
check(
  'a malformed URL is never owned by the account',
  isOwnProfilePictureUrl(`${PROFILE_PICTURE_PREFIX}/uid-1/%E0%A4%A`, 'uid-1'),
  false,
);

section('the uploaded bytes');
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);
check(
  'a small image is decoded',
  decodeProfilePictureBytes(jpeg.toString('base64')).length,
  jpeg.length,
);
refuses('empty data is refused', () => decodeProfilePictureBytes(''));
refuses(
  'data which is not base64 is refused',
  () => decodeProfilePictureBytes('not base64!!'),
);
refuses(
  'data with a broken length is refused',
  () => decodeProfilePictureBytes('AAAAA'),
);
refuses(
  'an oversized upload is refused',
  () =>
    decodeProfilePictureBytes(
      Buffer.alloc(MAX_PROFILE_PICTURE_BYTES + 1).toString('base64'),
    ),
);
check(
  'the maximum size is still accepted',
  decodeProfilePictureBytes(
    Buffer.alloc(MAX_PROFILE_PICTURE_BYTES).toString('base64'),
  ).length,
  MAX_PROFILE_PICTURE_BYTES,
);

section('the Google profile picture');
check(
  'a picture of Google is trusted',
  isTrustedGooglePhotoUrl('https://lh3.googleusercontent.com/a/ACg8oc/pic.jpg'),
  true,
);
check(
  'a picture of another Google host is trusted',
  isTrustedGooglePhotoUrl('https://photos.googleusercontent.com/pic.jpg'),
  true,
);
check(
  'an insecure address is refused',
  isTrustedGooglePhotoUrl('http://lh3.googleusercontent.com/pic.jpg'),
  false,
);
check(
  'a foreign host is refused',
  isTrustedGooglePhotoUrl('https://example.com/pic.jpg'),
  false,
);
check(
  'a host which only looks like Google is refused',
  isTrustedGooglePhotoUrl('https://lh3.googleusercontent.com.evil.example/pic.jpg'),
  false,
);
check(
  'a host without the dot is refused',
  isTrustedGooglePhotoUrl('https://notgoogleusercontent.com/pic.jpg'),
  false,
);
check('an empty address is refused', isTrustedGooglePhotoUrl(''), false);
check(
  'a malformed address is refused',
  isTrustedGooglePhotoUrl('not a url'),
  false,
);
check(
  'the picture of the Google provider is used',
  googleProfilePictureUrl({
    photoURL: '',
    providerData: [
      { providerId: 'password', photoURL: '' },
      {
        providerId: 'google.com',
        photoURL: 'https://lh3.googleusercontent.com/a/ACg8oc/pic.jpg',
      },
    ],
  }),
  'https://lh3.googleusercontent.com/a/ACg8oc/pic.jpg',
);
check(
  'a picture which the user uploaded is not taken from the account',
  googleProfilePictureUrl({
    photoURL: 'https://firebasestorage.googleapis.com/v0/b/demo/o/pic.jpg',
    providerData: [{ providerId: 'phone', photoURL: '' }],
  }),
  '',
);
check(
  'an account without a Google identity has no picture',
  googleProfilePictureUrl({
    photoURL: '',
    providerData: [{ providerId: 'phone', photoURL: '' }],
  }),
  '',
);

section('the address of a Google picture');
check(
  'an address without a directive gets a size directive',
  googlePhotoJpegUrl('https://lh3.googleusercontent.com/a/ACg8oc/pic.jpg'),
  'https://lh3.googleusercontent.com/a/ACg8oc/pic.jpg=s1024-c',
);
check(
  'the directive of the original picture is replaced',
  googlePhotoJpegUrl(
    'https://lh3.googleusercontent.com/pw/ADCreHee/pic=s0-d-ip',
  ),
  'https://lh3.googleusercontent.com/pw/ADCreHee/pic=s1024-c',
);
check(
  'a query string is kept',
  googlePhotoJpegUrl(
    'https://lh3.googleusercontent.com/a/ACg8oc/pic=s96-c?sz=100',
  ),
  'https://lh3.googleusercontent.com/a/ACg8oc/pic=s1024-c?sz=100',
);
check('an empty address stays empty', googlePhotoJpegUrl(''), '');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('failed checks:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
