import * as crypto from 'crypto';
import * as firestore from 'firebase-admin/firestore';
import * as functions from 'firebase-functions/v1';
import * as storage from 'firebase-admin/storage';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import { callableHttps } from './appCheck';
import { assertActiveAccount } from './accounts';
import { detectImageContentType, ROOM_PHOTO_BUCKET } from './roomMedia';

const db = firestore.getFirestore();

/**
 * The bucket which holds the profile pictures.
 *
 * The default is the project's dedicated Firebase Storage bucket — the same
 * one which holds the room photos. The two live in separate namespaces
 * (`profile-images/…` and `rooms/…`), so they can never collide and the
 * room-photo cleanup can never touch a profile picture.
 */
export const PROFILE_PICTURE_BUCKET = String(
  process.env.PROFILE_PICTURE_BUCKET || ROOM_PHOTO_BUCKET,
).trim();

/** The namespace which holds every profile picture. */
export const PROFILE_PICTURE_PREFIX = 'profile-images';

/** The maximum size of one profile picture. */
export const MAX_PROFILE_PICTURE_BYTES = 5 * 1024 * 1024;

/**
 * The content types which may be stored as a profile picture.
 *
 * The type is detected from the **bytes** of the upload, never taken from
 * the client. A file which claims to be a PNG but contains something else is
 * rejected instead of being published as a broken image.
 */
const PROFILE_PICTURE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

/**
 * Whether an upload id is safe to use as a Storage object name.
 *
 * The upload id is chosen by the client, so it may not contain a slash, a
 * dot-dot segment or anything else which could escape the account's own
 * prefix.
 */
export function validProfilePictureUploadId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * The Storage path of one profile picture.
 *
 * The path is derived from the account id and the upload id only. The
 * content type is **not** part of it: a retry of the same upload id
 * therefore always writes to the same object and always produces the same
 * download URL, even when the client picked a different file in between.
 */
export function profilePictureObjectPath(uid: string, uploadId: string): string {
  return `${PROFILE_PICTURE_PREFIX}/${uid}/${uploadId}`;
}

/**
 * The download token of one profile picture.
 *
 * The token is derived from the account and the upload id, so the URL of a
 * repeated upload stays the same. That keeps a retry idempotent: the client
 * can upload the same picture twice without ending up with two URLs for the
 * same object.
 */
export function profilePictureDownloadToken(
  uid: string,
  uploadId: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`profile-picture:${uid}:${uploadId}`)
    .digest('hex');
}

/**
 * Whether a stored URL points at a profile picture of this account.
 *
 * Only the objects of the trusted namespace are owned by the server. A URL
 * which points somewhere else — an external picture a user linked by hand —
 * must never be deleted by the server and must never be published.
 *
 * The Firebase download URL has one of two shapes:
 *
 *   https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}?token=…
 *   https://storage.googleapis.com/{bucket}/{path}?token=…
 *
 * Both carry the object path URL-encoded, so the path is decoded before it
 * is compared with the account's own prefix.
 */
export function isOwnProfilePictureUrl(
  url: string,
  uid: string,
): boolean {
  const trimmed = String(url || '').trim();
  if (!trimmed || !uid) return false;

  // A URL on another host is never an object of the Firebase bucket.
  const host = /^https?:\/\/([^/]+)/i.exec(trimmed);
  if (host) {
    const name = host[1].toLowerCase();
    const trusted =
      name === 'firebasestorage.googleapis.com' ||
      name === 'storage.googleapis.com' ||
      name.endsWith('.storage.googleapis.com') ||
      name.endsWith('.firebasestorage.app');
    if (!trusted) return false;
  }

  let path = trimmed.split('#')[0].split('?')[0];
  const objectMarker = path.lastIndexOf('/o/');
  if (objectMarker >= 0) {
    path = path.slice(objectMarker + 3);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  decoded = decoded.replace(/^\/+/, '');

  // The namespace may be preceded by the bucket name in the GCS-style URL.
  const marker = `${PROFILE_PICTURE_PREFIX}/`;
  const index = decoded.indexOf(marker);
  if (index < 0) return false;

  const rest = decoded.slice(index + marker.length);
  const expected = `${uid}/`;
  if (!rest.startsWith(expected)) return false;

  const fileName = rest.slice(expected.length);
  return fileName.length > 0 && !fileName.includes('/');
}

/**
 * Deletes every profile picture of one account.
 *
 * The account deletion calls this, so a deleted account never leaves its
 * picture behind in the bucket.
 */
export async function deleteProfilePictureObjects(uid: string): Promise<void> {
  const bucket = storage.getStorage().bucket(PROFILE_PICTURE_BUCKET);
  const [files] = await bucket.getFiles({
    prefix: `${PROFILE_PICTURE_PREFIX}/${uid}/`,
  });
  for (const file of files) {
    await file.delete({ ignoreNotFound: true });
  }
}

/**
 * Deletes the profile pictures of one account except the given object.
 *
 * Two devices may upload a picture at the same time. The profile keeps the
 * URL which was written last; the object of the other upload would stay in
 * the bucket forever without this sweep.
 */
async function deleteOtherProfilePictureObjects(
  uid: string,
  keepPath: string,
): Promise<void> {
  const bucket = storage.getStorage().bucket(PROFILE_PICTURE_BUCKET);
  const [files] = await bucket.getFiles({
    prefix: `${PROFILE_PICTURE_PREFIX}/${uid}/`,
  });
  for (const file of files) {
    if (file.name === keepPath) continue;
    await file.delete({ ignoreNotFound: true });
  }
}

/**
 * Reads the picture bytes of a client upload.
 *
 * The data is base64 encoded, exactly like the room-photo upload. The
 * encoded length is checked **before** the buffer is decoded, so a huge
 * payload cannot exhaust the memory of the function.
 */
export function decodeProfilePictureBytes(encoded: string): Buffer {
  const trimmed = String(encoded || '').trim();
  if (!trimmed) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The selected photo is missing.',
    );
  }
  const maximumEncodedLength = Math.ceil((MAX_PROFILE_PICTURE_BYTES * 4) / 3) + 4;
  if (
    trimmed.length > maximumEncodedLength ||
    trimmed.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)
  ) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The selected photo is invalid.',
    );
  }
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length <= 0) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The selected photo is empty.',
    );
  }
  if (bytes.length > MAX_PROFILE_PICTURE_BYTES) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Each profile picture must be 5 MB or smaller.',
    );
  }
  return bytes;
}

/**
 * Stores one profile picture and publishes it on the profile.
 *
 * The object is written by the Admin SDK, so a client can never create an
 * arbitrary object in the bucket. The server validates the live account, the
 * image bytes, the trusted bucket and the exact account path before it
 * writes anything, and it publishes the canonical download URL itself — the
 * client cannot put an arbitrary URL on a profile.
 */
export const uploadProfilePicture = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Please sign in before changing your profile picture.',
    );
  }
  const uid = context.auth.uid;
  await assertActiveAccount(uid);

  const uploadId = String(data?.uploadId || '').trim();
  if (!validProfilePictureUploadId(uploadId)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Invalid upload id.',
    );
  }

  const bytes = decodeProfilePictureBytes(String(data?.data || ''));
  const contentType = detectImageContentType(bytes);
  if (!contentType || PROFILE_PICTURE_CONTENT_TYPES.indexOf(contentType) < 0) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The selected file is not a supported image.',
    );
  }

  const objectPath = profilePictureObjectPath(uid, uploadId);
  const downloadToken = profilePictureDownloadToken(uid, uploadId);
  const userRef = db.collection('users').doc(uid);

  const file = storage.getStorage().bucket(PROFILE_PICTURE_BUCKET).file(objectPath);
  try {
    await file.save(bytes, {
      resumable: false,
      metadata: {
        contentType,
        cacheControl: 'private,max-age=3600',
        metadata: {
          firebaseStorageDownloadTokens: downloadToken,
        },
      },
    });
  } catch (error) {
    console.error('Could not upload a profile picture:', error);
    throw new functions.https.HttpsError(
      'internal',
      'The profile picture could not be uploaded. Try again.',
    );
  }

  let url = '';
  try {
    url = await storage.getDownloadURL(file);
  } catch (error) {
    console.error('Could not create the profile-picture download URL:', error);
    throw new functions.https.HttpsError(
      'internal',
      'The profile picture could not be prepared. Try again.',
    );
  }
  // The URL is only published when it points at the object of this account
  // inside the trusted namespace. A URL which points somewhere else — an
  // external picture a user linked by hand — is never published and never
  // deleted by the server.
  if (!url.includes(downloadToken) || !isOwnProfilePictureUrl(url, uid)) {
    throw new functions.https.HttpsError(
      'internal',
      'The profile-picture storage URL was not trusted.',
    );
  }

  // The profile is published **after** the object exists, so the picture is
  // never broken. The account is checked once more: an account which was
  // deleted while the bytes were transferred must not keep the object.
  try {
    await assertActiveAccount(uid);
    await userRef.update({
      profileImage: url,
      profileImageUpdatedAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    throw error;
  }

  // The replaced picture and the object of a concurrent upload are removed.
  // A failure is not fatal: the picture is already published, and the
  // account deletion sweeps the whole prefix anyway.
  //
  // A picture which points somewhere else — an external URL a user linked
  // by hand — is not owned by the server and is therefore never deleted.
  await deleteOtherProfilePictureObjects(uid, objectPath).catch((error) => {
    console.error('Could not remove the replaced profile picture:', error);
  });

  return {
    success: true,
    url,
    path: objectPath,
    byteLength: bytes.length,
    contentType,
  };
});

/**
 * Removes the profile picture of the signed-in account.
 *
 * The stored object is deleted as well, so a removed picture does not stay
 * in the bucket as an orphan.
 */
export const removeProfilePicture = callableHttps.onCall(async (_data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Please sign in before changing your profile picture.',
    );
  }
  const uid = context.auth.uid;
  await assertActiveAccount(uid);

  const userRef = db.collection('users').doc(uid);
  await userRef.update({
    profileImage: '',
    profileImageUpdatedAt: firestore.FieldValue.serverTimestamp(),
    updatedAt: firestore.FieldValue.serverTimestamp(),
  });

  await deleteProfilePictureObjects(uid);

  return { success: true };
});
