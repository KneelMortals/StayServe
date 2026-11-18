import * as crypto from 'crypto';
import * as firestore from 'firebase-admin/firestore';
import * as functions from 'firebase-functions/v1';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  assertLiveAdmin,
  assertLiveOwner,
  canActAsAdmin,
} from './accounts';
import { callableHttps } from './appCheck';
import {
  ExactRoomLocation,
  configuredRoomLocationStage,
  coarsePublicRoomLocation,
  coarseRoomCoordinate,
  exactRoomLocationsMatch,
  hasCompleteExactRoomLocation,
  normalizeExactRoomLocation,
  publicRoomHasExactLocation,
  readExactPublicRoomLocation,
  roomCoordinate,
  roomGeoCell,
} from './roomLocation';

const db = firestore.getFirestore();

/** Server-owned controls for the room-location privacy migration. */
export interface RoomLocationPrivacyConfig {
  allowClientExactLocationWrites: boolean;
  finalized: boolean;
  finalizedAtMillis: number | null;
}

const locationPrivacyConfigRef = db
  .collection('system')
  .doc('locationPrivacy');

/**
 * Checks the live administrator profile inside a protected transaction.
 *
 * The caller id is optional because the same migration helpers are used by
 * the operator CLI, which authenticates with the Admin SDK instead of a
 * user session. A callable always supplies it, so its role is checked in the
 * same transaction as every write.
 */
function assertAdminInTransaction(
  snapshot: firestore.DocumentSnapshot | null,
  authorizationUid: string,
): void {
  if (!authorizationUid) return;
  if (
    !snapshot ||
    !canActAsAdmin({
      exists: snapshot.exists,
      registrationCompleted: snapshot.get('registrationCompleted'),
      isActive: snapshot.get('isActive'),
      role: snapshot.get('role'),
    })
  ) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Admin access required',
    );
  }
}

/** Rechecks a read-only administrative operation against the live profile. */
async function assertAdminStillAuthorized(authorizationUid: string): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(
      db.collection('users').doc(authorizationUid),
    );
    assertAdminInTransaction(snapshot, authorizationUid);
  });
}

/** Parses the server-owned location-privacy controls from one snapshot. */
export function readRoomLocationPrivacyConfigFromData(
  value: Record<string, any> | undefined,
): RoomLocationPrivacyConfig {
  const data = value || {};
  return {
    allowClientExactLocationWrites:
      data.allowClientExactLocationWrites === true,
    finalized: data.finalized === true,
    finalizedAtMillis: timestampMillis(data.finalizedAt),
  };
}

/** Reads the server-owned location-privacy controls. */
export async function readRoomLocationPrivacyConfig(): Promise<RoomLocationPrivacyConfig> {
  const snapshot = await locationPrivacyConfigRef.get();
  return readRoomLocationPrivacyConfigFromData(
    snapshot.data() as Record<string, any> | undefined,
  );
}

/**
 * The effective write stage.
 *
 * The durable `finalized` latch is deliberately stronger than the process
 * environment. Once finalization has started, every location write keeps the
 * exact values private even if an old Functions deployment is still running
 * with `ROOM_LOCATION_STAGE=dual`.
 */
function effectiveRoomLocationStage(
  config: RoomLocationPrivacyConfig,
): ReturnType<typeof configuredRoomLocationStage> {
  return config.finalized ? 'private' : configuredRoomLocationStage();
}

/** The exact fields stored in `roomPrivate/{roomId}`. */
export interface PrivateRoomLocation extends ExactRoomLocation {
  roomId: string;
  ownerId: string;
  locationRevision: string;
  updatedAtMillis: number | null;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

function timestampMillis(value: unknown): number | null {
  if (value instanceof firestore.Timestamp) return value.toMillis();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/**
 * Validates the exact location supplied by the owner.
 *
 * The owner id is never taken from the client. The server reads it from the
 * live room document and stores it in the private document itself.
 */
function readOwnerLocationInput(
  data: Record<string, any>,
): ExactRoomLocation {
  const location = normalizeExactRoomLocation(data);

  if (!location.address || !location.city || !location.state || !location.pincode) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The address, city, state and pincode are required',
    );
  }

  if (
    (location.latitude === null) !== (location.longitude === null) ||
    (location.latitude !== null &&
      (location.latitude < -90 ||
        location.latitude > 90 ||
        location.longitude! < -180 ||
        location.longitude! > 180))
  ) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'The room coordinates are invalid',
    );
  }

  return location;
}

/** Parses a private-location document from one snapshot. */
export function readPrivateRoomLocationFromData(
  value: Record<string, any> | undefined,
): PrivateRoomLocation | null {
  if (!value) return null;

  const latitude = roomCoordinate(value.latitude);
  const longitude = roomCoordinate(value.longitude);

  return {
    roomId: cleanText(value.roomId, 160),
    ownerId: cleanText(value.ownerId, 160),
    address: cleanText(value.address, 512),
    city: cleanText(value.city, 128),
    state: cleanText(value.state, 128),
    pincode: cleanText(value.pincode, 32),
    latitude,
    longitude,
    locationRevision: cleanText(value.locationRevision, 160),
    updatedAtMillis: timestampMillis(value.updatedAt),
  };
}

/** Reads the private location document of a room. */
export async function readPrivateRoomLocation(
  roomId: string,
): Promise<PrivateRoomLocation | null> {
  const snapshot = await db.collection('roomPrivate').doc(roomId).get();
  if (!snapshot.exists) return null;

  return readPrivateRoomLocationFromData(
    snapshot.data() as Record<string, any> | undefined,
  );
}

/**
 * The public-location patch for one exact location.
 *
 * In `dual` mode the legacy public fields are kept in sync for old clients.
 * In `private` mode only city/state and the rounded geocell survive in the
 * public document.
 */
function publicLocationPatch(
  location: ExactRoomLocation,
  stage: ReturnType<typeof configuredRoomLocationStage>,
  locationRevision: string,
): Record<string, unknown> {
  const coarseLatitude = coarseRoomCoordinate(location.latitude);
  const coarseLongitude = coarseRoomCoordinate(location.longitude);
  const geoCell = roomGeoCell(location);

  if (stage === 'dual') {
    return {
      location: {
        address: location.address,
        city: location.city,
        state: location.state,
        pincode: location.pincode,
        latitude: location.latitude,
        longitude: location.longitude,
      },
      latitude: location.latitude,
      longitude: location.longitude,
      geoCell,
      locationRevision,
      locationPrivacyVersion: 'dual-v1',
    };
  }

  return {
    location: coarsePublicRoomLocation(location),
    latitude: firestore.FieldValue.delete(),
    longitude: firestore.FieldValue.delete(),
    address: firestore.FieldValue.delete(),
    pincode: firestore.FieldValue.delete(),
    geoCell: geoCell || firestore.FieldValue.delete(),
    locationRevision,
    locationPrivacyVersion: 'private-v1',
  };
}

/**
 * Stores the exact location of a room in the private collection.
 *
 * The caller must be a live owner of the room. The private document id is
 * always the room id, so one listing can never have two private copies.
 * The private write and the public dual-write happen in one Firestore
 * transaction, so a migrated listing can never expose one address while the
 * server serves another.
 */
export const setRoomPrivateLocation = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }

    const uid = context.auth.uid;
    await assertLiveOwner(uid);

    const roomId = String(data?.roomId || '').trim();
    if (!roomId || roomId.length > 160) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid room');
    }

    const location = readOwnerLocationInput(
      (data || {}) as Record<string, any>,
    );
    const roomRef = db.collection('rooms').doc(roomId);
    const privateRef = db.collection('roomPrivate').doc(roomId);
    const userRef = db.collection('users').doc(uid);
    let stage = configuredRoomLocationStage();
    const locationRevision = crypto.randomUUID();

    await db.runTransaction(async (transaction) => {
      const [
        roomSnapshot,
        privateSnapshot,
        userSnapshot,
        privacyConfigSnapshot,
      ] = await Promise.all([
        transaction.get(roomRef),
        transaction.get(privateRef),
        transaction.get(userRef),
        transaction.get(locationPrivacyConfigRef),
      ]);

      if (!roomSnapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That room no longer exists',
        );
      }

      const room = roomSnapshot.data() as Record<string, any>;
      const privacyConfigValue =
        (privacyConfigSnapshot.data() || {}) as Record<string, any>;
      const privacyConfig: RoomLocationPrivacyConfig = {
        allowClientExactLocationWrites:
          privacyConfigValue.allowClientExactLocationWrites === true,
        finalized: privacyConfigValue.finalized === true,
        finalizedAtMillis: timestampMillis(privacyConfigValue.finalizedAt),
      };
      stage = effectiveRoomLocationStage(privacyConfig);
      const liveUser = userSnapshot.data() as Record<string, any> | undefined;
      if (
        !userSnapshot.exists ||
        !liveUser ||
        liveUser.role !== 'owner' ||
        liveUser.registrationCompleted !== true ||
        liveUser.isActive !== true
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Owner access required',
        );
      }

      if (room.deletionInProgress === true) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This listing is being deleted and its location cannot be changed',
        );
      }

      const ownerId = String(room.ownerId || '').trim();
      if (!ownerId || ownerId !== uid) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'You can only change the location of your own listing',
        );
      }

      const existing = privateSnapshot.data() as
        | Record<string, any>
        | undefined;
      const now = firestore.Timestamp.now();

      // The transaction already reads the server-owned privacy config. If
      // finalization changes that document, Firestore retries this
      // transaction and the retry observes `finalized=true`; the exact value
      // can never be written back into the public room after the scrub.
      transaction.set(
        privateRef,
        {
          roomId,
          ownerId: uid,
          ...location,
          locationRevision,
          source: 'owner',
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        },
        { merge: true },
      );

      transaction.update(roomRef, {
        ...publicLocationPatch(location, stage, locationRevision),
        locationUpdatedAt: now,
      });
    });

    return {
      success: true,
      roomId,
      stage,
      locationRevision,
      updatedAtMillis: Date.now(),
    };
  },
);

/** One page of the room-location migration. */
export interface RoomLocationMigrationPage {
  scanned: number;
  created: number;
  candidates: number;
  preserved: number;
  repaired: number;
  repairedPrivateMetadata: number;
  invalidLegacyLocation: number;
  invalidPrivatePreserved: number;
  invalidOwner: number;
  repairedPublicRoomId: number;
  missingRoom: number;
  dryRun: boolean;
  hasMore: boolean;
  nextCursor: string | null;
}

/** The maximum number of rooms handled by one migration/verification page. */
const MAX_LOCATION_PAGE_SIZE = 200;

function pageSize(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 100;
  return Math.min(MAX_LOCATION_PAGE_SIZE, Math.floor(parsed));
}

function pageCursor(value: unknown): string {
  return String(value || '').trim().slice(0, 512);
}

async function roomPage(
  cursor: string,
  limit: number,
): Promise<{
  docs: firestore.QueryDocumentSnapshot[];
  hasMore: boolean;
}> {
  let query = db
    .collection('rooms')
    .orderBy(firestore.FieldPath.documentId());
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.limit(limit + 1).get();
  const docs = snapshot.docs.slice(0, limit);
  return {
    docs,
    hasMore: snapshot.size > limit,
  };
}

/**
 * Copies the legacy public location of every room into `roomPrivate`.
 *
 * The operation is idempotent: a complete owner-owned private document is
 * never overwritten. An invalid document created by an older migration can
 * only be repaired by filling fields which are still missing, so a newer
 * owner value is never replaced by an older public value.
 */
export async function migrateRoomPrivateLocationsPage(options: {
  cursor?: string;
  limit?: number;
  dryRun?: boolean;
  /** The live administrator when the page is run by a callable. */
  authorizationUid?: string;
}): Promise<RoomLocationMigrationPage> {
  const cursor = pageCursor(options.cursor);
  const limit = pageSize(options.limit);
  const dryRun = options.dryRun === true;
  const authorizationUid = String(options.authorizationUid || '').trim();
  const { docs, hasMore } = await roomPage(cursor, limit);

  let created = 0;
  let candidates = 0;
  let preserved = 0;
  let repaired = 0;
  let repairedPrivateMetadata = 0;
  let invalidLegacyLocation = 0;
  let invalidPrivatePreserved = 0;
  let invalidOwner = 0;
  let repairedPublicRoomId = 0;
  let missingRoom = 0;

  for (const roomDoc of docs) {
    const privateRef = db.collection('roomPrivate').doc(roomDoc.id);

    const outcome = await db.runTransaction(async (transaction) => {
      const adminRef = authorizationUid
        ? db.collection('users').doc(authorizationUid)
        : null;
      const [roomSnapshot, privateSnapshot, adminSnapshot] = await Promise.all([
        transaction.get(roomDoc.ref),
        transaction.get(privateRef),
        adminRef ? transaction.get(adminRef) : null,
      ]);

      assertAdminInTransaction(adminSnapshot, authorizationUid);

      if (!roomSnapshot.exists) {
        return { location: 'missingRoom' as const, repairedRoomId: false };
      }

      const room = roomSnapshot.data() as Record<string, any>;
      const ownerId = String(room.ownerId || '').trim();
      const publicRoomId = cleanText(room.roomId, 160);
      const repairedRoomId = publicRoomId !== roomDoc.id;

      if (!dryRun && repairedRoomId) {
        // The Firestore document id is canonical. Repairing this legacy
        // field prevents an owner or student action from targeting the wrong
        // listing while the location migration is running.
        transaction.update(roomDoc.ref, { roomId: roomDoc.id });
      }

      if (!ownerId) {
        return { location: 'invalidOwner' as const, repairedRoomId };
      }

      const publicLocation = readExactPublicRoomLocation(room);
      const publicLocationIsComplete =
        hasCompleteExactRoomLocation(publicLocation);

      if (!privateSnapshot.exists) {
        if (!publicLocationIsComplete) {
          return {
            location: 'invalidLegacyLocation' as const,
            repairedRoomId,
          };
        }

        if (!dryRun) {
          const now = firestore.Timestamp.now();
          transaction.set(privateRef, {
            roomId: roomDoc.id,
            ownerId,
            ...publicLocation,
            locationRevision: 'migration-v1',
            source: 'migration',
            createdAt: now,
            updatedAt: now,
          });
        }
        return {
          location: dryRun ? ('candidate' as const) : ('created' as const),
          repairedRoomId,
        };
      }

      const privateValue = privateSnapshot.data() as Record<string, any>;
      const privateLocation = normalizeExactRoomLocation(privateValue);
      const privateRoomId = cleanText(privateValue.roomId, 160);
      const privateOwnerId = cleanText(privateValue.ownerId, 160);
      const privateMetadataNeedsRepair =
        privateRoomId !== roomDoc.id || privateOwnerId !== ownerId;

      if (hasCompleteExactRoomLocation(privateLocation)) {
        if (privateMetadataNeedsRepair && !dryRun) {
          // The document path is the canonical private-location identity. Its
          // owner also comes from the live public listing. Repair only these
          // metadata fields; every exact value written by the owner remains
          // untouched.
          transaction.update(privateRef, {
            roomId: roomDoc.id,
            ownerId,
            updatedAt: firestore.Timestamp.now(),
          });
        }
        return {
          location: privateMetadataNeedsRepair
            ? ('repairedMetadata' as const)
            : ('preserved' as const),
          repairedRoomId,
        };
      }

      const privateSource = cleanText(privateValue.source, 64);
      const canRepair =
        (privateSource === 'migration' ||
          privateSource === 'migration-repair') &&
        publicLocationIsComplete;

      if (canRepair) {
        // Fill only missing values. Existing private values win, which keeps
        // a newer owner edit safe even if the public copy is stale.
        const privateCoordinatePairIsComplete =
          privateLocation.latitude !== null &&
          privateLocation.longitude !== null &&
          privateLocation.latitude >= -90 &&
          privateLocation.latitude <= 90 &&
          privateLocation.longitude >= -180 &&
          privateLocation.longitude <= 180;
        const publicCoordinatePairIsComplete =
          publicLocation.latitude !== null &&
          publicLocation.longitude !== null &&
          publicLocation.latitude >= -90 &&
          publicLocation.latitude <= 90 &&
          publicLocation.longitude >= -180 &&
          publicLocation.longitude <= 180;
        const repairedLocation: ExactRoomLocation = {
          address: privateLocation.address || publicLocation.address,
          city: privateLocation.city || publicLocation.city,
          state: privateLocation.state || publicLocation.state,
          pincode: privateLocation.pincode || publicLocation.pincode,
          latitude: privateCoordinatePairIsComplete
            ? privateLocation.latitude
            : publicCoordinatePairIsComplete
              ? publicLocation.latitude
              : null,
          longitude: privateCoordinatePairIsComplete
            ? privateLocation.longitude
            : publicCoordinatePairIsComplete
              ? publicLocation.longitude
              : null,
        };

        if (hasCompleteExactRoomLocation(repairedLocation)) {
          if (!dryRun) {
            const now = firestore.Timestamp.now();
            transaction.set(
              privateRef,
              {
                roomId: roomDoc.id,
                ownerId,
                ...repairedLocation,
                locationRevision: 'migration-v2',
                source: 'migration-repair',
                createdAt: privateValue.createdAt || now,
                updatedAt: now,
              },
              { merge: true },
            );
          }
          return { location: 'repaired' as const, repairedRoomId };
        }
      }

      return {
        location: 'invalidPrivatePreserved' as const,
        repairedRoomId,
      };
    });

    if (outcome.location === 'created') created += 1;
    else if (outcome.location === 'candidate') candidates += 1;
    else if (outcome.location === 'preserved') preserved += 1;
    else if (outcome.location === 'repaired') repaired += 1;
    else if (outcome.location === 'repairedMetadata') {
      repairedPrivateMetadata += 1;
    } else if (outcome.location === 'invalidLegacyLocation') {
      invalidLegacyLocation += 1;
    } else if (outcome.location === 'invalidPrivatePreserved') {
      invalidPrivatePreserved += 1;
    } else if (outcome.location === 'invalidOwner') invalidOwner += 1;
    else if (outcome.location === 'missingRoom') missingRoom += 1;
    if (outcome.repairedRoomId) repairedPublicRoomId += 1;
  }

  return {
    scanned: docs.length,
    created,
    candidates,
    preserved,
    repaired,
    repairedPrivateMetadata,
    invalidLegacyLocation,
    invalidPrivatePreserved,
    invalidOwner,
    repairedPublicRoomId,
    missingRoom,
    dryRun,
    hasMore,
    nextCursor: docs.length > 0 ? docs[docs.length - 1].id : cursor || null,
  };
}

/** The result of verifying room locations. */
export interface RoomLocationAudit {
  scanned: number;
  verified: number;
  missingPrivate: number;
  ownerMismatch: number;
  invalidRoomId: number;
  invalidPublicRoomId: number;
  invalidPrivate: number;
  publicMismatch: number;
  publicExactRemaining: number;
  readyToFinalize: boolean;
  samples: {
    missingPrivate: string[];
    ownerMismatch: string[];
    invalidRoomId: string[];
    invalidPublicRoomId: string[];
    invalidPrivate: string[];
    publicMismatch: string[];
    publicExactRemaining: string[];
  };
}

/** The result of verifying one page of room locations. */
export interface RoomLocationVerificationPage extends RoomLocationAudit {
  hasMore: boolean;
  nextCursor: string | null;
}

function emptyRoomLocationAudit(): RoomLocationAudit {
  return {
    scanned: 0,
    verified: 0,
    missingPrivate: 0,
    ownerMismatch: 0,
    invalidRoomId: 0,
    invalidPublicRoomId: 0,
    invalidPrivate: 0,
    publicMismatch: 0,
    publicExactRemaining: 0,
    readyToFinalize: true,
    samples: {
      missingPrivate: [],
      ownerMismatch: [],
      invalidRoomId: [],
      invalidPublicRoomId: [],
      invalidPrivate: [],
      publicMismatch: [],
      publicExactRemaining: [],
    },
  };
}

function addAuditSample(list: string[], roomId: string): void {
  if (list.length < 20) list.push(roomId);
}

function mergeRoomLocationAudit(
  target: RoomLocationAudit,
  source: RoomLocationAudit,
): void {
  target.scanned += source.scanned;
  target.verified += source.verified;
  target.missingPrivate += source.missingPrivate;
  target.ownerMismatch += source.ownerMismatch;
  target.invalidRoomId += source.invalidRoomId;
  target.invalidPublicRoomId += source.invalidPublicRoomId;
  target.invalidPrivate += source.invalidPrivate;
  target.publicMismatch += source.publicMismatch;
  target.publicExactRemaining += source.publicExactRemaining;

  for (const key of Object.keys(target.samples) as Array<
    keyof RoomLocationAudit['samples']
  >) {
    for (const roomId of source.samples[key]) {
      addAuditSample(target.samples[key], roomId);
    }
  }

  target.readyToFinalize =
    target.missingPrivate === 0 &&
    target.ownerMismatch === 0 &&
    target.invalidRoomId === 0 &&
    target.invalidPublicRoomId === 0 &&
    target.invalidPrivate === 0 &&
    target.publicMismatch === 0;
}

/**
 * Verifies one batch of public rooms against their private counterparts.
 *
 * The response contains room ids and counters, never the exact addresses.
 */
async function auditRoomLocationBatch(
  roomDocs: firestore.QueryDocumentSnapshot[],
): Promise<RoomLocationAudit> {
  const audit = emptyRoomLocationAudit();
  if (roomDocs.length === 0) return audit;

  const privateRefs = roomDocs.map((roomDoc) =>
    db.collection('roomPrivate').doc(roomDoc.id),
  );
  const privateSnapshots = await db.getAll(...privateRefs);
  const privateByRoomId = new Map<string, firestore.DocumentSnapshot>();
  privateSnapshots.forEach((snapshot) => {
    privateByRoomId.set(snapshot.id, snapshot);
  });

  for (const roomDoc of roomDocs) {
    audit.scanned += 1;
    const room = roomDoc.data() as Record<string, any>;
    const roomOwnerId = String(room.ownerId || '').trim();
    const publicRoomId = cleanText(room.roomId, 160);
    if (publicRoomId !== roomDoc.id) {
      audit.invalidPublicRoomId += 1;
      addAuditSample(audit.samples.invalidPublicRoomId, roomDoc.id);
      continue;
    }

    const privateSnapshot = privateByRoomId.get(roomDoc.id);

    if (!privateSnapshot || !privateSnapshot.exists) {
      audit.missingPrivate += 1;
      addAuditSample(audit.samples.missingPrivate, roomDoc.id);
      continue;
    }

    const privateValue = privateSnapshot.data() as Record<string, any>;
    const privateRoomId = cleanText(privateValue.roomId, 160);
    if (privateRoomId !== roomDoc.id) {
      audit.invalidRoomId += 1;
      addAuditSample(audit.samples.invalidRoomId, roomDoc.id);
      continue;
    }

    const privateOwnerId = cleanText(privateValue.ownerId, 160);
    if (!roomOwnerId || privateOwnerId !== roomOwnerId) {
      audit.ownerMismatch += 1;
      addAuditSample(audit.samples.ownerMismatch, roomDoc.id);
      continue;
    }

    const privateLocation = normalizeExactRoomLocation(privateValue);
    if (!hasCompleteExactRoomLocation(privateLocation)) {
      audit.invalidPrivate += 1;
      addAuditSample(audit.samples.invalidPrivate, roomDoc.id);
      continue;
    }

    if (publicRoomHasExactLocation(room)) {
      audit.publicExactRemaining += 1;
      addAuditSample(audit.samples.publicExactRemaining, roomDoc.id);

      const publicLocation = readExactPublicRoomLocation(room);
      if (!exactRoomLocationsMatch(publicLocation, privateLocation)) {
        audit.publicMismatch += 1;
        addAuditSample(audit.samples.publicMismatch, roomDoc.id);
        continue;
      }
    }

    audit.verified += 1;
  }

  audit.readyToFinalize =
    audit.missingPrivate === 0 &&
    audit.ownerMismatch === 0 &&
    audit.invalidRoomId === 0 &&
    audit.invalidPublicRoomId === 0 &&
    audit.invalidPrivate === 0 &&
    audit.publicMismatch === 0;
  return audit;
}

/**
 * Verifies that every room has one matching private counterpart.
 *
 * The response contains room ids and counters, never the exact addresses.
 */
export async function verifyRoomPrivateLocationsPage(options: {
  cursor?: string;
  limit?: number;
}): Promise<RoomLocationVerificationPage> {
  const cursor = pageCursor(options.cursor);
  const limit = pageSize(options.limit);
  const { docs, hasMore } = await roomPage(cursor, limit);
  const audit = await auditRoomLocationBatch(docs);

  return {
    ...audit,
    hasMore,
    nextCursor: docs.length > 0 ? docs[docs.length - 1].id : cursor || null,
  };
}

/**
 * Verifies every room in the database.
 *
 * The final public-field scrub calls this audit before it removes even one
 * exact field. A page-local success is therefore never mistaken for a
 * database-wide guarantee.
 */
export async function verifyAllRoomPrivateLocations(): Promise<RoomLocationAudit> {
  const total = emptyRoomLocationAudit();
  let cursor: firestore.QueryDocumentSnapshot | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = db
      .collection('rooms')
      .orderBy(firestore.FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.limit(MAX_LOCATION_PAGE_SIZE).get();
    if (snapshot.empty) break;

    mergeRoomLocationAudit(total, await auditRoomLocationBatch(snapshot.docs));
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < MAX_LOCATION_PAGE_SIZE) break;
  }

  return total;
}

/** Whether the public document already has the target coarse location. */
function publicCoarseLocationMatches(
  room: Record<string, any>,
  location: ExactRoomLocation,
): boolean {
  const current = readExactPublicRoomLocation(room);
  const target = coarsePublicRoomLocation(location);
  if (current.city !== target.city || current.state !== target.state) {
    return false;
  }

  const expectedGeoCell = roomGeoCell(location);
  const currentGeoCell =
    typeof room.geoCell === 'string' ? room.geoCell.trim() : '';
  if (expectedGeoCell === null) return currentGeoCell.length === 0;
  return currentGeoCell === expectedGeoCell;
}

/** The result of one final public-location scrub page. */
export interface RoomLocationFinalizationPage {
  scanned: number;
  finalized: number;
  wouldFinalize: number;
  alreadyPrivate: number;
  skipped: number;
  dryRun: boolean;
  preflight: RoomLocationAudit;
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * Removes the exact public fields after every room has a verified private
 * counterpart.
 *
 * The function is intentionally refused while the server is still in the
 * `dual` stage: the next owner edit would otherwise put the exact address
 * back into the public document.
 */
export async function finalizeRoomLocationPrivacyPage(options: {
  cursor?: string;
  limit?: number;
  dryRun?: boolean;
  /** The live administrator when the page is run by a callable. */
  authorizationUid?: string;
}): Promise<RoomLocationFinalizationPage> {
  if (configuredRoomLocationStage() !== 'private') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Set ROOM_LOCATION_STAGE=private and deploy the functions before the final public-location pass',
    );
  }

  const cursor = pageCursor(options.cursor);
  const limit = pageSize(options.limit);
  const dryRun = options.dryRun === true;
  const authorizationUid = String(options.authorizationUid || '').trim();

  // This is the safety boundary of the migration. No exact public field is
  // removed until a **database-wide** audit proves that every room has a
  // complete private counterpart and that every still-public exact value
  // matches it. A successful page-local verification is not sufficient.
  const preflight = await verifyAllRoomPrivateLocations();
  if (!preflight.readyToFinalize) {
    const issueCounts = {
      missingPrivate: preflight.missingPrivate,
      ownerMismatch: preflight.ownerMismatch,
      invalidRoomId: preflight.invalidRoomId,
      invalidPublicRoomId: preflight.invalidPublicRoomId,
      invalidPrivate: preflight.invalidPrivate,
      publicMismatch: preflight.publicMismatch,
    };
    throw new functions.https.HttpsError(
      'failed-precondition',
      `The private-location migration is not ready for finalization: ${JSON.stringify(
        issueCounts,
      )}`,
    );
  }

  // The old-client compatibility window must be closed before the first
  // exact field is removed. Applying the pass also sets a durable
  // `finalized` latch. Every later owner write observes that latch and keeps
  // the exact location private, even if a stale Functions deployment still
  // has ROOM_LOCATION_STAGE=dual.
  await db.runTransaction(async (transaction) => {
    const adminRef = authorizationUid
      ? db.collection('users').doc(authorizationUid)
      : null;
    const [snapshot, adminSnapshot] = await Promise.all([
      transaction.get(locationPrivacyConfigRef),
      adminRef ? transaction.get(adminRef) : null,
    ]);
    assertAdminInTransaction(adminSnapshot, authorizationUid);
    const value = (snapshot.data() || {}) as Record<string, any>;
    const alreadyFinalized = value.finalized === true;

    if (!alreadyFinalized && value.allowClientExactLocationWrites === true) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Close the legacy exact-location client-write switch before finalizing',
      );
    }

    if (dryRun) return;

    const now = firestore.Timestamp.now();
    transaction.set(
      locationPrivacyConfigRef,
      {
        allowClientExactLocationWrites: false,
        finalized: true,
        finalizedAt: value.finalizedAt || now,
        updatedAt: now,
      },
      { merge: true },
    );
  });

  const { docs, hasMore } = await roomPage(cursor, limit);

  let finalized = 0;
  let wouldFinalize = 0;
  let alreadyPrivate = 0;
  let skipped = 0;

  for (const roomDoc of docs) {
    const privateRef = db.collection('roomPrivate').doc(roomDoc.id);
    const result = await db.runTransaction(async (transaction) => {
      const adminRef = authorizationUid
        ? db.collection('users').doc(authorizationUid)
        : null;
      const [
        roomSnapshot,
        privateSnapshot,
        privacyConfigSnapshot,
        adminSnapshot,
      ] = await Promise.all([
        transaction.get(roomDoc.ref),
        transaction.get(privateRef),
        transaction.get(locationPrivacyConfigRef),
        adminRef ? transaction.get(adminRef) : null,
      ]);

      assertAdminInTransaction(adminSnapshot, authorizationUid);

      if (!roomSnapshot.exists || !privateSnapshot.exists) return 'skipped';

      const room = roomSnapshot.data() as Record<string, any>;
      const privateValue = privateSnapshot.data() as Record<string, any>;
      const roomOwnerId = String(room.ownerId || '').trim();
      const privateOwnerId = String(privateValue.ownerId || '').trim();
      const privateRoomId = cleanText(privateValue.roomId, 160);
      const publicRoomId = cleanText(room.roomId, 160);

      if (
        !roomOwnerId ||
        privateOwnerId !== roomOwnerId ||
        privateRoomId !== roomDoc.id ||
        publicRoomId !== roomDoc.id
      ) {
        return 'skipped';
      }

      const location = normalizeExactRoomLocation(privateValue);
      if (!hasCompleteExactRoomLocation(location)) return 'skipped';

      if (publicRoomHasExactLocation(room)) {
        const publicLocation = readExactPublicRoomLocation(room);
        if (!exactRoomLocationsMatch(publicLocation, location)) {
          // The global preflight may have completed just before a concurrent
          // write. Never scrub a document whose two exact values disagree.
          return 'skipped';
        }
      }

      const alreadyPrivate =
        !publicRoomHasExactLocation(room) &&
        publicCoarseLocationMatches(room, location);
      if (dryRun) {
        return alreadyPrivate ? 'alreadyPrivate' : 'wouldFinalize';
      }

      const privacyConfig =
        (privacyConfigSnapshot.data() || {}) as Record<string, any>;
      if (privacyConfig.finalized !== true) return 'skipped';

      if (alreadyPrivate) return 'alreadyPrivate';

      const geoCell = roomGeoCell(location);
      transaction.update(roomDoc.ref, {
        location: coarsePublicRoomLocation(location),
        latitude: firestore.FieldValue.delete(),
        longitude: firestore.FieldValue.delete(),
        address: firestore.FieldValue.delete(),
        pincode: firestore.FieldValue.delete(),
        geoCell: geoCell || firestore.FieldValue.delete(),
        locationRevision:
          cleanText(privateValue.locationRevision, 160) || 'private-v1',
        locationPrivacyVersion: 'private-v1',
        locationUpdatedAt: firestore.Timestamp.now(),
      });

      return 'finalized';
    });

    if (result === 'finalized') finalized += 1;
    else if (result === 'wouldFinalize') wouldFinalize += 1;
    else if (result === 'alreadyPrivate') alreadyPrivate += 1;
    else skipped += 1;
  }

  return {
    scanned: docs.length,
    finalized,
    wouldFinalize,
    alreadyPrivate,
    skipped,
    dryRun,
    preflight,
    hasMore,
    nextCursor: docs.length > 0 ? docs[docs.length - 1].id : cursor || null,
  };
}

/**
 * Opens or closes the legacy client-write compatibility window.
 *
 * This helper is intentionally **not** a callable. The switch lives in the
 * server-only `system` collection and must be changed with the Admin SDK,
 * never from an app client.
 */
export async function setClientExactLocationWritesAllowed(
  enabled: boolean,
): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(locationPrivacyConfigRef);
    const value = (snapshot.data() || {}) as Record<string, any>;
    if (enabled && value.finalized === true) {
      throw new Error(
        'The legacy exact-location write window cannot be reopened after finalization',
      );
    }

    transaction.set(
      locationPrivacyConfigRef,
      {
        allowClientExactLocationWrites: enabled,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

/** Admin callable which copies one page of legacy locations. */
export const migrateRoomPrivateLocations = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }
    const adminUid = context.auth.uid;
    await assertLiveAdmin(adminUid);

    return migrateRoomPrivateLocationsPage({
      cursor: data?.cursor,
      limit: data?.limit,
      dryRun: data?.dryRun !== false,
      authorizationUid: adminUid,
    });
  },
);

/** Admin callable which verifies one page of private locations. */
export const verifyRoomPrivateLocations = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }
    const adminUid = context.auth.uid;
    await assertLiveAdmin(adminUid);

    if (data?.all === true) {
      const audit = await verifyAllRoomPrivateLocations();
      await assertAdminStillAuthorized(adminUid);
      return {
        ...audit,
        scope: 'all' as const,
      };
    }

    const page = await verifyRoomPrivateLocationsPage({
      cursor: data?.cursor,
      limit: data?.limit,
    });
    await assertAdminStillAuthorized(adminUid);
    return {
      ...page,
      scope: 'page' as const,
    };
  },
);

/** Admin callable which removes the exact public fields from one page. */
export const finalizeRoomLocationPrivacy = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }
    const adminUid = context.auth.uid;
    await assertLiveAdmin(adminUid);

    return finalizeRoomLocationPrivacyPage({
      cursor: data?.cursor,
      limit: data?.limit,
      dryRun: data?.dryRun !== false,
      authorizationUid: adminUid,
    });
  },
);
