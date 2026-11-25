import * as firestore from 'firebase-admin/firestore';
import * as functions from 'firebase-functions/v1';
import { callableHttps } from './appCheck';
import * as storage from 'firebase-admin/storage';
import * as crypto from 'crypto';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  assertLiveAdmin,
  assertLiveOwner,
  assertLiveOwnerOrAdmin,
  canActAsAdmin,
} from './accounts';
import {
  ACTIVE_BOOKING_STATUSES,
  canActAsRoomOwner,
} from './bookingAccess';
import { isActiveBookingStatus } from './bookings';
import {
  isValidCurrentOccupancy,
  isValidRoomCapacity,
} from './roomValidation';
import { PAGE_SIZE } from './batches';
import { notify } from './notifications';
import {
  readReviewNotificationDependencyRefs,
  reviewInstanceIdFor,
  reviewNotificationId,
} from './reviews';

const db = firestore.getFirestore();

/**
 * The durable cleanup-job id for one listing generation and cleanup kind.
 *
 * The owner, room id and immutable listing generation are all part of the
 * identity. A pending cleanup can therefore never be merged into a later
 * listing which happens to reuse the same room id.
 */
function roomPhotoCleanupJobId(
  ownerId: string,
  roomId: string,
  listingGeneration: string,
  kind: string,
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${kind}:${ownerId}:${roomId}:${listingGeneration}`)
    .digest('hex');
  return `room-photo-cleanup-${digest}`;
}

/** The durable job which resumes an interrupted listing deletion. */
function roomDeletionJobId(roomId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`room-deletion:${roomId}`)
    .digest('hex');
  return `room-deletion-${digest}`;
}

/**
 * The immutable generation of one room listing.
 *
 * New listings receive a server-generated UUID. Legacy listings fall back to
 * a stable digest of their owner, id and creation time so that their cleanup
 * jobs are still separated from a later listing with the same id.
 */
function roomListingGeneration(room: Record<string, any>): string {
  const data = room;
  const explicit = String(data?.listingGeneration || '').trim();
  if (explicit) return explicit;

  const ownerId = String(data?.ownerId || '').trim();
  const roomId = String(data?.roomId || '').trim();
  const createdAt = data?.createdAt;
  const createdMillis =
    createdAt && typeof createdAt.toMillis === 'function'
      ? String(createdAt.toMillis())
      : String(createdAt || '');
  const legacyDigest = crypto
    .createHash('sha256')
    .update(`${ownerId}:${roomId}:${createdMillis}`)
    .digest('hex')
    .slice(0, 24);
  return `legacy-${legacyDigest}`;
}

/**
 * Extracts the Storage object path from a Firebase download URL.
 *
 * Only the two download-URL formats emitted by Firebase Storage are
 * accepted. The caller additionally checks that the path is below the
 * expected room prefix before it is ever deleted.
 */
export function storageObjectPathFromDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    let objectPath = '';

    if (host === 'firebasestorage.googleapis.com') {
      const marker = '/o/';
      const markerIndex = url.pathname.indexOf(marker);
      if (markerIndex < 0) return null;
      objectPath = decodeURIComponent(url.pathname.substring(markerIndex + marker.length));
    } else if (host === 'storage.googleapis.com') {
      const marker = '/o/';
      const markerIndex = url.pathname.indexOf(marker);
      if (markerIndex >= 0) {
        objectPath = decodeURIComponent(url.pathname.substring(markerIndex + marker.length));
      } else {
        // Legacy format: https://storage.googleapis.com/{bucket}/{objectPath}
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments.length < 2) return null;
        objectPath = decodeURIComponent(segments.slice(1).join('/'));
      }
    } else {
      return null;
    }

    objectPath = objectPath.replace(/^\/+/, '').trim();
    return objectPath || null;
  } catch (_) {
    return null;
  }
}

/** Reads a list of non-empty strings from a Firestore value. */
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

/** How long one photo-cleanup lock may block a client room update. */
const ROOM_PHOTO_CLEANUP_LOCK_MS = 2 * 60 * 1000;

/** The Storage paths which the current room document still references. */
function referencedRoomPhotoPaths(
  snapshot: firestore.DocumentSnapshot,
): Set<string> {
  const paths = new Set<string>();
  if (!snapshot.exists) return paths;

  for (const url of stringList(snapshot.get('images'))) {
    const path = storageObjectPathFromDownloadUrl(url);
    if (path) paths.add(path);
  }
  return paths;
}

/** A cleanup job which can never be executed safely. */
class InvalidRoomPhotoCleanupJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRoomPhotoCleanupJobError';
  }
}

/** The newest timestamp which can prove that a review is still old. */
function reviewRelevantMillis(review: Record<string, any>): number | null {
  const createdAt = review.createdAt as
    | { toMillis?: () => number }
    | null
    | undefined;
  const updatedAt = review.updatedAt as
    | { toMillis?: () => number }
    | null
    | undefined;
  const createdMillis =
    createdAt && typeof createdAt.toMillis === 'function'
      ? createdAt.toMillis()
      : null;
  const updatedMillis =
    updatedAt && typeof updatedAt.toMillis === 'function'
      ? updatedAt.toMillis()
      : null;
  return createdMillis === null
    ? updatedMillis
    : updatedMillis === null
      ? createdMillis
      : Math.max(createdMillis, updatedMillis);
}

/**
 * Deletes the reviews which belonged to a removed listing.
 *
 * The immutable listing generation is the primary boundary. The timestamp
 * cutoff is only used for legacy reviews which predate generations. Every
 * candidate is re-read in a transaction before it is deleted, so a review
 * which was updated after the query snapshot cannot be removed by a stale
 * cleanup decision.
 */
async function deleteRoomReviewsBefore(
  roomId: string,
  cutoff: firestore.Timestamp,
  listingGeneration: string,
): Promise<void> {
  const cutoffMillis = cutoff.toMillis();
  let cursor: firestore.QueryDocumentSnapshot | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = db
      .collection('roomReviews')
      .where('roomId', '==', roomId)
      .orderBy('__name__');
    if (cursor) query = query.startAfter(cursor);

    const page = await query.limit(PAGE_SIZE).get();
    if (page.empty) break;

    for (const reviewDoc of page.docs) {
      // Read the notification dependencies before the destructive
      // transaction. Legacy copies are found through their review id, while
      // the deterministic copy and its attribution are added again below
      // from the exact lifecycle seen in the transaction.
      const dependencySource = await reviewDoc.ref.get();
      if (!dependencySource.exists) continue;
      const dependencyRefs = await readReviewNotificationDependencyRefs(
        reviewDoc.id,
        reviewInstanceIdFor(dependencySource),
      );

      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(reviewDoc.ref);
        if (!current.exists) return;

        const review = current.data() as Record<string, any>;
        const reviewGeneration = String(
          review.listingGeneration || '',
        ).trim();
        if (reviewGeneration && reviewGeneration !== listingGeneration) {
          // This review belongs to a different listing generation. It must
          // survive even when the room id was reused.
          return;
        }

        const relevantMillis = reviewRelevantMillis(review);
        if (
          reviewGeneration !== listingGeneration &&
          relevantMillis !== null &&
          relevantMillis > cutoffMillis
        ) {
          // A legacy review was updated after the deletion cutoff. It may be
          // a review of a later listing, so it is retained.
          return;
        }

        const notificationRefs = new Map(
          dependencyRefs.notificationRefs.map((reference) => [
            reference.path,
            reference,
          ]),
        );
        const attributionRefs = new Map(
          dependencyRefs.attributionRefs.map((reference) => [
            reference.path,
            reference,
          ]),
        );
        const reviewInstanceId = reviewInstanceIdFor(current);
        const ownerId = String(review.ownerId || '').trim();
        if (ownerId) {
          const notificationId = reviewNotificationId(
            reviewDoc.id,
            reviewInstanceId,
            ownerId,
          );
          notificationRefs.set(
            db.collection('notifications').doc(notificationId).path,
            db.collection('notifications').doc(notificationId),
          );
          attributionRefs.set(
            db.collection('notificationAttributions').doc(notificationId).path,
            db.collection('notificationAttributions').doc(notificationId),
          );
        }

        // The visible copies disappear first, followed by the server-only
        // attribution and finally the review source. All three changes commit
        // atomically, so a failed cleanup leaves the complete review lifecycle
        // available for the durable job's next retry.
        for (const reference of notificationRefs.values()) {
          transaction.delete(reference);
        }
        for (const reference of attributionRefs.values()) {
          transaction.delete(reference);
        }
        transaction.delete(reviewDoc.ref);
      });
    }

    cursor = page.docs[page.docs.length - 1];
    if (page.size < PAGE_SIZE) break;
  }
}

/**
 * Removes the Storage objects described by one cleanup job and then deletes
 * the job. The job is only removed after the Storage deletion succeeded, so a
 * transient failure is retried by the scheduled worker.
 */
async function processRoomPhotoCleanupJob(
  jobRef: firestore.DocumentReference,
): Promise<void> {
  const snapshot = await jobRef.get();
  if (!snapshot.exists) return;

  const data = snapshot.data() as Record<string, any>;
  const ownerId = String(data.ownerId || '').trim();
  const roomId = String(data.roomId || '').trim();
  const listingGeneration = String(data.listingGeneration || '').trim();
  const expectedPrefix = `rooms/${ownerId}/${roomId}/`;
  const tombstoneRef = db.collection('roomDeletionTombstones').doc(roomId);
  const type = String(data.type || '');
  const cleanupLock: {
    roomRef: firestore.DocumentReference | null;
    token: string;
  } = { roomRef: null, token: '' };

  try {
    if (!ownerId || !roomId || !expectedPrefix.startsWith('rooms/')) {
      throw new InvalidRoomPhotoCleanupJobError(
        'The room-photo cleanup job is invalid',
      );
    }

    const deletionOperationId = String(data.deletionOperationId || '').trim();
    if (type === 'roomPhotoPrefix' && deletionOperationId) {
      const tombstone = await tombstoneRef.get();
      const tombstoneOperationId = String(
        tombstone.get('deletionOperationId') || '',
      ).trim();
      const tombstoneGeneration = String(
        tombstone.get('listingGeneration') || '',
      ).trim();
      if (
        !tombstone.exists ||
        tombstoneOperationId !== deletionOperationId ||
        (listingGeneration && tombstoneGeneration !== listingGeneration)
      ) {
        throw new InvalidRoomPhotoCleanupJobError(
          'The room-photo cleanup tombstone does not match the listing',
        );
      }
    }

    if (data.deleteRoomReviews === true) {
      const cutoff = data.reviewCutoff;
      if (
        !cutoff ||
        typeof cutoff.toMillis !== 'function'
      ) {
        throw new InvalidRoomPhotoCleanupJobError(
          'The room-review cleanup cutoff is invalid',
        );
      }
      await deleteRoomReviewsBefore(
        roomId,
        cutoff as firestore.Timestamp,
        listingGeneration,
      );
    }

    const bucket = storage.getStorage().bucket();
    let processedPaths: string[] = [];

    if (type === 'roomPhotoPrefix') {
      const prefix = String(data.storagePrefix || expectedPrefix);
      if (!prefix.startsWith(expectedPrefix)) {
        throw new InvalidRoomPhotoCleanupJobError(
          'The room-photo cleanup prefix is invalid',
        );
      }
      const [files] = await bucket.getFiles({ prefix });
      processedPaths = files.map((file) => file.name);
      for (const file of files) {
        await file.delete({ ignoreNotFound: true });
      }
    } else if (type === 'roomPhotoPaths') {
      const initialPaths = stringList(data.paths);
      for (const path of initialPaths) {
        if (!path.startsWith(expectedPrefix)) {
          throw new InvalidRoomPhotoCleanupJobError(
            'The room-photo cleanup path is invalid',
          );
        }
      }

      const roomRef = db.collection('rooms').doc(roomId);
      const lockToken = crypto.randomUUID();

      await db.runTransaction(async (transaction) => {
        const latest = await transaction.get(jobRef);
        if (!latest.exists) return;

        const roomSnapshot = await transaction.get(roomRef);
        const currentPaths = stringList(latest.get('paths'));
        const referencedPaths = referencedRoomPhotoPaths(roomSnapshot);
        const currentGeneration = String(
          roomSnapshot.get('listingGeneration') || '',
        ).trim();
        if (
          roomSnapshot.exists &&
          currentGeneration &&
          currentGeneration !== listingGeneration
        ) {
          // This cleanup belongs to an earlier lifetime of the room id. The
          // prefix cleanup of that listing removed its files; touching them
          // now could delete a photo of the current listing.
          transaction.delete(jobRef);
          processedPaths = [];
          return;
        }

        // A path which the room references again is live data, not an
        // orphan. It is removed from the cleanup job without deleting the
        // Storage object.
        const safePaths = currentPaths.filter(
          (path) => !referencedPaths.has(path),
        );
        const retainedPaths = currentPaths.filter((path) =>
          referencedPaths.has(path),
        );

        // Every path-processing pass installs the room lock, including a
        // pass in which all paths are currently referenced. Otherwise an
        // owner could remove a referenced path while the worker was running;
        // the update trigger would add it back to the job, but the worker
        // would then remove the path from the job without deleting its file.
        cleanupLock.roomRef = roomRef;

        if (roomSnapshot.exists && currentPaths.length > 0) {
          const existingLock = roomSnapshot.get('photoCleanupLock');
          const lockExpiresAt =
            existingLock &&
            existingLock.expiresAt &&
            typeof existingLock.expiresAt.toMillis === 'function'
              ? existingLock.expiresAt.toMillis()
              : 0;
          if (lockExpiresAt > Date.now()) {
            throw new Error(
              'The room photo cleanup is already locked by another worker',
            );
          }

          // The lock is committed on the room before Storage is touched.
          // Firestore rules reject client room updates while it is active,
          // so an image cannot be re-added between the reference check and
          // the file deletion. A crashed worker releases the edit block
          // automatically when the short lease expires.
          transaction.update(roomRef, {
            photoCleanupLock: {
              token: lockToken,
              expiresAt: firestore.Timestamp.fromMillis(
                Date.now() + ROOM_PHOTO_CLEANUP_LOCK_MS,
              ),
            },
          });
          cleanupLock.roomRef = roomRef;
          cleanupLock.token = lockToken;
        }

        processedPaths = [...safePaths, ...retainedPaths];
      });

      for (const path of processedPaths) {
        const roomSnapshot = cleanupLock.roomRef
          ? await cleanupLock.roomRef.get()
          : null;
        const referencedPaths = roomSnapshot
          ? referencedRoomPhotoPaths(roomSnapshot)
          : new Set<string>();
        if (referencedPaths.has(path)) continue;
        await bucket.file(path).delete({ ignoreNotFound: true });
      }
    } else {
      throw new InvalidRoomPhotoCleanupJobError(
        'The room-photo cleanup job type is invalid',
      );
    }

    // Re-read the job transactionally before removing it. A concurrent room
    // update may have added another path while the files were being deleted;
    // in that case the job has to stay for the next run.
    await db.runTransaction(async (transaction) => {
      const latest = await transaction.get(jobRef);
      if (!latest.exists) return;
      const lockedRoomSnapshot = cleanupLock.roomRef
        ? await transaction.get(cleanupLock.roomRef)
        : null;
      const tombstoneSnapshot = await transaction.get(tombstoneRef);

      const latestType = String(latest.get('type') || '');
      if (latestType === 'roomPhotoPrefix') {
        const latestPrefix = String(latest.get('storagePrefix') || '');
        const latestOperationId = String(
          latest.get('deletionOperationId') || '',
        );
        const expectedOperationId = String(
          data.deletionOperationId || '',
        );
        if (
          latestPrefix === String(data.storagePrefix || expectedPrefix) &&
          (!expectedOperationId || latestOperationId === expectedOperationId)
        ) {
          transaction.delete(jobRef);
          if (
            expectedOperationId &&
            tombstoneSnapshot.exists &&
            String(tombstoneSnapshot.get('deletionOperationId') || '') ===
              expectedOperationId
          ) {
            // The room id remains reserved until every old photo and review
            // has really been removed. Only now may a later listing reuse
            // the id without sharing its Storage prefix.
            transaction.delete(tombstoneRef);
          }
        }
        return;
      }

      if (latestType === 'roomPhotoPaths') {
        const latestPaths = stringList(latest.get('paths'));
        const remainingPaths = latestPaths.filter(
          (path) => !processedPaths.includes(path),
        );
        if (remainingPaths.length === 0) {
          transaction.delete(jobRef);
        } else if (remainingPaths.length !== latestPaths.length) {
          transaction.update(jobRef, {
            paths: remainingPaths,
            updatedAt: firestore.FieldValue.serverTimestamp(),
          });
        }
      }

      if (cleanupLock.roomRef && cleanupLock.token && lockedRoomSnapshot) {
        const lock = lockedRoomSnapshot.get('photoCleanupLock');
        if (
          lock &&
          String(lock.token || '') === cleanupLock.token
        ) {
          transaction.update(cleanupLock.roomRef, {
            photoCleanupLock: firestore.FieldValue.delete(),
          });
        }
      }
    });
  } catch (error) {
    if (cleanupLock.roomRef && cleanupLock.token) {
      try {
        await db.runTransaction(async (transaction) => {
          const roomSnapshot = await transaction.get(cleanupLock.roomRef!);
          const lock = roomSnapshot.get('photoCleanupLock');
          if (
            lock &&
            String(lock.token || '') === cleanupLock.token
          ) {
            transaction.update(cleanupLock.roomRef!, {
              photoCleanupLock: firestore.FieldValue.delete(),
            });
          }
        });
      } catch (releaseError) {
        console.error(
          'Could not release the room photo cleanup lock:',
          releaseError,
        );
      }
    }

    try {
      if (error instanceof InvalidRoomPhotoCleanupJobError) {
        // A malformed job can never succeed. Move it out of the worker's
        // query instead of letting it occupy every run and starve valid
        // cleanup jobs forever.
        await jobRef.set(
          {
            type: 'quarantinedRoomPhotoCleanup',
            status: 'quarantined',
            lastError: String(error).slice(0, 300),
            quarantinedAt: firestore.FieldValue.serverTimestamp(),
            updatedAt: firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        console.error('Quarantined an invalid room-photo cleanup job:', error);
        return;
      }

      const attempts = Number(data.attempts || 0);
      const backoffMinutes = Math.min(24 * 60, 15 * Math.pow(2, attempts));
      await jobRef.set(
        {
          attempts: firestore.FieldValue.increment(1),
          lastError: String(error).slice(0, 300),
          nextAttemptAt: firestore.Timestamp.fromMillis(
            Date.now() + backoffMinutes * 60 * 1000,
          ),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (updateError) {
      console.error('Could not record the cleanup-job failure:', updateError);
    }
    throw error;
  }
}

/**
 * Retries durable room-photo cleanup jobs.
 *
 * A job is written together with the room deletion or by the room-update
 * trigger. A Storage outage can therefore never leave unreferenced photos
 * with no server-side record of the work which still has to be done.
 */
export const processRoomPhotoCleanupJobs = functions.pubsub
  .schedule('every 15 minutes')
  .onRun(async () => {
    let completed = 0;
    let failed = 0;
    let inspected = 0;
    let cursor: firestore.QueryDocumentSnapshot | undefined;

    // Walk every matching job instead of taking only the first 50. A fixed
    // limit allowed a handful of deferred or repeatedly failing jobs to
    // starve every valid cleanup behind them.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let query = db
        .collection('cleanupJobs')
        .where('type', 'in', [
          'roomDeletion',
          'roomPhotoPrefix',
          'roomPhotoPaths',
        ])
        .orderBy('__name__');
      if (cursor) query = query.startAfter(cursor);
      const jobs = await query.limit(100).get();
      if (jobs.empty) break;

      for (const job of jobs.docs) {
        inspected += 1;
        const nextAttemptAt = job.get('nextAttemptAt');
        if (
          nextAttemptAt &&
          typeof nextAttemptAt.toMillis === 'function' &&
          nextAttemptAt.toMillis() > Date.now()
        ) {
          continue;
        }

        try {
          if (job.get('type') === 'roomDeletion') {
            await processRoomDeletionJob(job.ref);
          } else {
            await processRoomPhotoCleanupJob(job.ref);
          }
          completed += 1;
        } catch (error) {
          failed += 1;
          console.error(
            `Could not clean the room photos for job ${job.id}:`,
            error,
          );
        }
      }

      cursor = jobs.docs[jobs.docs.length - 1];
      if (jobs.size < 100) break;
    }

    if (failed > 0) {
      // The jobs remain durable, and the failed invocation is also retried by
      // the scheduler so a transient Storage outage is visible immediately.
      throw new Error(`${failed} room cleanup job(s) failed`);
    }

    console.log(
      `Room cleanup jobs completed: ${completed}/${inspected}`,
    );
    return null;
  });

/**
 * The listing status values an owner may choose.
 *
 * `RoomStatus` historically combines two ideas: whether the owner has taken
 * the listing off the market and whether the room has reached its capacity.
 * The app's existing `RoomModel`, student search query and booking gate all
 * read the legacy `rooms.status` field, so that is the field this callable
 * updates for compatibility.
 *
 * The occupancy counter is deliberately a different concern:
 * `rooms.currentOccupancy` is server-owned and is changed only by booking
 * activation, rollback or an explicit owner/admin availability release.
 * Introducing a second listing-status field without migrating the model, the
 * queries and the admin path at the same time would make the owner action
 * invisible to part of the app.
 */
export type RoomListingStatus = 'available' | 'occupied';

/** Why an owner may not change the listing status. */
export type RoomListingAvailabilityRejection =
  | 'invalid-capacity'
  | 'invalid-occupancy'
  | 'already-full';

/** The result of the pure availability decision. */
export type RoomListingAvailabilityDecision =
  | { allowed: true; status: RoomListingStatus }
  | { allowed: false; reason: RoomListingAvailabilityRejection };

/**
 * Decides whether the owner may mark a listing occupied or available.
 *
 * The occupancy counter is read-only here:
 *
 *  - a full room is already occupied by the server and may not be marked
 *    occupied again by the owner;
 *  - a room with active occupants may be marked available. That is an explicit
 *    release operation: the server ends the active bookings, clears the
 *    occupancy and removes those students from their joined rooms in the same
 *    transaction.
 *
 * Keeping those rules in a pure helper makes the important transition logic
 * testable without a Firestore emulator.
 */
export function decideRoomListingAvailability(
  isOccupied: boolean,
  occupancy: number,
  currentOccupancy: number,
): RoomListingAvailabilityDecision {
  if (!isValidRoomCapacity(occupancy)) {
    return { allowed: false, reason: 'invalid-capacity' };
  }
  if (
    !isValidCurrentOccupancy(currentOccupancy) ||
    currentOccupancy > occupancy
  ) {
    return { allowed: false, reason: 'invalid-occupancy' };
  }

  if (isOccupied && currentOccupancy >= occupancy) {
    return { allowed: false, reason: 'already-full' };
  }

  return {
    allowed: true,
    status: isOccupied ? 'occupied' : 'available',
  };
}

/** One active booking which was ended by an availability release. */
interface ReleasedRoomBooking {
  requestId: string;
  studentId: string;
}

/** The result of releasing the active bookings of one room. */
interface RoomBookingReleaseResult {
  bookings: ReleasedRoomBooking[];
  releasedRequests: number;
  releasedStudents: number;
}

/** Who ended the bookings of a room. */
interface RoomReleaseActor {
  uid: string;
  role: 'owner' | 'admin';
}

/**
 * Makes a room available and ends every booking which has already been
 * accepted for it.
 *
 * A joined room is represented by an `adminReviewed` request. Only those
 * active bookings are cancelled here so that:
 *
 *  - the student's joined-room stream removes this room immediately;
 *  - the room's occupancy returns to zero;
 *  - requests which have not become active yet keep their own workflow;
 *  - the student may keep every other room they joined.
 *
 * The request query and both document reads happen inside the caller's
 * transaction. A booking activation writes the same room document, so the
 * two operations are serialized: whichever one commits first, the other
 * retries against the new state.
 *
 * Payment and invoice records are deliberately left untouched. Ending a
 * booking does not claim that a refund happened; that remains a separate
 * financial decision.
 */
async function releaseActiveBookingsForAvailableRoom(
  transaction: firestore.Transaction,
  roomRef: firestore.DocumentReference,
  roomSnapshot: firestore.DocumentSnapshot,
  actor: RoomReleaseActor,
): Promise<RoomBookingReleaseResult> {
  const room = roomSnapshot.data() as Record<string, any>;
  const roomId = roomSnapshot.id;
  const currentOccupancy = room.currentOccupancy;

  if (!isValidCurrentOccupancy(currentOccupancy)) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This room has an invalid occupancy',
    );
  }

  // Read every active request of this room before the first write. The
  // transaction query is re-run when a concurrent activation causes a retry.
  const requestSnapshot = await transaction.get(
    db
      .collection('joinRequests')
      .where('roomId', '==', roomId)
      .where('status', 'in', ACTIVE_BOOKING_STATUSES),
  );

  const bookings: ReleasedRoomBooking[] = [];
  const studentIds = new Set<string>();

  for (const requestDocument of requestSnapshot.docs) {
    const request = requestDocument.data() as Record<string, any>;
    const studentId = String(request.studentId || '').trim();
    const requestOwnerId = String(request.ownerId || '').trim();
    const roomOwnerId = String(room.ownerId || '').trim();

    if (!studentId || !requestOwnerId || requestOwnerId !== roomOwnerId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'One of this room\'s bookings has invalid ownership data and must be repaired first',
      );
    }

    bookings.push({
      requestId: requestDocument.id,
      studentId,
    });
    studentIds.add(studentId);
  }

  if (bookings.length !== currentOccupancy) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This room\'s occupancy does not match its active bookings and must be repaired first',
    );
  }

  const endedAt = firestore.FieldValue.serverTimestamp();
  const reason =
    actor.role === 'owner'
      ? 'The room owner marked the listing available.'
      : 'An administrator marked the listing available.';

  for (const booking of bookings) {
    transaction.update(db.collection('joinRequests').doc(booking.requestId), {
      status: 'cancelled',
      cancelledAt: endedAt,
      cancelledBy: actor.uid,
      cancelledByRole: actor.role,
      cancellationReason: reason,
      bookingEndedAt: endedAt,
      bookingEndedBy: actor.uid,
      bookingEndedByRole: actor.role,
      bookingEndReason: reason,
      updatedAt: endedAt,
    });
  }

  transaction.update(roomRef, {
    status: 'available',
    currentOccupancy: 0,
    updatedAt: endedAt,
  });

  return {
    bookings,
    releasedRequests: bookings.length,
    releasedStudents: studentIds.size,
  };
}

/**
 * Lets a live owner change the availability of one of their own listings.
 *
 * The owner and the room are checked on the server. The room is read inside
 * a Firestore transaction, so the ownership check and the write are based on
 * the same document version.
 *
 * Marking the listing available is an explicit release operation: active
 * bookings are ended and `currentOccupancy` is cleared in the same
 * transaction. Marking it occupied changes only the listing-status field.
 */
export const setRoomListingAvailability = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }

    const uid = context.auth.uid;
    const roomId = String(data?.roomId || '').trim();
    const isOccupied = data?.isOccupied;

    if (!roomId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Missing room',
      );
    }
    if (typeof isOccupied !== 'boolean') {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'isOccupied must be a boolean',
      );
    }

    // The custom claim may be stale. The live server-side profile decides
    // whether this user is still a registered, active owner.
    await assertLiveOwner(uid);

    const roomRef = db.collection('rooms').doc(roomId);

    const outcome = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That room no longer exists',
        );
      }

      const room = snapshot.data() as Record<string, any>;

      // The live owner role is checked in the same transaction as the status
      // change. A concurrent demotion or ban cannot be overwritten by this
      // write.
      const ownerProfile = await transaction.get(
        db.collection('users').doc(uid),
      );
      if (
        !canActAsRoomOwner({
          exists: ownerProfile.exists,
          registrationCompleted: ownerProfile.get('registrationCompleted'),
          isActive: ownerProfile.get('isActive'),
          role: ownerProfile.get('role'),
        })
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Only a live owner account can change this listing.',
        );
      }

      if (room.deletionInProgress === true) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This listing is being deleted and its status cannot be changed',
        );
      }
      if (String(room.ownerId || '') !== uid) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'You can only change your own listings',
        );
      }

      const occupancy = room.occupancy;
      const currentOccupancy = room.currentOccupancy;

      const decision = decideRoomListingAvailability(
        isOccupied,
        occupancy,
        currentOccupancy,
      );

      if (!decision.allowed) {
        switch (decision.reason) {
          case 'invalid-capacity':
            throw new functions.https.HttpsError(
              'failed-precondition',
              'This room has an invalid capacity',
            );
          case 'invalid-occupancy':
            throw new functions.https.HttpsError(
              'failed-precondition',
              'This room has an invalid occupancy',
            );
          case 'already-full':
            throw new functions.https.HttpsError(
              'failed-precondition',
              'This room is already full; occupancy is managed by booking activation',
            );
        }
      }

      if (decision.status === 'available') {
        const release = await releaseActiveBookingsForAvailableRoom(
          transaction,
          roomRef,
          snapshot,
          { uid, role: 'owner' },
        );
        return { status: decision.status, release };
      }

      transaction.update(roomRef, {
        status: decision.status,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });

      return { status: decision.status, release: null };
    });

    if (outcome.release) {
      await Promise.all(
        outcome.release.bookings.map((booking) =>
          notify(
            booking.studentId,
            'Room booking ended',
            'The room owner marked this listing available. You have been ' +
              'removed from the room immediately. Payment and invoice history ' +
              'is kept unchanged.',
            'joinRequest',
            { requestId: booking.requestId, roomId },
          ),
        ),
      );
    }

    return {
      success: true,
      status: outcome.status,
      releasedRequests: outcome.release?.releasedRequests || 0,
      releasedStudents: outcome.release?.releasedStudents || 0,
    };
  },
);

/** The request states that are still open when a listing is removed. */
export const OPEN_ROOM_REQUEST_STATUSES = [
  'pending',
  'ownerConfirmed',
  'studentConfirmed',
];

/** The request fields that decide whether a listing may be deleted. */
export interface RoomDeletionRequestState {
  status: string;
  advancePaid?: boolean;
  platformCutTaken?: boolean;
  advancePaymentStatus?: string;
}

/** Why a room listing may not be deleted. */
export type RoomDeletionRejection =
  | 'invalid-occupancy'
  | 'has-occupants'
  | 'active-booking'
  | 'payment-in-progress';

/** The result of the pure room-deletion decision. */
export type RoomDeletionDecision =
  | { allowed: true }
  | { allowed: false; reason: RoomDeletionRejection };

/**
 * Decides whether a listing may be removed.
 *
 * A listing with an active booking or a payment that still has to be
 * reviewed must not disappear: the student would lose the joined room and
 * the payment/invoice history would point at a room that does not exist.
 * Deleting an empty listing is safe because the open requests are cancelled
 * by the server in the same operation.
 */
export function decideRoomDeletion(
  currentOccupancy: number,
  requests: readonly RoomDeletionRequestState[],
): RoomDeletionDecision {
  if (!isValidCurrentOccupancy(currentOccupancy)) {
    return { allowed: false, reason: 'invalid-occupancy' };
  }

  if (currentOccupancy > 0) {
    return { allowed: false, reason: 'has-occupants' };
  }

  for (const request of requests) {
    if (isActiveBookingStatus(String(request.status || ''))) {
      return { allowed: false, reason: 'active-booking' };
    }

    if (
      request.advancePaid === true ||
      request.platformCutTaken === true ||
      request.advancePaymentStatus === 'submitted' ||
      request.advancePaymentStatus === 'verified'
    ) {
      return { allowed: false, reason: 'payment-in-progress' };
    }
  }

  return { allowed: true };
}

/**
 * Inspects every request of one listing in bounded pages.
 *
 * The old listing-deletion path read the complete request collection with
 * one unbounded query. A room with a long request history could therefore
 * exhaust the function's memory before the safety decision was made. This
 * helper stops at the first blocking request and never holds more than one
 * page in memory.
 */
async function inspectRoomRequestsForDeletion(
  roomId: string,
  currentOccupancy: number,
): Promise<RoomDeletionDecision> {
  let cursor: firestore.QueryDocumentSnapshot | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = db
      .collection('joinRequests')
      .where('roomId', '==', roomId)
      .orderBy(firestore.FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor);

    const snapshot = await query.limit(PAGE_SIZE).get();
    if (snapshot.empty) break;

    for (const requestDoc of snapshot.docs) {
      const request = requestDoc.data() as Record<string, any>;
      const decision = decideRoomDeletion(currentOccupancy, [
        {
          status: String(request.status || ''),
          advancePaid: request.advancePaid === true,
          platformCutTaken: request.platformCutTaken === true,
          advancePaymentStatus: String(request.advancePaymentStatus || ''),
        },
      ]);
      if (!decision.allowed) return decision;
    }

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }

  return { allowed: true };
}

/**
 * Re-checks a user-triggered deletion caller's role and account state inside
 * the marker transaction.
 *
 * The callable performs the live Firebase Auth check before this function is
 * reached (`assertLiveOwnerOrAdmin`). This transaction-time check is kept
 * separate because Firebase Auth cannot be read from a Firestore transaction
 * callback, and it serializes a concurrent demotion or ban with the start of
 * the deletion operation.
 *
 * It is deliberately not used by resumed cleanup. Once the server-owned
 * deletion marker and durable job exist, cleanup must be able to finish even
 * if the original caller was subsequently deleted.
 */
function assertRoomDeletionActorAuthority(
  callerSnapshot: firestore.DocumentSnapshot,
  uid: string,
  ownerId: string,
): void {
  const role = String(callerSnapshot.get('role') || '')
    .trim()
    .toLowerCase();
  const isAdmin = canActAsAdmin({
    exists: callerSnapshot.exists,
    registrationCompleted: callerSnapshot.get('registrationCompleted'),
    isActive: callerSnapshot.get('isActive'),
    role,
  });
  const isOwner = canActAsRoomOwner({
    exists: callerSnapshot.exists,
    registrationCompleted: callerSnapshot.get('registrationCompleted'),
    isActive: callerSnapshot.get('isActive'),
    role,
  });

  if (!isAdmin && (!isOwner || ownerId !== uid)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Owner or admin access required',
    );
  }
}

/**
 * Authorizes a resumed cleanup transaction from the server-owned deletion
 * marker rather than from the original caller's current account.
 *
 * A deleted or demoted caller must not strand a durable cleanup job. The
 * operation id ties the room marker to the exact deletion which the server
 * previously authorized.
 */
function assertRoomDeletionCleanupAuthorization(
  roomSnapshot: firestore.DocumentSnapshot,
  operation: RoomDeletionOperation,
): void {
  if (!roomSnapshot.exists) return;
  const room = roomSnapshot.data() as Record<string, any>;
  if (
    room.deletionInProgress !== true ||
    String(room.deletionOperationId || '') !== operation.deletionOperationId
  ) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The listing deletion is no longer active. Try again.',
    );
  }
}

/** The durable state of one listing-deletion operation. */
interface RoomDeletionOperation {
  roomId: string;
  ownerId: string;
  listingGeneration: string;
  deletionOperationId: string;
  requestedBy: string;
  previousStatus: string;
}

/** Reads and validates the durable state of a listing-deletion job. */
function roomDeletionOperationFromSnapshot(
  snapshot: firestore.DocumentSnapshot,
): RoomDeletionOperation {
  if (!snapshot.exists) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The listing-deletion job no longer exists',
    );
  }

  const data = snapshot.data() as Record<string, any>;
  const operation: RoomDeletionOperation = {
    roomId: String(data.roomId || '').trim(),
    ownerId: String(data.ownerId || '').trim(),
    listingGeneration: String(data.listingGeneration || '').trim(),
    deletionOperationId: String(data.deletionOperationId || '').trim(),
    requestedBy: String(data.deletionRequestedBy || '').trim(),
    previousStatus: String(data.previousStatus || 'available').trim(),
  };
  if (
    !operation.roomId ||
    !operation.ownerId ||
    !operation.listingGeneration ||
    !operation.deletionOperationId ||
    !operation.requestedBy
  ) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The listing-deletion job is invalid',
    );
  }
  return operation;
}

/**
 * Restores a listing whose deletion operation did not complete.
 *
 * The room marker, the durable deletion job and the id-reservation tombstone
 * are removed in one transaction. If that transaction fails, all three remain
 * together and the scheduled worker can safely resume the operation.
 */
async function restoreRoomDeletion(
  operation: RoomDeletionOperation,
  jobRef: firestore.DocumentReference,
): Promise<void> {
  const roomRef = db.collection('rooms').doc(operation.roomId);
  const tombstoneRef = db
    .collection('roomDeletionTombstones')
    .doc(operation.roomId);

  await db.runTransaction(async (transaction) => {
    const [roomSnapshot, jobSnapshot, tombstoneSnapshot] =
      await transaction.getAll(roomRef, jobRef, tombstoneRef);
    if (!roomSnapshot.exists) return;

    const room = roomSnapshot.data() as Record<string, any>;
    if (
      room.deletionInProgress !== true ||
      String(room.deletionOperationId || '') !== operation.deletionOperationId
    ) {
      // A newer operation superseded this one. It owns the marker and must
      // not be removed by the stale operation.
      return;
    }

    const restoreStatus =
      String(room.status || '') === 'inactive' &&
      operation.previousStatus !== 'inactive'
        ? operation.previousStatus
        : String(room.status || 'inactive');

    transaction.update(roomRef, {
      status: restoreStatus,
      deletionInProgress: firestore.FieldValue.delete(),
      deletionRequestedBy: firestore.FieldValue.delete(),
      deletionOperationId: firestore.FieldValue.delete(),
      deletionRequestedAt: firestore.FieldValue.delete(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });

    if (
      jobSnapshot.exists &&
      String(jobSnapshot.get('deletionOperationId') || '') ===
        operation.deletionOperationId
    ) {
      transaction.delete(jobRef);
    }
    if (
      tombstoneSnapshot.exists &&
      String(tombstoneSnapshot.get('deletionOperationId') || '') ===
        operation.deletionOperationId
    ) {
      transaction.delete(tombstoneRef);
    }
  });
}

/**
 * Cancels every open request of the listing which is being deleted.
 *
 * Each request is re-read with the room and the requesting account in one
 * transaction. A payment, activation or administrative demotion which races
 * with the deletion therefore cannot be overwritten by a stale cancellation.
 */
async function cancelOpenRoomRequestsForDeletion(
  operation: RoomDeletionOperation,
): Promise<number> {
  const roomRef = db.collection('rooms').doc(operation.roomId);
  let cancelledRequests = 0;
  let requestCursor: firestore.QueryDocumentSnapshot | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let requestQuery = db
      .collection('joinRequests')
      .where('roomId', '==', operation.roomId)
      .orderBy(firestore.FieldPath.documentId());
    if (requestCursor) requestQuery = requestQuery.startAfter(requestCursor);

    const requestPage = await requestQuery.limit(PAGE_SIZE).get();
    if (requestPage.empty) break;

    for (const requestDoc of requestPage.docs) {
      const requestRef = requestDoc.ref;
      const cancelled = await db.runTransaction(async (transaction) => {
        const [roomSnapshot, requestSnapshot] = await transaction.getAll(
          roomRef,
          requestRef,
        );
        if (!roomSnapshot.exists || !requestSnapshot.exists) return null;

        const room = roomSnapshot.data() as Record<string, any>;
        assertRoomDeletionCleanupAuthorization(roomSnapshot, operation);

        const request = requestSnapshot.data() as Record<string, any>;
        const status = String(request.status || '');
        const decision = decideRoomDeletion(room.currentOccupancy, [
          {
            status,
            advancePaid: request.advancePaid === true,
            platformCutTaken: request.platformCutTaken === true,
            advancePaymentStatus: String(request.advancePaymentStatus || ''),
          },
        ]);

        if (!decision.allowed) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'The booking changed while the listing was being deleted. Try again.',
          );
        }

        if (OPEN_ROOM_REQUEST_STATUSES.indexOf(status) < 0) return null;

        transaction.update(requestRef, {
          status: 'cancelled',
          cancelledAt: firestore.FieldValue.serverTimestamp(),
          cancelledBy: operation.requestedBy,
          cancellationReason: 'The room listing was deleted',
          deletionOperationId: operation.deletionOperationId,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        });

        return {
          studentId: String(request.studentId || ''),
          requestId: requestRef.id,
          roomId: String(request.roomId || operation.roomId),
        };
      });

      if (cancelled) {
        cancelledRequests += 1;

        // The request id stays in the notification payload. Without it the
        // app cannot route the notice to the cancelled booking.
        if (cancelled.studentId && cancelled.studentId !== operation.requestedBy) {
          await notify(
            cancelled.studentId,
            'Room listing removed',
            'The room listing you requested was removed. The request was cancelled.',
            'joinRequest',
            {
              requestId: cancelled.requestId,
              roomId: cancelled.roomId,
            },
          );
        }
      }
    }

    requestCursor = requestPage.docs[requestPage.docs.length - 1];
    if (requestPage.size < PAGE_SIZE) break;
  }

  return cancelledRequests;
}

/**
 * Deletes the marked listing and commits the durable photo/review cleanup.
 *
 * The public room, its private location and the superseded path-cleanup job
 * are removed in the same transaction as the prefix-cleanup job. The
 * tombstone deliberately survives until that prefix cleanup has completed.
 */
async function finalizeRoomDeletion(
  operation: RoomDeletionOperation,
  jobRef: firestore.DocumentReference,
): Promise<firestore.DocumentReference> {
  const roomRef = db.collection('rooms').doc(operation.roomId);
  const privateLocationRef = db
    .collection('roomPrivate')
    .doc(operation.roomId);
  const pathCleanupRef = db
    .collection('cleanupJobs')
    .doc(
      roomPhotoCleanupJobId(
        operation.ownerId,
        operation.roomId,
        operation.listingGeneration,
        'paths',
      ),
    );
  const prefixCleanupRef = db
    .collection('cleanupJobs')
    .doc(
      roomPhotoCleanupJobId(
        operation.ownerId,
        operation.roomId,
        operation.listingGeneration,
        'prefix',
      ),
    );

  await db.runTransaction(async (transaction) => {
    const roomSnapshot = await transaction.get(roomRef);
    if (!roomSnapshot.exists) return;

    const room = roomSnapshot.data() as Record<string, any>;
    assertRoomDeletionCleanupAuthorization(roomSnapshot, operation);

    const finalDecision = decideRoomDeletion(room.currentOccupancy, []);
    if (!finalDecision.allowed) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The room changed while the listing was being deleted. Try again.',
      );
    }

    transaction.delete(roomRef);
    // The exact address belongs to the listing. It must not survive as an
    // orphan after the public room document is removed.
    transaction.delete(privateLocationRef);
    // The prefix cleanup supersedes every individual path cleanup of this
    // listing generation.
    transaction.delete(pathCleanupRef);
    transaction.delete(jobRef);
    transaction.set(
      prefixCleanupRef,
      {
        type: 'roomPhotoPrefix',
        roomId: operation.roomId,
        ownerId: operation.ownerId,
        listingGeneration: operation.listingGeneration,
        storagePrefix: `rooms/${operation.ownerId}/${operation.roomId}/`,
        deletionOperationId: operation.deletionOperationId,
        // Reviews are part of the listing. They are removed by the same
        // durable cleanup job, but only reviews which belonged to this
        // immutable listing generation.
        deleteRoomReviews: true,
        reviewCutoff: firestore.FieldValue.serverTimestamp(),
        createdAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
        attempts: 0,
      },
      { merge: true },
    );
  });

  return prefixCleanupRef;
}

/** Executes or resumes one durable listing-deletion operation. */
async function executeRoomDeletionOperation(
  jobRef: firestore.DocumentReference,
  restoreOnFailure: boolean,
): Promise<{ cancelledRequests: number }> {
  const jobSnapshot = await jobRef.get();
  const operation = roomDeletionOperationFromSnapshot(jobSnapshot);
  const roomRef = db.collection('rooms').doc(operation.roomId);

  try {
    const roomSnapshot = await roomRef.get();
    if (!roomSnapshot.exists) {
      // The final transaction removes the deletion job together with the
      // listing. A missing room therefore means that this operation has
      // already completed.
      await jobRef.delete();
      return { cancelledRequests: 0 };
    }

    const room = roomSnapshot.data() as Record<string, any>;
    if (
      room.deletionInProgress !== true ||
      String(room.deletionOperationId || '') !== operation.deletionOperationId
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The listing deletion is no longer active. Try again.',
      );
    }

    const deletionDecision = await inspectRoomRequestsForDeletion(
      operation.roomId,
      Number(room.currentOccupancy || 0),
    );
    if (!deletionDecision.allowed) {
      const message =
        deletionDecision.reason === 'active-booking'
          ? 'This room has an active booking and cannot be deleted.'
          : deletionDecision.reason === 'payment-in-progress'
            ? 'This room has a payment waiting for verification and cannot be deleted.'
            : 'This room still has occupants and cannot be deleted.';
      throw new functions.https.HttpsError('failed-precondition', message);
    }

    const cancelledRequests = await cancelOpenRoomRequestsForDeletion(operation);
    const prefixCleanupRef = await finalizeRoomDeletion(operation, jobRef);

    // Start the Storage cleanup immediately. A failure does not undo the
    // successful room deletion: the durable cleanup job remains and the
    // scheduled worker retries it.
    try {
      await processRoomPhotoCleanupJob(prefixCleanupRef);
    } catch (error) {
      console.error(
        `Could not clean the photos of the deleted room ${operation.roomId}:`,
        error,
      );
    }

    return { cancelledRequests };
  } catch (error) {
    if (restoreOnFailure) {
      try {
        await restoreRoomDeletion(operation, jobRef);
      } catch (restoreError) {
        // The marker, job and tombstone are removed together. If that
        // transaction failed, all three remain and the scheduled worker can
        // resume the deletion safely.
        console.error(
          `Could not restore room ${operation.roomId} after a failed deletion:`,
          restoreError,
        );
      }
    }
    throw error;
  }
}

/** Whether an error will not be fixed by simply retrying the operation. */
function isPermanentRoomDeletionError(error: unknown): boolean {
  const code = String((error as { code?: string })?.code || '');
  return (
    code === 'failed-precondition' ||
    code === 'permission-denied' ||
    code === 'not-found' ||
    code === 'unauthenticated'
  );
}

/**
 * Resumes one interrupted listing deletion.
 *
 * A transient error leaves the durable job and room marker in place for the
 * next scheduled run. A permanent conflict restores the listing and removes
 * the marker so the owner is not left with a permanently inactive room.
 */
async function processRoomDeletionJob(
  jobRef: firestore.DocumentReference,
): Promise<void> {
  const snapshot = await jobRef.get();
  if (!snapshot.exists) return;
  const operation = roomDeletionOperationFromSnapshot(snapshot);

  try {
    await executeRoomDeletionOperation(jobRef, false);
  } catch (error) {
    if (!isPermanentRoomDeletionError(error)) {
      const attempts = Number(snapshot.get('attempts') || 0);
      const backoffMinutes = Math.min(24 * 60, 15 * Math.pow(2, attempts));
      try {
        await jobRef.set(
          {
            attempts: firestore.FieldValue.increment(1),
            lastError: String(error).slice(0, 300),
            nextAttemptAt: firestore.Timestamp.fromMillis(
              Date.now() + backoffMinutes * 60 * 1000,
            ),
            updatedAt: firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      } catch (updateError) {
        console.error(
          'Could not record the listing-deletion retry state:',
          updateError,
        );
      }
      throw error;
    }
    try {
      await restoreRoomDeletion(operation, jobRef);
    } catch (restoreError) {
      console.error(
        `Could not restore room ${operation.roomId} after a failed deletion:`,
        restoreError,
      );
      throw restoreError;
    }
    console.warn(
      `The listing deletion for ${operation.roomId} was stopped and the listing restored.`,
    );
  }
}

/**
 * Removes a listing on the server.
 *
 * An owner may delete their own empty listing; a live administrator may
 * delete any listing. The function never deletes an active tenancy or a
 * payment that is waiting for verification. Open requests are cancelled and
 * their students are notified before the room document is removed.
 *
 * The room is first marked as `inactive` with a deletion marker. The request
 * creation transaction reads that marker, so no new request can slip in
 * between the safety check and the deletion.
 */
export const deleteRoomListing = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }

    const uid = context.auth.uid;
    const roomId = String(data?.roomId || '').trim();
    if (!roomId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Missing room',
      );
    }

    await assertLiveOwnerOrAdmin(uid);
    const roomRef = db.collection('rooms').doc(roomId);
    const tombstoneRef = db
      .collection('roomDeletionTombstones')
      .doc(roomId);
    const deletionJobRef = db
      .collection('cleanupJobs')
      .doc(roomDeletionJobId(roomId));

    // Mark the listing as unavailable first. `createJoinRequest` checks this
    // marker in the same transaction in which it creates a request, so the
    // request set cannot grow while the deletion is being completed. The
    // durable job and the id-reservation tombstone are committed with the
    // marker, so a terminated function can always be resumed safely.
    const deletionOperationId = crypto.randomUUID();
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That room no longer exists',
        );
      }

      const room = snapshot.data() as Record<string, any>;
      const ownerId = String(room.ownerId || '').trim();

      // Recompute the caller's live authority inside the marker
      // transaction. The outside check is only a fast failure; this read is
      // what serializes a concurrent demotion with the deletion.
      const callerProfile = await transaction.get(
        db.collection('users').doc(uid),
      );
      assertRoomDeletionActorAuthority(callerProfile, uid, ownerId);

      const callerIsAdmin = canActAsAdmin({
        exists: callerProfile.exists,
        registrationCompleted: callerProfile.get('registrationCompleted'),
        isActive: callerProfile.get('isActive'),
        role: callerProfile.get('role'),
      });

      // The same caller may start a fresh operation, which receives its own
      // operation id and safely supersedes the older one. A live administrator
      // may also take over a stranded operation. Another owner may not.
      if (
        room.deletionInProgress === true &&
        String(room.deletionRequestedBy || '') !== uid &&
        !callerIsAdmin
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This listing is already being deleted.',
        );
      }

      const currentOccupancy = room.currentOccupancy;
      const occupancyDecision = decideRoomDeletion(currentOccupancy, []);
      if (!occupancyDecision.allowed) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          occupancyDecision.reason === 'has-occupants'
            ? 'This room still has occupants. End the active booking before deleting the listing.'
            : 'The room occupancy is invalid; repair it before deleting the listing.',
        );
      }

      const listingGeneration =
        String(room.listingGeneration || '').trim() || crypto.randomUUID();
      const previousStatus = String(room.status || 'available');

      transaction.update(roomRef, {
        status: 'inactive',
        listingGeneration,
        deletionInProgress: true,
        deletionRequestedBy: uid,
        deletionOperationId,
        deletionRequestedAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(
        tombstoneRef,
        {
          type: 'roomDeletionTombstone',
          roomId,
          ownerId,
          listingGeneration,
          deletionOperationId,
          createdAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(
        deletionJobRef,
        {
          type: 'roomDeletion',
          roomId,
          ownerId,
          listingGeneration,
          deletionOperationId,
          deletionRequestedBy: uid,
          previousStatus,
          createdAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
          attempts: 0,
        },
        { merge: true },
      );
    });

    const result = await executeRoomDeletionOperation(
      deletionJobRef,
      true,
    );

    return {
      success: true,
      roomId,
      cancelledRequests: result.cancelledRequests,
    };
  },
);

/**
 * Normalizes a freshly created listing.
 *
 * `status` and `currentOccupancy` are server-owned fields: from the moment
 * the listing exists they may only be changed by `setRoomListingAvailability`
 * / `adminSetRoomListingStatus` (including an explicit availability release)
 * and by the booking state machine.
 *
 * The trigger exists because the student search compares the listing status
 * with an **equality** (`status == available`). A Firestore equality query
 * never matches a document that does not have the field, so a listing that
 * was written without a status would be invisible to every student — even
 * though it is a perfectly valid, available listing.
 *
 * The trigger therefore writes the two defaults when (and only when) they
 * are missing. It never overwrites a value the client was allowed to state
 * and it never touches a listing that already carries both fields.
 */
export const onRoomCreated = functions.firestore
  .document('rooms/{roomId}')
  .onCreate(async (snapshot) => {
    try {
      let initializedFields: string[] = [];

      // The create trigger races with an immediate listing deletion. A plain
      // merge on the stale event snapshot could recreate a room which the
      // deletion already removed, or overwrite the generation written by the
      // deletion transaction. The current document is therefore read and
      // patched in one transaction.
      await db.runTransaction(async (transaction) => {
        initializedFields = [];
        const current = await transaction.get(snapshot.ref);
        if (!current.exists) return;

        const data = current.data() as Record<string, any>;
        const patch: Record<string, unknown> = {};

        if (data.status === undefined || data.status === null) {
          patch.status = 'available';
        }
        if (
          data.currentOccupancy === undefined ||
          data.currentOccupancy === null
        ) {
          patch.currentOccupancy = 0;
        }
        if (!String(data.listingGeneration || '').trim()) {
          // The generation identifies this exact lifetime of a room id. It is
          // assigned by the server and may never be changed by the client.
          patch.listingGeneration = crypto.randomUUID();
        }

        if (Object.keys(patch).length === 0) return;
        transaction.update(snapshot.ref, patch);
        initializedFields = Object.keys(patch);
      });

      if (initializedFields.length > 0) {
        console.log(
          `Room ${snapshot.id}: initialized ${initializedFields.join(', ')}`,
        );
      }
    } catch (error) {
      console.error(`Error initializing room ${snapshot.id}:`, error);
      throw error;
    }
  });

/**
 * Removes Storage photos which an owner deleted from a room listing.
 *
 * The room document is the authoritative image list. Whenever that list
 * changes, the removed download URLs are converted back into their Storage
 * object paths and written to a durable cleanup job. The client does not
 * have to delete the files, and a Storage outage is retried by the
 * scheduled worker instead of leaving an orphan forever.
 */
export const onRoomUpdated = functions.firestore
  .document('rooms/{roomId}')
  .onUpdate(async (change) => {
    const before = change.before.data() as Record<string, any> | undefined;
    const after = change.after.data() as Record<string, any> | undefined;
    if (!before || !after) return;

    const roomId = change.after.id;
    const ownerId = String(after.ownerId || before.ownerId || '').trim();
    const listingGeneration = roomListingGeneration({
      ...before,
      ...after,
      roomId,
      ownerId,
    });
    const expectedPrefix = `rooms/${ownerId}/${roomId}/`;
    if (!ownerId) return;

    const beforeImages = stringList(before.images);
    const afterImages = new Set(stringList(after.images));
    const removedUrls = beforeImages.filter((url) => !afterImages.has(url));
    if (removedUrls.length === 0) return;

    const removedPaths: string[] = [];
    for (const url of removedUrls) {
      const path = storageObjectPathFromDownloadUrl(url);
      if (!path || !path.startsWith(expectedPrefix)) {
        console.warn(
          `Could not derive the Storage path of a removed photo in room ${roomId}.`,
        );
        continue;
      }
      if (!removedPaths.includes(path)) removedPaths.push(path);
    }
    if (removedPaths.length === 0) return;

    const cleanupJobRef = db
      .collection('cleanupJobs')
      .doc(
        roomPhotoCleanupJobId(
          ownerId,
          roomId,
          listingGeneration,
          'paths',
        ),
      );

    // The paths are merged in a transaction. Two owners editing the same
    // room on two devices cannot overwrite each other's pending cleanup.
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(cleanupJobRef);
      const existing = snapshot.exists
        ? stringList(snapshot.get('paths'))
        : [];
      const paths = [...existing];
      for (const path of removedPaths) {
        if (!paths.includes(path)) paths.push(path);
      }
      transaction.set(
        cleanupJobRef,
        {
          type: 'roomPhotoPaths',
          roomId,
          ownerId,
          listingGeneration,
          paths,
          createdAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
          attempts: 0,
        },
        { merge: true },
      );
    });
  });

/**
 * Changes the listing status of any room as a live administrator.
 *
 * Marking a room available is an explicit release operation: active
 * bookings are ended and `currentOccupancy` is cleared in the same
 * transaction. The other status values change only the listing-status field.
 */
export const adminSetRoomListingStatus = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }

    const adminUid = context.auth.uid;
    const roomId = String(data?.roomId || '').trim();
    const status = String(data?.status || '').trim();
    if (!roomId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Missing room',
      );
    }
    if (status !== 'available' && status !== 'occupied' && status !== 'inactive') {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Invalid room status',
      );
    }

    await assertLiveAdmin(context.auth.uid);

    const roomRef = db.collection('rooms').doc(roomId);
    const outcome = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That room no longer exists',
        );
      }

      const room = snapshot.data() as Record<string, any>;

      // The live admin role is checked in the same transaction as the
      // listing-status write.
      const adminProfile = await transaction.get(
        db.collection('users').doc(adminUid),
      );
      if (
        !canActAsAdmin({
          exists: adminProfile.exists,
          registrationCompleted: adminProfile.get('registrationCompleted'),
          isActive: adminProfile.get('isActive'),
          role: adminProfile.get('role'),
        })
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Admin access required',
        );
      }

      if (room.deletionInProgress === true) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This listing is being deleted and its status cannot be changed',
        );
      }
      const currentOccupancy = room.currentOccupancy;
      if (!isValidCurrentOccupancy(currentOccupancy)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This room has an invalid occupancy',
        );
      }

      if (status === 'available') {
        const release = await releaseActiveBookingsForAvailableRoom(
          transaction,
          roomRef,
          snapshot,
          { uid: adminUid, role: 'admin' },
        );
        return { release };
      }

      transaction.update(roomRef, {
        status,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
      return { release: null };
    });

    if (outcome.release) {
      await Promise.all(
        outcome.release.bookings.map((booking) =>
          notify(
            booking.studentId,
            'Room booking ended',
            'An administrator marked this listing available. You have been ' +
              'removed from the room immediately. Payment and invoice history ' +
              'is kept unchanged.',
            'joinRequest',
            { requestId: booking.requestId, roomId },
          ),
        ),
      );
    }

    return {
      success: true,
      status,
      releasedRequests: outcome.release?.releasedRequests || 0,
      releasedStudents: outcome.release?.releasedStudents || 0,
    };
  },
);
