import * as crypto from 'crypto';
import * as firestore from 'firebase-admin/firestore';
import * as functions from 'firebase-functions/v1';
import * as storage from 'firebase-admin/storage';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import { callableHttps } from './appCheck';
import {
  assertLiveOwner,
  assertLiveOwnerProfileSnapshot,
} from './accounts';

/**
 * The only bucket which may hold StayServe room photos.
 *
 * The value is server configuration, not a client input. A production
 * deployment may override it, but the default is the project's dedicated
 * Firebase Storage bucket.
 */
export const ROOM_PHOTO_BUCKET = String(
  process.env.ROOM_PHOTO_BUCKET || 'myfirstapp-fa30f52b.firebasestorage.app',
).trim();

/** The maximum size of one room photo. */
export const MAX_ROOM_PHOTO_BYTES = 5 * 1024 * 1024;

/** The maximum number of photos attached to one listing. */
export const MAX_ROOM_PHOTOS = 10;

/** The maximum number of uncommitted uploads one owner may have pending. */
export const MAX_PENDING_ROOM_PHOTO_UPLOADS = 10;

/** The maximum number of uncommitted photo bytes one owner may reserve. */
export const MAX_PENDING_ROOM_PHOTO_BYTES = 50 * 1024 * 1024;

/** The maximum number of photo uploads one owner may start in a quota window. */
export const MAX_ROOM_PHOTO_WINDOW_UPLOADS = 40;

/** The maximum number of photo bytes one owner may start in a quota window. */
export const MAX_ROOM_PHOTO_WINDOW_BYTES = 100 * 1024 * 1024;

/** How long the fixed upload-quota window lasts. */
const ROOM_PHOTO_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long an upload may wait for the room-list commit before it is swept. */
const ROOM_PHOTO_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** The first retry delay after a failed Storage delete. */
const ROOM_PHOTO_CLEANUP_RETRY_MS = 15 * 60 * 1000;

/** The longest delay between retries of a failed Storage delete. */
const ROOM_PHOTO_CLEANUP_MAX_RETRY_MS = 24 * 60 * 60 * 1000;

const db = firestore.getFirestore();

type RoomPhotoUploadStatus =
  | 'reserved'
  | 'uploaded'
  | 'referenced'
  | 'deleting'
  | 'cleaned'
  | 'quarantined'
  | 'discarded';

interface RoomPhotoQuotaState {
  pendingCount: number;
  pendingBytes: number;
  windowStartedAtMillis: number;
  windowUploadCount: number;
  windowUploadBytes: number;
}

interface UploadReservation {
  shouldUpload: boolean;
  uploadId: string;
  ownerId: string;
  roomId: string;
  listingGeneration: string;
  objectPath: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  /**
   * The one download token which belongs to this upload id.
   *
   * It is persisted in the upload-operation document before Storage is
   * written. Every retry of the same upload id reuses this value, so the
   * object metadata and the stored download URL can never disagree.
   */
  downloadToken: string;
  url?: string;
}

interface CommitResult {
  images: string[];
  alreadyCommitted: boolean;
}

function timestampMillis(value: unknown, fallback = 0): number {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    return Number((value as { toMillis: () => number }).toMillis());
  }
  if (value instanceof Date) return value.getTime();
  return fallback;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed && !result.includes(trimmed)) result.push(trimmed);
  }
  return result;
}

function uniqueStringList(value: unknown, maximum: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The room-photo change list is invalid.',
    );
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'The room-photo change list is invalid.',
      );
    }
    const trimmed = item.trim();
    if (result.includes(trimmed)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'The room-photo change list contains a duplicate.',
      );
    }
    result.push(trimmed);
  }
  return result;
}

function operationDocumentId(ownerId: string, uploadId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${ownerId}:${uploadId}`)
    .digest('hex');
  return `upload-${digest}`;
}

function commitDocumentId(ownerId: string, commitId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${ownerId}:${commitId}`)
    .digest('hex');
  return `commit-${digest}`;
}

function quotaDocumentId(ownerId: string): string {
  return ownerId;
}

function quotaState(snapshot: firestore.DocumentSnapshot): RoomPhotoQuotaState {
  const now = Date.now();
  const windowStartedAtMillis = timestampMillis(
    snapshot.get('windowStartedAt'),
    now,
  );
  return {
    pendingCount: nonNegativeInteger(snapshot.get('pendingCount')),
    pendingBytes: nonNegativeInteger(snapshot.get('pendingBytes')),
    windowStartedAtMillis,
    windowUploadCount: nonNegativeInteger(snapshot.get('windowUploadCount')),
    windowUploadBytes: nonNegativeInteger(snapshot.get('windowUploadBytes')),
  };
}

/** The download token carried by one canonical room-photo URL. */
function roomPhotoDownloadToken(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    return new URL(value.trim()).searchParams.get('token')?.trim() || '';
  } catch (_) {
    return '';
  }
}

/**
 * Whether one pending upload has passed its one expiry deadline.
 *
 * `cleanupAfter` is the single deadline used by stage, commit and cleanup.
 * A retry cannot move it forward, so an expired upload is never revived.
 */
function roomPhotoUploadExpired(
  operation: Record<string, any>,
  now = Date.now(),
): boolean {
  return timestampMillis(operation.cleanupAfter, 0) <= now;
}

function roomObjectPath(ownerId: string, roomId: string, uploadId: string): string {
  return `rooms/${ownerId}/${roomId}/room-photo-${uploadId}`;
}

function validIdentifier(value: string, maximum: number): boolean {
  return new RegExp(`^[A-Za-z0-9_-]{1,${maximum}}$`).test(value);
}

/**
 * Returns the immutable generation of the current room lifetime.
 *
 * A listing which predates generation fencing receives one before its first
 * server-mediated photo operation. The caller persists the generated value
 * in the same transaction as the upload reservation, so the staged upload can
 * never be committed to a later listing which happens to reuse the room id.
 */
function roomListingGeneration(room: Record<string, any>): string {
  const existing = String(room.listingGeneration || '').trim();
  return existing || crypto.randomUUID();
}

/**
 * Whether one listing still has a photo which was staged but not committed.
 *
 * A staged photo only belongs to the listing once the commit attached it. A
 * listing is therefore published only after every staged photo of that
 * listing was committed — otherwise the published listing would show fewer
 * photos than the owner selected.
 *
 * The check is generation-aware: an operation of an earlier lifetime of the
 * same room id belongs to a listing which no longer exists and is swept by
 * the durable cleanup. It must not block a new listing forever.
 */
export async function roomHasPendingPhotoUploads(options: {
  ownerId: string;
  roomId: string;
  listingGeneration: string;
}): Promise<boolean> {
  const ownerId = String(options.ownerId || '').trim();
  const roomId = String(options.roomId || '').trim();
  const listingGeneration = String(options.listingGeneration || '').trim();
  // A missing identity cannot be checked, so it fails closed.
  if (!ownerId || !roomId) return true;

  const operations = await db
    .collection('roomPhotoUploadOperations')
    .where('roomId', '==', roomId)
    .get();

  for (const snapshot of operations.docs) {
    const operation = snapshot.data() as Record<string, any>;
    if (String(operation.ownerId || '').trim() !== ownerId) continue;

    const status = String(operation.status || '').trim();
    if (
      status !== 'reserved' &&
      status !== 'uploaded' &&
      status !== 'deleting'
    ) {
      // The operation reached a terminal state: its photo is referenced,
      // cleaned or discarded.
      continue;
    }

    const generation = String(operation.listingGeneration || '').trim();
    if (generation && listingGeneration) {
      // A different lifetime of the same room id. Its objects are swept by
      // the generation-fenced cleanup and must not block this listing.
      if (generation !== listingGeneration) continue;
    } else if (generation || listingGeneration) {
      // Only one of the two carries a generation. The operation belongs to a
      // listing lifetime which does not exist any more.
      continue;
    }

    return true;
  }

  return false;
}

/**
 * The number of staged uploads of one listing which are not committed yet.
 *
 * The room-level quota counter is incremented by `stageRoomPhoto` and
 * released exactly when the operation reaches a terminal state (committed,
 * discarded, cleaned or quarantined). It is therefore a transactional,
 * owner- and generation-fenced view of the pending uploads of one listing
 * lifetime.
 *
 * A caller which publishes a listing reads this counter **inside its own
 * transaction**. A stage, commit or discard which runs concurrently writes
 * the same document, so the transaction is aborted and retried — the
 * publication therefore never observes a stale "no pending photo" state.
 */
export function pendingRoomPhotoCount(
  quotaSnapshot: firestore.DocumentSnapshot | null | undefined,
  options: { ownerId: string; listingGeneration: string },
): number {
  const ownerId = String(options.ownerId || '').trim();
  const listingGeneration = String(options.listingGeneration || '').trim();
  if (!quotaSnapshot || !quotaSnapshot.exists) return 0;
  if (!ownerId || !listingGeneration) return 0;

  const storedOwnerId = String(quotaSnapshot.get('ownerId') || '').trim();
  const storedGeneration = String(
    quotaSnapshot.get('listingGeneration') || '',
  ).trim();
  // A quota document of another owner or of another lifetime of the same
  // room id describes work which does not belong to this listing.
  if (storedOwnerId !== ownerId || storedGeneration !== listingGeneration) {
    return 0;
  }

  return quotaState(quotaSnapshot).pendingCount;
}

/** The exact Storage object which one upload id is allowed to address. */
function expectedRoomPhotoObjectPath(
  ownerId: string,
  roomId: string,
  uploadId: string,
): string {
  return roomObjectPath(ownerId, roomId, uploadId);
}

/**
 * Verifies the complete server-owned identity of an upload operation.
 *
 * The stored path is never trusted on its own. It must be exactly the path
 * derived from the authenticated owner, the room id and the upload id. This
 * prevents a corrupt operation record from making cleanup delete an object
 * outside the room-photo namespace.
 */
function assertRoomPhotoOperationIdentity(
  operation: Record<string, any>,
  ownerId: string,
  roomId: string,
  uploadId: string,
): string {
  const expectedPath = expectedRoomPhotoObjectPath(ownerId, roomId, uploadId);
  const storedPath = String(operation.objectPath || '').trim();
  if (
    !ownerId ||
    !roomId ||
    !uploadId ||
    !validIdentifier(roomId, 128) ||
    !validIdentifier(uploadId, 128) ||
    storedPath !== expectedPath
  ) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The staged room photo has an invalid storage identity.',
    );
  }
  return expectedPath;
}

/** The retry delay for a durable cleanup operation. */
function roomPhotoCleanupRetryDelay(attempts: number): number {
  const exponent = Math.max(0, Math.min(10, Math.floor(attempts)));
  return Math.min(
    ROOM_PHOTO_CLEANUP_MAX_RETRY_MS,
    ROOM_PHOTO_CLEANUP_RETRY_MS * Math.pow(2, exponent),
  );
}

function assertRoomBelongsToOwner(
  snapshot: firestore.DocumentSnapshot,
  ownerId: string,
  roomId: string,
): Record<string, any> {
  if (!snapshot.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'That room listing no longer exists.',
    );
  }
  const room = snapshot.data() as Record<string, any>;
  if (String(room.ownerId || '').trim() !== ownerId) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'You can only manage photos for your own listing.',
    );
  }
  if (
    room.deletionInProgress === true ||
    String(room.deletionOperationId || '').trim()
  ) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This listing is being removed and cannot accept new photos.',
    );
  }
  if (String(room.roomId || roomId).trim() !== roomId) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The room listing identity changed. Try again.',
    );
  }
  const cleanupLock = room.photoCleanupLock;
  const lockExpiresAt =
    cleanupLock &&
    typeof cleanupLock === 'object' &&
    typeof (cleanupLock as { expiresAt?: { toMillis?: () => number } })
      .expiresAt?.toMillis === 'function'
      ? (cleanupLock as { expiresAt: { toMillis: () => number } }).expiresAt.toMillis()
      : 0;
  if (lockExpiresAt > Date.now()) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This listing is temporarily cleaning old photos. Try again shortly.',
    );
  }
  return room;
}

function detectImageContentType(bytes: Buffer): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii').toLowerCase();
    if (
      brand === 'heic' ||
      brand === 'heix' ||
      brand === 'heim' ||
      brand === 'heis' ||
      brand === 'hevc' ||
      brand === 'mif1' ||
      brand === 'msf1' ||
      brand === 'avif'
    ) {
      return brand === 'avif' ? 'image/avif' : 'image/heic';
    }
  }
  return null;
}

/**
 * Verifies that a Firebase download URL points at the expected trusted
 * bucket and at the exact owner/room object path.
 *
 * The emulator uses a loopback HTTP host. Production accepts only the
 * official HTTPS Firebase Storage host. Neither mode accepts an unrelated
 * host or a trusted-bucket path belonging to another owner or room.
 */
export function isCanonicalRoomImageUrl(
  value: unknown,
  ownerId: string,
  roomId: string,
  objectPath: string,
  bucket = ROOM_PHOTO_BUCKET,
): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const expectedPrefix = `rooms/${ownerId}/${roomId}/room-photo-`;
  if (!objectPath.startsWith(expectedPrefix)) return false;
  const uploadId = objectPath.substring(expectedPrefix.length);
  if (!validIdentifier(uploadId, 128)) return false;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const expectedPath = `/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}`;
    if (url.pathname !== expectedPath) return false;
    if (url.searchParams.get('alt') !== 'media') return false;
    if (!url.searchParams.get('token')) return false;

    if (host === 'firebasestorage.googleapis.com') {
      return url.protocol === 'https:' && !url.username && !url.password;
    }

    // The Storage emulator is accepted only when the process was explicitly
    // pointed at one. The configured origin must match exactly; an arbitrary
    // loopback URL is not trusted merely because it happens to use HTTP.
    const emulatorHost =
      String(
        process.env.STORAGE_EMULATOR_HOST ||
          process.env.FIREBASE_STORAGE_EMULATOR_HOST ||
          '',
      ).trim();
    if (!emulatorHost) return false;
    const normalized = emulatorHost.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const expectedOrigin = new URL(`http://${normalized}`);
    return (
      url.protocol === 'http:' &&
      url.origin === expectedOrigin.origin &&
      !url.username &&
      !url.password
    );
  } catch (_) {
    return false;
  }
}

function releasePendingQuota(
  transaction: firestore.Transaction,
  quotaRef: firestore.DocumentReference,
  quota: RoomPhotoQuotaState,
  releasedCount: number,
  releasedBytes: number,
): void {
  if (releasedCount <= 0 && releasedBytes <= 0) return;
  transaction.set(
    quotaRef,
    {
      pendingCount: Math.max(0, quota.pendingCount - releasedCount),
      pendingBytes: Math.max(0, quota.pendingBytes - releasedBytes),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

/**
 * Whether the operation reached a state which must never be cleaned again.
 *
 * The terminal status is also the **release marker** of the owner quota: an
 * operation which is already terminal has released its reservation, so the
 * expiry cleanup must not release it a second time.
 */
function isTerminalRoomPhotoStatus(status: string): boolean {
  return (
    status === 'referenced' ||
    status === 'cleaned' ||
    status === 'quarantined' ||
    status === 'discarded'
  );
}

/**
 * Releases a room-level reservation only for the exact listing lifetime.
 *
 * A room-id quota document can be reused by a later listing (even by a
 * different owner). Its stored owner and generation, the upload operation and
 * the live room must therefore all name the same listing before one pending
 * counter is decremented.
 */
function releasePendingRoomQuota(
  transaction: firestore.Transaction,
  quotaRef: firestore.DocumentReference,
  quotaSnapshot: firestore.DocumentSnapshot,
  ownerId: string,
  listingGeneration: string,
  roomSnapshot: firestore.DocumentSnapshot,
  releasedCount: number,
  releasedBytes: number,
): void {
  if (releasedCount <= 0 && releasedBytes <= 0) return;
  if (!ownerId || !listingGeneration || !roomSnapshot.exists) return;

  const storedOwnerId = String(quotaSnapshot.get('ownerId') || '').trim();
  const storedGeneration = String(
    quotaSnapshot.get('listingGeneration') || '',
  ).trim();
  if (storedOwnerId !== ownerId || storedGeneration !== listingGeneration) {
    return;
  }

  const room = roomSnapshot.data() as Record<string, any>;
  if (
    String(room.ownerId || '').trim() !== ownerId ||
    String(room.listingGeneration || '').trim() !== listingGeneration
  ) {
    return;
  }

  releasePendingQuota(
    transaction,
    quotaRef,
    quotaState(quotaSnapshot),
    releasedCount,
    releasedBytes,
  );
}

function roomReferencesUrl(
  room: Record<string, any> | null,
  url: string,
): boolean {
  if (!room || !url) return false;
  return stringList(room.images).includes(url);
}

async function deleteStorageObject(
  ownerId: string,
  roomId: string,
  uploadId: string,
): Promise<void> {
  const objectPath = expectedRoomPhotoObjectPath(ownerId, roomId, uploadId);
  const file = storage.getStorage().bucket(ROOM_PHOTO_BUCKET).file(objectPath);
  try {
    await file.delete();
  } catch (error) {
    const code = Number((error as { code?: unknown })?.code || 0);
    if (code === 404) return;
    throw error;
  }
}

/**
 * Quarantines one operation whose top-level identity is malformed.
 *
 * The deterministic operation id proves that the record belongs to the stated
 * owner/upload pair. When that proof and the room identity are trustworthy,
 * the pending owner and room reservations are released in the same
 * transaction as the quarantine marker. If the marker cannot be written, the
 * failure is recorded on the operation and a later cleanup run is scheduled.
 */
async function quarantineMalformedRoomPhotoOperation(
  operationRef: firestore.DocumentReference,
  ownerId: string,
  roomId: string,
  uploadId: string,
): Promise<'quarantined' | 'not-malformed' | 'failed'> {
  const ownerTrustworthy =
    Boolean(ownerId) &&
    Boolean(uploadId) &&
    ownerId.length <= 128 &&
    operationRef.id === operationDocumentId(ownerId, uploadId);
  const roomTrustworthy = ownerTrustworthy && validIdentifier(roomId, 128);
  const quotaRef = ownerTrustworthy
    ? db
        .collection('roomPhotoUploadQuotas')
        .doc(quotaDocumentId(ownerId))
    : null;
  const roomQuotaRef = roomTrustworthy
    ? db.collection('roomPhotoRoomQuotas').doc(roomId)
    : null;
  const roomRef = roomTrustworthy
    ? db.collection('rooms').doc(roomId)
    : null;

  let didQuarantine = false;
  try {
    await db.runTransaction(async (transaction) => {
      const roomSnapshot = roomRef
        ? await transaction.get(roomRef)
        : undefined;
      const operationSnapshot = await transaction.get(operationRef);
      if (!operationSnapshot.exists) return;
      const current = operationSnapshot.data() as Record<string, any>;
      const currentOwner = String(current.ownerId || '').trim();
      const currentRoom = String(current.roomId || '').trim();
      const currentUpload = String(current.uploadId || '').trim();
      if (
        currentOwner &&
        validIdentifier(currentRoom, 128) &&
        validIdentifier(currentUpload, 128)
      ) {
        // The stale query no longer describes a malformed operation. Let the
        // normal cleanup path handle it.
        throw new RoomPhotoIdentityNoLongerMalformedError();
      }

      const identityPairMatches =
        currentOwner === ownerId && currentUpload === uploadId;
      const status = String(current.status || '');
      if (
        isTerminalRoomPhotoStatus(status)
      ) {
        transaction.update(operationRef, {
          cleanupAfter: firestore.FieldValue.delete(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      if (quotaRef && identityPairMatches) {
        const quotaSnapshot = await transaction.get(quotaRef);
        releasePendingQuota(
          transaction,
          quotaRef,
          quotaState(quotaSnapshot),
          1,
          nonNegativeInteger(current.byteLength),
        );
      }
      if (roomQuotaRef && roomSnapshot) {
        const roomQuotaSnapshot = await transaction.get(roomQuotaRef);
        releasePendingRoomQuota(
          transaction,
          roomQuotaRef,
          roomQuotaSnapshot,
          currentOwner,
          String(current.listingGeneration || '').trim(),
          roomSnapshot,
          1,
          nonNegativeInteger(current.byteLength),
        );
      }

      didQuarantine = true;
      transaction.update(operationRef, {
        status: 'quarantined',
        lastError: 'Invalid room-photo operation identity',
        quarantinedAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
        cleanupAfter: firestore.FieldValue.delete(),
      });
    });
    return didQuarantine ? 'quarantined' : 'not-malformed';
  } catch (error) {
    if (error instanceof RoomPhotoIdentityNoLongerMalformedError) {
      return 'not-malformed';
    }

    console.error(
      `Could not quarantine the malformed room-photo operation ${operationRef.id}:`,
      error,
    );
    let alreadyQuarantined = false;
    try {
      await db.runTransaction(async (transaction) => {
        const operationSnapshot = await transaction.get(operationRef);
        if (!operationSnapshot.exists) return;
        const current = operationSnapshot.data() as Record<string, any>;
        const status = String(current.status || '');
        if (
          isTerminalRoomPhotoStatus(status)
        ) {
          alreadyQuarantined = status === 'quarantined';
          return;
        }
        const attempts = nonNegativeInteger(current.attempts);
        transaction.update(operationRef, {
          attempts: attempts + 1,
          lastError: `Failed to quarantine malformed operation: ${String(error)}`.slice(
            0,
            300,
          ),
          updatedAt: firestore.FieldValue.serverTimestamp(),
          cleanupAfter: firestore.Timestamp.fromMillis(
            Date.now() + roomPhotoCleanupRetryDelay(attempts),
          ),
        });
      });
    } catch (recordError) {
      console.error(
        `Could not record the failed quarantine of ${operationRef.id}:`,
        recordError,
      );
    }

    const observed = await operationRef.get().catch(() => null);
    if (alreadyQuarantined || observed?.get('status') === 'quarantined') {
      return 'quarantined';
    }
    return 'failed';
  }
}

/** Signals that a stale malformed-operation query no longer applies. */
class RoomPhotoIdentityNoLongerMalformedError extends Error {}

/**
 * Stages one photo upload for an existing listing.
 *
 * The object is written by the Admin SDK, so a client can no longer create
 * an arbitrary `rooms/{owner}/{room}/...` object. The operation is durable,
 * quota-bound and swept if the client never commits it to the listing.
 */
export const stageRoomPhoto = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Please sign in before uploading a room photo.',
    );
  }
  const ownerId = context.auth.uid;
  await assertLiveOwner(ownerId);

  const roomId = String(data?.roomId || '').trim();
  const uploadId = String(data?.uploadId || '').trim();
  if (!validIdentifier(roomId, 128)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid room id.');
  }
  if (!validIdentifier(uploadId, 128)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Invalid upload id.',
    );
  }

  // The form may replace an existing photo. These planned removals let the
  // server reserve a replacement image slot without trusting the client to
  // publish a URL. They are advisory at staging time; the commit still
  // recalculates the final list and enforces the hard limit.
  const plannedRemovalUrls = uniqueStringList(
    data?.removeUrls,
    MAX_ROOM_PHOTOS,
  );
  if (plannedRemovalUrls.some((url) => url.length > 2048)) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'A room-photo URL is invalid.',
    );
  }

  const encoded = String(data?.data || '').trim();
  if (!encoded) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The photo data is missing.',
    );
  }
  const maximumEncodedLength = Math.ceil((MAX_ROOM_PHOTO_BYTES * 4) / 3) + 4;
  if (
    encoded.length > maximumEncodedLength ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The photo data is invalid.',
    );
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length <= 0) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The selected photo is empty.',
    );
  }
  if (bytes.length > MAX_ROOM_PHOTO_BYTES) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Each room photo must be 5 MB or smaller.',
    );
  }
  const contentType = detectImageContentType(bytes);
  if (!contentType) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The selected file is not a supported image.',
    );
  }

  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const objectPath = roomObjectPath(ownerId, roomId, uploadId);
  const operationRef = db
    .collection('roomPhotoUploadOperations')
    .doc(operationDocumentId(ownerId, uploadId));
  const roomRef = db.collection('rooms').doc(roomId);
  const ownerRef = db.collection('users').doc(ownerId);
  const quotaRef = db
    .collection('roomPhotoUploadQuotas')
    .doc(quotaDocumentId(ownerId));
  const roomQuotaRef = db.collection('roomPhotoRoomQuotas').doc(roomId);

  const reservation = await db.runTransaction(async (transaction) => {
    // Every room-media transaction locks the room and the live owner profile
    // first. This keeps stage, commit and discard in one deadlock-free order
    // and closes the demotion/ban race before any write can commit.
    const roomSnapshot = await transaction.get(roomRef);
    const room = assertRoomBelongsToOwner(roomSnapshot, ownerId, roomId);
    const ownerSnapshot = await transaction.get(ownerRef);
    assertLiveOwnerProfileSnapshot(ownerSnapshot, ownerId);
    const hadListingGeneration = Boolean(
      String(room.listingGeneration || '').trim(),
    );
    const listingGeneration = roomListingGeneration(room);

    const operationSnapshot = await transaction.get(operationRef);
    if (operationSnapshot.exists) {
      const operation = operationSnapshot.data() as Record<string, any>;
      const existingOwner = String(operation.ownerId || '').trim();
      const existingRoom = String(operation.roomId || '').trim();
      const existingHash = String(operation.sha256 || '').trim();
      const existingGeneration = String(operation.listingGeneration || '').trim();
      if (existingOwner !== ownerId || existingRoom !== roomId) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'That upload id was already used for another listing.',
        );
      }
      if (existingGeneration !== listingGeneration) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'That staged photo belongs to an earlier listing.',
        );
      }
      if (existingHash !== sha256) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'That upload id was already used for different photo data.',
        );
      }
      const existingPlannedRemovals = stringList(
        operation.plannedRemovalUrls,
      ).sort();
      const requestedPlannedRemovals = [...plannedRemovalUrls].sort();
      if (
        JSON.stringify(existingPlannedRemovals) !==
        JSON.stringify(requestedPlannedRemovals)
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'That upload id was already used with different photo removals.',
        );
      }
      const storedPath = assertRoomPhotoOperationIdentity(
        operation,
        ownerId,
        roomId,
        uploadId,
      );
      const status = String(operation.status || '') as RoomPhotoUploadStatus;
      const storedUrl = String(operation.url || '').trim();
      let downloadToken = String(operation.downloadToken || '').trim();
      if (!downloadToken && storedUrl) {
        // Legacy operations did not persist the token separately. Recover it
        // from their already trusted URL instead of minting a replacement.
        downloadToken = roomPhotoDownloadToken(storedUrl);
      }
      if (!downloadToken) {
        downloadToken = crypto.randomUUID();
      }
      if (String(operation.downloadToken || '').trim() !== downloadToken) {
        transaction.update(operationRef, {
          downloadToken,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        });
      }

      if (status === 'uploaded' || status === 'referenced') {
        if (
          !storedUrl ||
          !isCanonicalRoomImageUrl(
            storedUrl,
            ownerId,
            roomId,
            storedPath,
          ) ||
          roomPhotoDownloadToken(storedUrl) !== downloadToken
        ) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'The staged room photo has an untrusted storage URL.',
          );
        }
        if (status === 'uploaded' && roomPhotoUploadExpired(operation)) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'That staged room photo expired. Try uploading it again.',
          );
        }
        return {
          shouldUpload: false,
          uploadId,
          ownerId,
          roomId,
          listingGeneration,
          objectPath: storedPath,
          contentType: String(operation.contentType || contentType),
          byteLength: Number(operation.byteLength || bytes.length),
          sha256,
          downloadToken,
          url: storedUrl,
        } satisfies UploadReservation;
      }
      if (status !== 'reserved') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'That upload can no longer be retried.',
        );
      }
      if (roomPhotoUploadExpired(operation)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'That staged room photo expired. Try uploading it again.',
        );
      }

      return {
        shouldUpload: true,
        uploadId,
        ownerId,
        roomId,
        listingGeneration,
        objectPath: storedPath,
        contentType: String(operation.contentType || contentType),
        byteLength: Number(operation.byteLength || bytes.length),
        sha256,
        downloadToken,
      } satisfies UploadReservation;
    }

    const quotaSnapshot = await transaction.get(quotaRef);
    const roomQuotaSnapshot = await transaction.get(roomQuotaRef);
    const quota = quotaState(quotaSnapshot);
    const storedRoomQuotaOwner = String(
      roomQuotaSnapshot.get('ownerId') || '',
    ).trim();
    const storedRoomQuotaGeneration = String(
      roomQuotaSnapshot.get('listingGeneration') || '',
    ).trim();
    const roomQuotaMatchesCurrentGeneration =
      storedRoomQuotaOwner === ownerId &&
      storedRoomQuotaGeneration === listingGeneration;
    const roomQuota = roomQuotaMatchesCurrentGeneration
      ? quotaState(roomQuotaSnapshot)
      : {
          ...quotaState(roomQuotaSnapshot),
          pendingCount: 0,
          pendingBytes: 0,
        };
    const downloadToken = crypto.randomUUID();
    const now = Date.now();
    let windowStartedAtMillis = quota.windowStartedAtMillis;
    let windowUploadCount = quota.windowUploadCount;
    let windowUploadBytes = quota.windowUploadBytes;
    if (
      !windowStartedAtMillis ||
      now - windowStartedAtMillis >= ROOM_PHOTO_QUOTA_WINDOW_MS
    ) {
      windowStartedAtMillis = now;
      windowUploadCount = 0;
      windowUploadBytes = 0;
    }

    if (
      quota.pendingCount + 1 > MAX_PENDING_ROOM_PHOTO_UPLOADS ||
      quota.pendingBytes + bytes.length > MAX_PENDING_ROOM_PHOTO_BYTES
    ) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        'Too many room photos are waiting to be saved. Try again shortly.',
      );
    }
    if (
      windowUploadCount + 1 > MAX_ROOM_PHOTO_WINDOW_UPLOADS ||
      windowUploadBytes + bytes.length > MAX_ROOM_PHOTO_WINDOW_BYTES
    ) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        'The room-photo upload limit was reached. Try again later.',
      );
    }

    const currentImages = stringList(room.images);
    const removableCurrentImages = plannedRemovalUrls.filter((url) =>
      currentImages.includes(url),
    ).length;
    const projectedRoomImages =
      currentImages.length + roomQuota.pendingCount + 1 - removableCurrentImages;
    if (
      projectedRoomImages > MAX_ROOM_PHOTOS ||
      roomQuota.pendingBytes + bytes.length > MAX_PENDING_ROOM_PHOTO_BYTES
    ) {
      throw new functions.https.HttpsError(
        'resource-exhausted',
        `A room can have at most ${MAX_ROOM_PHOTOS} photos.`,
      );
    }

    if (!hadListingGeneration) {
      transaction.update(roomRef, { listingGeneration });
    }

    transaction.set(
      operationRef,
      {
        type: 'roomPhotoUpload',
        ownerId,
        roomId,
        uploadId,
        listingGeneration,
        plannedRemovalUrls,
        objectPath,
        contentType,
        byteLength: bytes.length,
        sha256,
        downloadToken,
        status: 'reserved',
        createdAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
        cleanupAfter: firestore.Timestamp.fromMillis(
          now + ROOM_PHOTO_UPLOAD_TTL_MS,
        ),
      },
      { merge: true },
    );
    transaction.set(
      quotaRef,
      {
        ownerId,
        pendingCount: quota.pendingCount + 1,
        pendingBytes: quota.pendingBytes + bytes.length,
        windowStartedAt: firestore.Timestamp.fromMillis(windowStartedAtMillis),
        windowUploadCount: windowUploadCount + 1,
        windowUploadBytes: windowUploadBytes + bytes.length,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      roomQuotaRef,
      {
        roomId,
        ownerId,
        listingGeneration,
        pendingCount: roomQuota.pendingCount + 1,
        pendingBytes: roomQuota.pendingBytes + bytes.length,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      shouldUpload: true,
      uploadId,
      ownerId,
      roomId,
      listingGeneration,
      objectPath,
      contentType,
      byteLength: bytes.length,
      sha256,
      downloadToken,
    } satisfies UploadReservation;
  });

  if (!reservation.shouldUpload) {
    return {
      uploadId: reservation.uploadId,
      url: reservation.url || '',
      path: reservation.objectPath,
      byteLength: reservation.byteLength,
      contentType: reservation.contentType,
    };
  }

  const file = storage
    .getStorage()
    .bucket(ROOM_PHOTO_BUCKET)
    .file(reservation.objectPath);
  try {
    await file.save(bytes, {
      resumable: false,
      metadata: {
        contentType: reservation.contentType,
        cacheControl: 'private,max-age=3600',
        metadata: {
          firebaseStorageDownloadTokens: reservation.downloadToken,
        },
      },
    });
  } catch (error) {
    console.error('Could not upload a room photo:', error);
    // The object path belongs to the **upload id**, not to this request. Two
    // devices which stage the same upload id write to the same path, so a
    // failure of one attempt must never delete the object of the other one.
    // A possible partial object is removed by the durable expiry cleanup
    // instead, which knows whether the object is referenced.
    throw new functions.https.HttpsError(
      'internal',
      'The room photo could not be uploaded. Try again.',
    );
  }

  let url = '';
  try {
    url = await storage.getDownloadURL(file);
  } catch (error) {
    console.error('Could not create the room-photo download URL:', error);
    // The same object path can belong to a concurrent attempt of the same
    // upload id. It is therefore not deleted here — see the comment above.
    throw new functions.https.HttpsError(
      'internal',
      'The room photo could not be prepared. Try again.',
    );
  }
  if (
    !isCanonicalRoomImageUrl(
      url,
      ownerId,
      roomId,
      reservation.objectPath,
    ) ||
    roomPhotoDownloadToken(url) !== reservation.downloadToken
  ) {
    // The untrusted object stays until the durable expiry cleanup removes
    // it. Deleting it here could remove the object of a concurrent attempt
    // which used the same upload id.
    throw new functions.https.HttpsError(
      'internal',
      'The room-photo storage URL was not trusted.',
    );
  }

  let committedUrl = '';
  try {
    // The live phone is checked again after the byte transfer. This check is
    // inside the failure path: an account which was deleted while the object
    // was being written must not leave that object behind.
    await assertLiveOwner(ownerId);
    await db.runTransaction(async (transaction) => {
      const roomSnapshot = await transaction.get(roomRef);
      const room = assertRoomBelongsToOwner(roomSnapshot, ownerId, roomId);
      const ownerSnapshot = await transaction.get(ownerRef);
      assertLiveOwnerProfileSnapshot(ownerSnapshot, ownerId);
      const operationSnapshot = await transaction.get(operationRef);
      if (!operationSnapshot.exists) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The staged room photo is no longer available.',
        );
      }
      const operation = operationSnapshot.data() as Record<string, any>;
      const currentGeneration = String(room.listingGeneration || '').trim();
      const operationGeneration = String(operation.listingGeneration || '').trim();
      if (
        !currentGeneration ||
        currentGeneration !== reservation.listingGeneration ||
        operationGeneration !== reservation.listingGeneration
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The staged room photo belongs to an earlier listing.',
        );
      }
      const storedPath = assertRoomPhotoOperationIdentity(
        operation,
        ownerId,
        roomId,
        uploadId,
      );
      if (storedPath !== reservation.objectPath) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The staged room photo has an invalid storage identity.',
        );
      }
      const status = String(operation.status || '');
      if (status === 'uploaded' || status === 'referenced') {
        committedUrl = String(operation.url || '').trim();
        const operationToken = String(operation.downloadToken || '').trim();
        if (
          !committedUrl ||
          !isCanonicalRoomImageUrl(
            committedUrl,
            ownerId,
            roomId,
            storedPath,
          ) ||
          !operationToken ||
          roomPhotoDownloadToken(committedUrl) !== operationToken
        ) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'The staged room photo has no trusted download URL.',
          );
        }
        return;
      }
      if (status !== 'reserved') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The staged room photo was discarded before it finished.',
        );
      }
      if (roomPhotoUploadExpired(operation)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The staged room photo expired while it was being uploaded.',
        );
      }
      committedUrl = url;
      transaction.update(operationRef, {
        status: 'uploaded',
        url,
        downloadToken: reservation.downloadToken,
        uploadedAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (error) {
    // A Firestore transaction can commit even when its acknowledgement is
    // lost. Re-read the operation before deleting anything: an `uploaded`
    // operation must survive so the client can still commit it.
    //
    // A **failed** recovery is not the same as a recovery which proved that
    // nothing was committed. The outcome of the original transaction is
    // unknown in that case: the operation may well be `uploaded` and the
    // object may already be referenced by the listing. Deleting it now
    // would publish a dead image, so the object survives and the durable
    // expiry cleanup decides later.
    let recovered: string | null = null;
    let recoveryFailed = false;
    try {
      recovered = await db.runTransaction(async (transaction) => {
        const roomSnapshot = await transaction.get(roomRef);
        const ownerSnapshot = await transaction.get(ownerRef);
        const operationSnapshot = await transaction.get(operationRef);
        if (!operationSnapshot.exists || !roomSnapshot.exists) return null;
        const operation = operationSnapshot.data() as Record<string, any>;
        const room = roomSnapshot.data() as Record<string, any>;
        const status = String(operation.status || '');
        const recoveredUrl = String(operation.url || '').trim();
        const recoveredToken = String(operation.downloadToken || '').trim();
        const generationMatches =
          String(operation.listingGeneration || '').trim() ===
            reservation.listingGeneration &&
          String(room.listingGeneration || '').trim() ===
            reservation.listingGeneration;
        const trustedUrl =
          recoveredUrl &&
          recoveredToken &&
          roomPhotoDownloadToken(recoveredUrl) === recoveredToken &&
          isCanonicalRoomImageUrl(
            recoveredUrl,
            ownerId,
            roomId,
            reservation.objectPath,
          );
        if (
          status === 'uploaded' &&
          generationMatches &&
          trustedUrl &&
          ownerSnapshot.exists
        ) {
          // An uploaded but unreferenced object is usable only while the
          // owner is still live. A demoted or deleted owner must take the
          // failure path and remove the object.
          assertLiveOwnerProfileSnapshot(ownerSnapshot, ownerId);
          return recoveredUrl;
        }
        const accountDeletionInProgress =
          !ownerSnapshot.exists ||
          ownerSnapshot.get('deletionState') === 'deleting' ||
          ownerSnapshot.get('deletionScheduled') === true;
        if (
          status === 'referenced' &&
          generationMatches &&
          trustedUrl &&
          roomReferencesUrl(room, recoveredUrl) &&
          !accountDeletionInProgress
        ) {
          return recoveredUrl;
        }
        return null;
      });
    } catch (recoveryError) {
      recoveryFailed = true;
      console.error(
        'Could not recover the staged room photo after a failed commit:',
        recoveryError,
      );
    }
    if (recovered) {
      return {
        uploadId: reservation.uploadId,
        url: recovered,
        path: reservation.objectPath,
        byteLength: reservation.byteLength,
        contentType: reservation.contentType,
      };
    }

    if (!recoveryFailed) {
      // The recovery proved that the operation is neither `uploaded` nor
      // `referenced`: the object of this request is an orphan and may be
      // removed.
      await deleteStorageObject(ownerId, roomId, uploadId).catch(
        () => undefined,
      );
    }
    throw error;
  }

  return {
    uploadId: reservation.uploadId,
    url: committedUrl,
    path: reservation.objectPath,
    byteLength: reservation.byteLength,
    contentType: reservation.contentType,
  };
});

/**
 * Commits staged uploads and explicit removals to a room's image list.
 *
 * The room document is updated in the same transaction which marks the
 * upload operations as referenced. A client can therefore never put an
 * arbitrary URL into a listing, and a staged object cannot be swept while a
 * commit which references it is racing the cleanup worker.
 */
export const commitRoomPhotoChanges = callableHttps.onCall(
  async (data, context): Promise<CommitResult> => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in before changing room photos.',
      );
    }
    const ownerId = context.auth.uid;
    await assertLiveOwner(ownerId);

    const roomId = String(data?.roomId || '').trim();
    const commitId = String(data?.commitId || '').trim();
    if (!validIdentifier(roomId, 128)) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid room id.');
    }
    if (!validIdentifier(commitId, 128)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Invalid commit id.',
      );
    }

    const uploadIds = uniqueStringList(data?.uploadIds, MAX_ROOM_PHOTOS);
    const removeUrls = uniqueStringList(data?.removeUrls, MAX_ROOM_PHOTOS);
    if (removeUrls.some((url) => url.length > 2048)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'A room-photo URL is invalid.',
      );
    }
    if (uploadIds.length === 0 && removeUrls.length === 0) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'There are no room-photo changes to save.',
      );
    }
    if (!uploadIds.every((uploadId) => validIdentifier(uploadId, 128))) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'An upload id is invalid.',
      );
    }

    const requestHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          roomId,
          uploadIds: [...uploadIds].sort(),
          removeUrls: [...removeUrls].sort(),
        }),
      )
      .digest('hex');

    const roomRef = db.collection('rooms').doc(roomId);
    const ownerRef = db.collection('users').doc(ownerId);
    const commitRef = db
      .collection('roomPhotoCommitOperations')
      .doc(commitDocumentId(ownerId, commitId));
    const quotaRef = db
      .collection('roomPhotoUploadQuotas')
      .doc(quotaDocumentId(ownerId));
    const roomQuotaRef = db.collection('roomPhotoRoomQuotas').doc(roomId);
    const operationRefs = uploadIds.map((uploadId) =>
      db
        .collection('roomPhotoUploadOperations')
        .doc(operationDocumentId(ownerId, uploadId)),
    );

    return db.runTransaction(async (transaction) => {
      const roomSnapshot = await transaction.get(roomRef);
      const room = assertRoomBelongsToOwner(
        roomSnapshot,
        ownerId,
        roomId,
      );
      const ownerSnapshot = await transaction.get(ownerRef);
      assertLiveOwnerProfileSnapshot(ownerSnapshot, ownerId);
      const hadListingGeneration = Boolean(
        String(room.listingGeneration || '').trim(),
      );
      const listingGeneration = roomListingGeneration(room);

      const commitSnapshot = await transaction.get(commitRef);
      if (commitSnapshot.exists) {
        const commit = commitSnapshot.data() as Record<string, any>;
        if (
          String(commit.requestHash || '') !== requestHash ||
          String(commit.listingGeneration || '').trim() !== listingGeneration
        ) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'That room-photo commit id was already used.',
          );
        }
        return {
          images: stringList(commit.images),
          alreadyCommitted: true,
        } satisfies CommitResult;
      }

      const operationSnapshots = [];
      for (const operationRef of operationRefs) {
        operationSnapshots.push(await transaction.get(operationRef));
      }
      const quotaSnapshot = await transaction.get(quotaRef);
      const roomQuotaSnapshot = await transaction.get(roomQuotaRef);
      const quota = quotaState(quotaSnapshot);

      const uploadedUrls: string[] = [];
      let releasedCount = 0;
      let releasedBytes = 0;
      const now = Date.now();
      const currentImages = stringList(room.images);
      for (let index = 0; index < operationSnapshots.length; index += 1) {
        const snapshot = operationSnapshots[index];
        const uploadId = uploadIds[index];
        if (!snapshot.exists) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'One staged room photo is no longer available.',
          );
        }
        const operation = snapshot.data() as Record<string, any>;
        if (
          String(operation.ownerId || '').trim() !== ownerId ||
          String(operation.roomId || '').trim() !== roomId ||
          String(operation.uploadId || '').trim() !== uploadId
        ) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'A staged room photo does not belong to this listing.',
          );
        }
        if (
          String(operation.listingGeneration || '').trim() !== listingGeneration
        ) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'A staged room photo belongs to an earlier listing.',
          );
        }
        const objectPath = assertRoomPhotoOperationIdentity(
          operation,
          ownerId,
          roomId,
          uploadId,
        );
        const url = String(operation.url || '').trim();
        const operationToken = String(operation.downloadToken || '').trim();
        if (
          !url ||
          !isCanonicalRoomImageUrl(url, ownerId, roomId, objectPath) ||
          (operationToken && roomPhotoDownloadToken(url) !== operationToken)
        ) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'One staged room photo has an untrusted storage URL.',
          );
        }
        const status = String(operation.status || '');
        if (status === 'referenced') {
          // A later retry may use a fresh commit id for an upload which the
          // previous commit already referenced. Preserve that photo without
          // releasing its quota twice.
          if (!currentImages.includes(url)) {
            throw new functions.https.HttpsError(
              'failed-precondition',
              'One staged room photo is no longer referenced by the listing.',
            );
          }
          uploadedUrls.push(url);
          continue;
        }
        if (status !== 'uploaded') {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'One staged room photo could not be committed.',
          );
        }
        if (roomPhotoUploadExpired(operation, now)) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'One staged room photo expired. Try uploading it again.',
          );
        }
        uploadedUrls.push(url);
        releasedCount += 1;
        releasedBytes += nonNegativeInteger(operation.byteLength);

        transaction.update(snapshot.ref, {
          status: 'referenced',
          referencedAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
          commitId,
          cleanupAfter: firestore.FieldValue.delete(),
        });
      }

      const removeSet = new Set(removeUrls);
      const images: string[] = [];
      for (const url of currentImages) {
        if (removeSet.has(url)) continue;
        if (!images.includes(url)) images.push(url);
      }
      for (const url of uploadedUrls) {
        if (!images.includes(url)) images.push(url);
      }
      if (images.length > MAX_ROOM_PHOTOS) {
        throw new functions.https.HttpsError(
          'resource-exhausted',
          `A room can have at most ${MAX_ROOM_PHOTOS} photos.`,
        );
      }

      const roomPatch: Record<string, unknown> = {
        images,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      };
      if (!hadListingGeneration) {
        roomPatch.listingGeneration = listingGeneration;
      }
      transaction.update(roomRef, roomPatch);

      releasePendingQuota(
        transaction,
        quotaRef,
        quota,
        releasedCount,
        releasedBytes,
      );
      releasePendingRoomQuota(
        transaction,
        roomQuotaRef,
        roomQuotaSnapshot,
        ownerId,
        listingGeneration,
        roomSnapshot,
        releasedCount,
        releasedBytes,
      );
      transaction.set(
        commitRef,
        {
          type: 'roomPhotoCommit',
          ownerId,
          roomId,
          commitId,
          requestHash,
          listingGeneration,
          uploadIds,
          removeUrls,
          images,
          createdAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return { images, alreadyCommitted: false } satisfies CommitResult;
    });
  },
);

/**
 * Removes one staged upload which was not committed to a listing.
 *
 * The room is checked again on the server. If a concurrent commit already
 * referenced the object, it is kept and the operation is marked referenced.
 */
export const discardRoomPhotoUpload = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in before changing room photos.',
      );
    }
    const ownerId = context.auth.uid;
    await assertLiveOwner(ownerId);

    const roomId = String(data?.roomId || '').trim();
    const uploadId = String(data?.uploadId || '').trim();
    if (!validIdentifier(roomId, 128) || !validIdentifier(uploadId, 128)) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'The room-photo upload id is invalid.',
      );
    }

    const roomRef = db.collection('rooms').doc(roomId);
    const ownerRef = db.collection('users').doc(ownerId);
    const operationRef = db
      .collection('roomPhotoUploadOperations')
      .doc(operationDocumentId(ownerId, uploadId));
    const quotaRef = db
      .collection('roomPhotoUploadQuotas')
      .doc(quotaDocumentId(ownerId));
    const roomQuotaRef = db.collection('roomPhotoRoomQuotas').doc(roomId);

    let referenced = false;
    let terminal = false;
    let quarantined = false;
    let operationExists = false;
    await db.runTransaction(async (transaction) => {
      const roomSnapshot = await transaction.get(roomRef);
      const ownerSnapshot = await transaction.get(ownerRef);
      const operationSnapshot = await transaction.get(operationRef);
      const quotaSnapshot = await transaction.get(quotaRef);
      const roomQuotaSnapshot = await transaction.get(roomQuotaRef);
      if (!operationSnapshot.exists) return;
      operationExists = true;

      const operation = operationSnapshot.data() as Record<string, any>;
      if (
        String(operation.ownerId || '').trim() !== ownerId ||
        String(operation.roomId || '').trim() !== roomId
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'That room-photo upload does not belong to this listing.',
        );
      }
      assertLiveOwnerProfileSnapshot(ownerSnapshot, ownerId);
      const status = String(operation.status || '');
      if (
        isTerminalRoomPhotoStatus(status)
      ) {
        // These states are terminal. In particular, a committed upload must
        // never be removed merely because a stale client asked to discard it.
        referenced = status === 'referenced';
        terminal = true;
        return;
      }

      try {
        assertRoomPhotoOperationIdentity(operation, ownerId, roomId, uploadId);
      } catch (_) {
        quarantined = true;
        transaction.update(operationRef, {
          status: 'deleting',
          lastError: 'Invalid room-photo storage identity',
          cleanupStartedAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
          cleanupAfter: firestore.Timestamp.fromMillis(
            Date.now() + ROOM_PHOTO_CLEANUP_RETRY_MS,
          ),
        });
        return;
      }

      const url = String(operation.url || '').trim();
      const room = roomSnapshot.exists
        ? (roomSnapshot.data() as Record<string, any>)
        : null;
      if (roomReferencesUrl(room, url)) {
        referenced = true;
        transaction.update(operationRef, {
          status: 'referenced',
          referencedAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
          cleanupAfter: firestore.FieldValue.delete(),
        });
        releasePendingQuota(
          transaction,
          quotaRef,
          quotaState(quotaSnapshot),
          1,
          nonNegativeInteger(operation.byteLength),
        );
        releasePendingRoomQuota(
          transaction,
          roomQuotaRef,
          roomQuotaSnapshot,
          ownerId,
          String(operation.listingGeneration || '').trim(),
          roomSnapshot,
          1,
          nonNegativeInteger(operation.byteLength),
        );
        return;
      }

      transaction.update(operationRef, {
        status: 'deleting',
        cleanupStartedAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
        cleanupAfter: firestore.Timestamp.fromMillis(
          Date.now() + ROOM_PHOTO_CLEANUP_RETRY_MS,
        ),
      });
    });

    if (referenced) {
      return { discarded: false, referenced: true };
    }
    if (terminal) {
      return { discarded: false, referenced: false };
    }
    if (!operationExists) return { discarded: true, referenced: false };

    try {
      await deleteStorageObject(ownerId, roomId, uploadId);
    } catch (error) {
      console.error('Could not discard an unreferenced room photo:', error);
      throw new functions.https.HttpsError(
        'internal',
        'The unused room photo could not be removed yet. It will be retried.',
      );
    }

    await db.runTransaction(async (transaction) => {
      const roomSnapshot = await transaction.get(roomRef);
      const operationSnapshot = await transaction.get(operationRef);
      const quotaSnapshot = await transaction.get(quotaRef);
      const roomQuotaSnapshot = await transaction.get(roomQuotaRef);
      if (!operationSnapshot.exists) return;
      const operation = operationSnapshot.data() as Record<string, any>;
      const status = String(operation.status || '');
      if (
        isTerminalRoomPhotoStatus(status)
      ) {
        return;
      }
      transaction.update(operationRef, {
        status: quarantined ? 'quarantined' : 'cleaned',
        cleanedAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
        cleanupAfter: firestore.FieldValue.delete(),
      });
      releasePendingQuota(
        transaction,
        quotaRef,
        quotaState(quotaSnapshot),
        1,
        nonNegativeInteger(operation.byteLength),
      );
      releasePendingRoomQuota(
        transaction,
        roomQuotaRef,
        roomQuotaSnapshot,
        ownerId,
        String(operation.listingGeneration || '').trim(),
        roomSnapshot,
        1,
        nonNegativeInteger(operation.byteLength),
      );
    });

    return { discarded: true, referenced: false, quarantined };
  },
);

/**
 * Sweeps staged uploads which were never committed to a listing.
 *
 * The operation records are the durable inventory. Every expired pending
 * object is checked against the live room and then removed. A Storage outage
 * leaves the record in place for the next scheduled run.
 */
export async function cleanupExpiredRoomPhotoUploads(): Promise<{
  inspected: number;
  cleaned: number;
  referenced: number;
  quarantined: number;
  failed: number;
}> {
  let inspected = 0;
  let cleaned = 0;
  let referenced = 0;
  let quarantined = 0;
  let failed = 0;

  while (true) {
    const pending = await db
      .collection('roomPhotoUploadOperations')
      .where(
        'cleanupAfter',
        '<=',
        firestore.Timestamp.fromMillis(Date.now()),
      )
      .limit(100)
      .get();
    if (pending.empty) break;

    let retryMalformedPass = false;
    for (const snapshot of pending.docs) {
      inspected += 1;
      const operation = snapshot.data() as Record<string, any>;
      const ownerId = String(operation.ownerId || '').trim();
      const roomId = String(operation.roomId || '').trim();
      const uploadId = String(operation.uploadId || '').trim();
      const operationRef = snapshot.ref;

      if (
        !ownerId ||
        !validIdentifier(roomId, 128) ||
        !validIdentifier(uploadId, 128)
      ) {
        const quarantineResult = await quarantineMalformedRoomPhotoOperation(
          operationRef,
          ownerId,
          roomId,
          uploadId,
        );
        if (quarantineResult === 'quarantined') {
          quarantined += 1;
          continue;
        }
        if (quarantineResult === 'failed') {
          failed += 1;
          continue;
        }
        // The identity was repaired after the stale query. Read it again in
        // the next pass and use the normal, identity-checked cleanup path.
        retryMalformedPass = true;
        continue;
      }

      const quotaRef = db
        .collection('roomPhotoUploadQuotas')
        .doc(quotaDocumentId(ownerId));
      const roomQuotaRef = db.collection('roomPhotoRoomQuotas').doc(roomId);
      const roomRef = db.collection('rooms').doc(roomId);

      let keep = false;
      let keepAsReferenced = false;
      let quarantine = false;
      try {
        await db.runTransaction(async (transaction) => {
          const roomSnapshot = await transaction.get(roomRef);
          const operationSnapshot = await transaction.get(operationRef);
          const quotaSnapshot = await transaction.get(quotaRef);
          const roomQuotaSnapshot = await transaction.get(roomQuotaRef);
          if (!operationSnapshot.exists) return;

          const current = operationSnapshot.data() as Record<string, any>;
          const status = String(current.status || '');
          if (
            isTerminalRoomPhotoStatus(status)
          ) {
            // The query snapshot may be stale. A terminal operation is never
            // deleted, and a committed operation remains committed.
            keep = true;
            keepAsReferenced = status === 'referenced';
            transaction.update(operationRef, {
              cleanupAfter: firestore.FieldValue.delete(),
            });
            return;
          }

          if (!roomPhotoUploadExpired(current)) {
            // The expiry was moved after the stale query. Re-check it in the
            // transaction so cleanup never deletes a live reservation.
            keep = true;
            return;
          }

          try {
            assertRoomPhotoOperationIdentity(
              current,
              ownerId,
              roomId,
              uploadId,
            );
          } catch (_) {
            quarantine = true;
            transaction.update(operationRef, {
              status: 'deleting',
              lastError: 'Invalid room-photo storage identity',
              cleanupStartedAt: firestore.FieldValue.serverTimestamp(),
              updatedAt: firestore.FieldValue.serverTimestamp(),
              cleanupAfter: firestore.Timestamp.fromMillis(
                Date.now() + roomPhotoCleanupRetryDelay(
                  nonNegativeInteger(current.attempts),
                ),
              ),
            });
            return;
          }

          const url = String(current.url || '').trim();
          const room = roomSnapshot.exists
            ? (roomSnapshot.data() as Record<string, any>)
            : null;
          if (roomReferencesUrl(room, url)) {
            keep = true;
            keepAsReferenced = true;
            transaction.update(operationRef, {
              status: 'referenced',
              referencedAt: firestore.FieldValue.serverTimestamp(),
              updatedAt: firestore.FieldValue.serverTimestamp(),
              cleanupAfter: firestore.FieldValue.delete(),
            });
            releasePendingQuota(
              transaction,
              quotaRef,
              quotaState(quotaSnapshot),
              1,
              nonNegativeInteger(current.byteLength),
            );
            releasePendingRoomQuota(
              transaction,
              roomQuotaRef,
              roomQuotaSnapshot,
              ownerId,
              String(current.listingGeneration || '').trim(),
              roomSnapshot,
              1,
              nonNegativeInteger(current.byteLength),
            );
            return;
          }

          const attempts = nonNegativeInteger(current.attempts);
          transaction.update(operationRef, {
            status: 'deleting',
            cleanupStartedAt: firestore.FieldValue.serverTimestamp(),
            updatedAt: firestore.FieldValue.serverTimestamp(),
            cleanupAfter: firestore.Timestamp.fromMillis(
              Date.now() + roomPhotoCleanupRetryDelay(attempts),
            ),
          });
        });

        if (keep) {
          if (keepAsReferenced) referenced += 1;
          continue;
        }

        await deleteStorageObject(ownerId, roomId, uploadId);
        await db.runTransaction(async (transaction) => {
          const roomSnapshot = await transaction.get(roomRef);
          const operationSnapshot = await transaction.get(operationRef);
          const quotaSnapshot = await transaction.get(quotaRef);
          const roomQuotaSnapshot = await transaction.get(roomQuotaRef);
          if (!operationSnapshot.exists) return;
          const current = operationSnapshot.data() as Record<string, any>;
          const status = String(current.status || '');
          if (
            isTerminalRoomPhotoStatus(status)
          ) {
            return;
          }
          transaction.update(operationRef, {
            status: quarantine ? 'quarantined' : 'cleaned',
            cleanedAt: firestore.FieldValue.serverTimestamp(),
            updatedAt: firestore.FieldValue.serverTimestamp(),
            cleanupAfter: firestore.FieldValue.delete(),
          });
          releasePendingQuota(
            transaction,
            quotaRef,
            quotaState(quotaSnapshot),
            1,
            nonNegativeInteger(current.byteLength),
          );
          releasePendingRoomQuota(
            transaction,
            roomQuotaRef,
            roomQuotaSnapshot,
            ownerId,
            String(current.listingGeneration || '').trim(),
            roomSnapshot,
            1,
            nonNegativeInteger(current.byteLength),
          );
        });
        if (quarantine) {
          quarantined += 1;
        } else {
          cleaned += 1;
        }
      } catch (error) {
        failed += 1;
        console.error(
          `Could not clean the staged room photo ${operationRef.id}:`,
          error,
        );
        await db
          .runTransaction(async (transaction) => {
            const operationSnapshot = await transaction.get(operationRef);
            if (!operationSnapshot.exists) return;
            const current = operationSnapshot.data() as Record<string, any>;
            const status = String(current.status || '');
            if (
              isTerminalRoomPhotoStatus(status)
            ) {
              return;
            }
            const attempts = nonNegativeInteger(current.attempts);
            transaction.update(operationRef, {
              attempts: attempts + 1,
              lastError: String(error).slice(0, 300),
              updatedAt: firestore.FieldValue.serverTimestamp(),
              cleanupAfter: firestore.Timestamp.fromMillis(
                Date.now() + roomPhotoCleanupRetryDelay(attempts),
              ),
            });
          })
          .catch(() => undefined);
      }
    }

    // Successful operations remove cleanupAfter. Failed operations move it
    // into the future. Therefore the next query only sees new work.
    if (pending.size < 100 && !retryMalformedPass) break;
  }

  return { inspected, cleaned, referenced, quarantined, failed };
}

/**
 * Releases the pending room-photo reservations of one listing lifetime.
 *
 * A deleted listing can never commit its staged photos again — the room
 * document is gone and the prefix cleanup removes the objects. Their owner
 * quota would nevertheless stay reserved until the 24 hour expiry cleanup
 * runs, and the owner could not stage a single photo in the meantime.
 *
 * Every affected operation is terminalized in the same transaction which
 * releases its reservation. The terminal status is the release marker, so a
 * later cleanup run never releases the same reservation twice, and a
 * reservation of another listing is never touched.
 */
export async function releaseRoomPhotoReservationsForDeletedListing(options: {
  ownerId: string;
  roomId: string;
  listingGeneration: string;
}): Promise<{ releasedCount: number; releasedBytes: number }> {
  const ownerId = String(options.ownerId || '').trim();
  const roomId = String(options.roomId || '').trim();
  const listingGeneration = String(options.listingGeneration || '').trim();
  const released = { releasedCount: 0, releasedBytes: 0 };
  if (!ownerId || !roomId || !listingGeneration) return released;

  const quotaRef = db
    .collection('roomPhotoUploadQuotas')
    .doc(quotaDocumentId(ownerId));

  const operations = await db
    .collection('roomPhotoUploadOperations')
    .where('roomId', '==', roomId)
    .get();

  for (const snapshot of operations.docs) {
    const operation = snapshot.data() as Record<string, any>;
    if (
      String(operation.ownerId || '').trim() !== ownerId ||
      String(operation.listingGeneration || '').trim() !== listingGeneration
    ) {
      // A reservation of another listing (or of another owner which reused
      // the room id) is never released here.
      continue;
    }
    if (isTerminalRoomPhotoStatus(String(operation.status || ''))) continue;

    const operationRef = snapshot.ref;
    await db.runTransaction(async (transaction) => {
      const operationSnapshot = await transaction.get(operationRef);
      const quotaSnapshot = await transaction.get(quotaRef);
      if (!operationSnapshot.exists) return;
      const current = operationSnapshot.data() as Record<string, any>;
      if (isTerminalRoomPhotoStatus(String(current.status || ''))) return;
      if (
        String(current.ownerId || '').trim() !== ownerId ||
        String(current.roomId || '').trim() !== roomId ||
        String(current.listingGeneration || '').trim() !== listingGeneration
      ) {
        return;
      }

      transaction.update(operationRef, {
        status: 'discarded',
        discardedAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
        cleanupAfter: firestore.FieldValue.delete(),
      });
      const releasedBytes = nonNegativeInteger(current.byteLength);
      releasePendingQuota(
        transaction,
        quotaRef,
        quotaState(quotaSnapshot),
        1,
        releasedBytes,
      );
      released.releasedCount += 1;
      released.releasedBytes += releasedBytes;
    });
  }

  return released;
}
