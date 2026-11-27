import * as crypto from 'crypto';
import * as firestore from 'firebase-admin/firestore';
import * as functions from 'firebase-functions/v1';
import * as storage from 'firebase-admin/storage';
import * as auth from 'firebase-admin/auth';

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
 * The hosts which may serve the profile picture of a Google account.
 *
 * Only Google itself may serve such a picture. The check keeps the server
 * from downloading an arbitrary address which a client put into the profile.
 */
const GOOGLE_PHOTO_HOST_PATTERN = /(^|\.)googleusercontent\.com$/i;

/** The maximum size of a downloaded Google profile picture. */
export const MAX_GOOGLE_PHOTO_BYTES = 2 * 1024 * 1024;

/** The time a download of a Google profile picture may take. */
const GOOGLE_PHOTO_TIMEOUT_MS = 10_000;

/**
 * The size of the picture which Google itself is asked for.
 *
 * The picture is scaled by Google, so the server needs no image library.
 */
const GOOGLE_PHOTO_SIZE = 1024;

/**
 * Whether a URL points at a profile picture which Google itself serves.
 */
export function isTrustedGooglePhotoUrl(url: string): boolean {
  const trimmed = String(url || '').trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return GOOGLE_PHOTO_HOST_PATTERN.test(parsed.hostname.toLowerCase());
}

/**
 * Rewrites the address of a Google picture so that Google returns a JPEG.
 *
 * Google serves the **original** file when the address carries a directive
 * which keeps the original format (`=s0-d`). That original can be a HEIF
 * picture, which neither a browser nor the app is able to display — and it
 * is often bigger than the limit of the download.
 *
 * A size directive makes Google deliver a JPEG instead: the picture is
 * scaled by Google itself, so the server does not need an image library.
 */
export function googlePhotoJpegUrl(url: string): string {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  // The directive is the part behind the last "=" of the path. A query string
  // or a fragment is kept as it is.
  const suffixStart = trimmed.search(/[?#]/);
  const path = suffixStart >= 0 ? trimmed.slice(0, suffixStart) : trimmed;
  const suffix = suffixStart >= 0 ? trimmed.slice(suffixStart) : '';
  const lastSlash = path.lastIndexOf('/');
  const lastEquals = path.lastIndexOf('=');
  const base = lastEquals > lastSlash ? path.slice(0, lastEquals) : path;
  return `${base}=s${GOOGLE_PHOTO_SIZE}-c${suffix}`;
}

/**
 * The profile picture of the Google identity of an account.
 *
 * The picture of the Google provider is preferred: the picture of the account
 * itself may be a StayServe picture which the user uploaded by hand. An empty
 * string is returned when the account has no Google picture.
 */
export function googleProfilePictureUrl(user: {
  photoURL?: string | null;
  providerData?: Array<{
    providerId?: string | null;
    photoURL?: string | null;
  }>;
}): string {
  const providers = Array.isArray(user.providerData) ? user.providerData : [];
  const google = providers.find(
    (provider) => String(provider.providerId || '') === 'google.com',
  );
  const candidate = String(google?.photoURL || user.photoURL || '').trim();
  return isTrustedGooglePhotoUrl(candidate) ? candidate : '';
}

/**
 * Downloads one Google picture.
 *
 * The download is bounded: it is aborted after ten seconds and a picture
 * which is larger than two megabytes is refused. A redirect is **not**
 * followed, because the redirect could point at any host.
 */
async function fetchGooglePhoto(url: string): Promise<Buffer | null> {
  if (!isTrustedGooglePhotoUrl(url)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_PHOTO_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif' },
    });
    if (!response.ok) return null;
    const announced = Number(response.headers.get('content-length') || '0');
    if (announced > MAX_GOOGLE_PHOTO_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_GOOGLE_PHOTO_BYTES) return null;
    return bytes;
  } catch (error) {
    console.warn('Could not download a Google profile picture:', error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Downloads a Google profile picture in a format every client can display.
 *
 * Google sometimes answers with the original file, which can be a HEIF
 * picture. Such a picture is asked for again with a size directive, so that
 * Google delivers a JPEG of it.
 */
export async function downloadGooglePhoto(url: string): Promise<Buffer | null> {
  if (!isTrustedGooglePhotoUrl(url)) return null;

  const direct = await fetchGooglePhoto(url);
  if (direct) {
    const contentType = detectImageContentType(direct);
    if (contentType && PROFILE_PICTURE_CONTENT_TYPES.indexOf(contentType) >= 0) {
      return direct;
    }
  }

  const rewritten = googlePhotoJpegUrl(url);
  if (rewritten && rewritten !== url) {
    const converted = await fetchGooglePhoto(rewritten);
    if (converted) {
      const contentType = detectImageContentType(converted);
      if (
        contentType &&
        PROFILE_PICTURE_CONTENT_TYPES.indexOf(contentType) >= 0
      ) {
        return converted;
      }
    }
  }

  return null;
}


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
 * The object path of a stored profile picture.
 *
 * The path is read out of the download URL. Both URL shapes are understood:
 *
 *   https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}?token=…
 *   https://storage.googleapis.com/{bucket}/{path}?token=…
 *
 * An empty string is returned when the URL does not point at the profile
 * namespace.
 */
export function profilePictureObjectPathOf(url: string): string {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';

  let path = trimmed.split('#')[0].split('?')[0];
  const objectMarker = path.lastIndexOf('/o/');
  if (objectMarker >= 0) {
    path = path.slice(objectMarker + 3);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return '';
  }
  decoded = decoded.replace(/^\/+/, '');

  const marker = `${PROFILE_PICTURE_PREFIX}/`;
  const index = decoded.indexOf(marker);
  if (index < 0) return '';
  return decoded.slice(index);
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

  const objectPath = profilePictureObjectPathOf(trimmed);
  if (!objectPath) return false;

  const expected = `${PROFILE_PICTURE_PREFIX}/${uid}/`;
  if (!objectPath.startsWith(expected)) return false;

  const fileName = objectPath.slice(expected.length);
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
 * Imports the profile picture of the Google identity of an account.
 *
 * A Google account already carries a name and a picture. The picture is
 * copied into the trusted bucket by the server, so the profile shows exactly
 * the same picture everywhere and the client never has to write into the
 * storage namespace.
 *
 * The import never overwrites a picture which the user chose by hand: it
 * only fills an empty profile or replaces an older Google picture.
 */
export async function importGoogleProfilePicture(
  uid: string,
  photoUrl: string,
): Promise<string | null> {
  const trimmed = String(photoUrl || '').trim();
  if (!trimmed || !isTrustedGooglePhotoUrl(trimmed)) return null;

  const userRef = db.collection('users').doc(uid);
  const snapshot = await userRef.get();
  if (!snapshot.exists) return null;

  const currentUrl = String(snapshot.get('profileImage') || '').trim();
  const currentSource = String(snapshot.get('profileImageSource') || '').trim();
  if (currentSource === 'upload' || currentSource === 'removed') {
    // The user picked this picture by hand, or removed it on purpose. The
    // Google picture must not come back on the next synchronisation — that
    // would silently undo what the user just did.
    return null;
  }
  if (currentUrl && currentSource !== 'google') {
    // An unknown source: the picture was not written by the server, so it is
    // not owned by the server either.
    return null;
  }

  // The upload id is derived from the address of the picture, so a repeated
  // import writes the same object and produces the same URL.
  const uploadId = `google-${crypto
    .createHash('sha256')
    .update(trimmed)
    .digest('hex')
    .slice(0, 24)}`;
  const objectPath = profilePictureObjectPath(uid, uploadId);

  if (
    currentUrl &&
    profilePictureObjectPathOf(currentUrl) === objectPath &&
    isOwnProfilePictureUrl(currentUrl, uid)
  ) {
    // The very same picture was imported before. It is downloaded again on
    // every start of the app, so the existing object is kept instead of
    // transferring the picture once more.
    return currentUrl;
  }

  const bytes = await downloadGooglePhoto(trimmed);
  if (!bytes) return null;

  const contentType = detectImageContentType(bytes);
  if (!contentType || PROFILE_PICTURE_CONTENT_TYPES.indexOf(contentType) < 0) {
    return null;
  }

  const downloadToken = profilePictureDownloadToken(uid, uploadId);
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
    console.error('Could not store the Google profile picture:', error);
    return null;
  }

  let url = '';
  try {
    url = await storage.getDownloadURL(file);
  } catch (error) {
    console.error('Could not create the profile-picture download URL:', error);
    await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    return null;
  }
  if (!url.includes(downloadToken) || !isOwnProfilePictureUrl(url, uid)) {
    await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    return null;
  }

  // The account may have been deleted while the picture was downloaded.
  try {
    await userRef.update({
      profileImage: url,
      profileImageUpdatedAt: firestore.FieldValue.serverTimestamp(),
      profileImageSource: 'google',
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    await file.delete({ ignoreNotFound: true }).catch(() => undefined);
    return null;
  }

  // The Auth record carries the same picture, so the other Firebase surfaces
  // — the account switcher of the operating system for example — show it as
  // well. A failure here does not affect the profile.
  try {
    await auth.getAuth().updateUser(uid, { photoURL: url });
  } catch (error) {
    console.warn(
      'Could not write the Google picture to the Auth record:',
      error,
    );
  }

  // The picture of the Google account changed: the object of the older
  // picture would stay in the bucket forever without this sweep. A picture
  // which the user chose by hand is never touched — such an account is not
  // imported at all.
  await deleteOtherProfilePictureObjects(uid, objectPath).catch((error) => {
    console.error('Could not remove the replaced Google picture:', error);
  });

  return url;
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
      profileImageSource: 'upload',
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

  // The Auth record carries the picture as well, so the other Firebase
  // surfaces show the same picture. A failure here does not affect the
  // profile.
  try {
    await auth.getAuth().updateUser(uid, { photoURL: url });
  } catch (error) {
    console.warn(
      'Could not write the profile picture to the Auth record:',
      error,
    );
  }

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
    // The marker keeps a later Google synchronisation from importing the
    // picture of the Google account again. Without it the picture would
    // reappear at the next start of the app, although the user removed it on
    // purpose.
    profileImageSource: 'removed',
    profileImageUpdatedAt: firestore.FieldValue.serverTimestamp(),
    updatedAt: firestore.FieldValue.serverTimestamp(),
  });

  await deleteProfilePictureObjects(uid);

  // The Auth record carries the picture as well, so the other Firebase
  // surfaces — the account switcher of the operating system for example —
  // would still show it. A failure here does not affect the profile.
  //
  // The picture is deleted with a **null** address: an empty string is not
  // a valid URL and the Auth service refuses it with
  // `auth/invalid-photo-url`.
  try {
    await auth.getAuth().updateUser(uid, { photoURL: null });
  } catch (error) {
    console.warn(
      'Could not clear the profile picture on the Auth record:',
      error,
    );
  }

  return { success: true };
});
