import * as crypto from 'crypto';
import * as firestore from 'firebase-admin/firestore';
import * as functions from 'firebase-functions/v1';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import { callableHttps } from './appCheck';
import { assertLiveOwner } from './accounts';
import { canActAsRoomOwner } from './bookingAccess';
import {
  ROOM_DRAFTS_COLLECTION,
  ROOM_LISTINGS_COLLECTION,
  readRoomListingPair,
  resolveRoomListing,
} from './roomListings';
import {
  MAX_ROOM_PHOTOS,
  assertRoomBelongsToOwner,
  assertRoomPhotoOperationIdentity,
  commitDocumentId,
  isCanonicalRoomImageUrl,
  nonNegativeInteger,
  operationDocumentId,
  quotaDocumentId,
  quotaState,
  releasePendingQuota,
  releasePendingRoomQuota,
  roomListingGeneration,
  roomPhotoCommitRequestHash,
  roomPhotoDownloadToken,
  roomPhotoUploadExpired,
  stringList,
  uniqueStringList,
  validIdentifier,
} from './roomMedia';
import {
  effectiveRoomLocationStage,
  locationPrivacyConfigRef,
  publicLocationPatch,
  readOwnerLocationInput,
  readRoomLocationPrivacyConfigFromData,
} from './privateLocations';
import { ExactRoomLocation } from './roomLocation';
import {
  isValidCurrentOccupancy,
  isValidMonthlyRent,
  isValidRoomCapacity,
} from './roomValidation';

const db = firestore.getFirestore();

/** The longest title an owner may give a listing. */
const MAX_ROOM_TITLE_LENGTH = 120;

/** The longest description an owner may give a listing. */
const MAX_ROOM_DESCRIPTION_LENGTH = 2000;

/** The largest security deposit an owner may ask for. */
const MAX_ROOM_SECURITY_DEPOSIT = 10_000_000;

/** The largest number of amenities one listing may carry. */
const MAX_ROOM_AMENITIES = 20;

/** The longest single amenity. */
const MAX_ROOM_AMENITY_LENGTH = 60;

/** The longest home name. */
const MAX_ROOM_HOME_NAME_LENGTH = 120;

/** The longest home id. */
const MAX_ROOM_HOME_ID_LENGTH = 120;

/** The room types the product accepts. */
const ROOM_TYPES = ['single', 'double', 'triple', 'shared'];

/** The furnishing states the product accepts. */
const FURNISHING_TYPES = ['unfurnished', 'semi', 'fully'];

/** The gender preferences the product accepts. */
const GENDER_PREFERENCES = ['male', 'female', 'any'];

/** The owner-editable fields of one listing. */
export interface RoomListingEditFields {
  title: string;
  description: string;
  monthlyRent: number;
  securityDeposit: number;
  roomType: string;
  furnishing: string;
  availableFromMillis: number;
  amenities: string[];
  occupancy: number;
  genderPreference: string;
  homeId: string;
  homeName: string;
}

/** The result of one atomic owner edit. */
export interface RoomListingEditResult {
  success: true;
  roomId: string;
  listingCollection: string;
  images: string[];
  locationRevision: string;
  alreadyCommitted: boolean;
  updatedAtMillis: number;
}

function cleanText(value: unknown, maximum: number): string {
  return String(value ?? '').trim().slice(0, maximum);
}

function invalidArgument(message: string): functions.https.HttpsError {
  return new functions.https.HttpsError('invalid-argument', message);
}

/**
 * Parses the owner-editable fields of one edit.
 *
 * Every value is bounded here. The client is not a security boundary, so the
 * server never stores a title of unbounded length or an unknown enum value.
 */
export function readRoomListingEditFields(
  value: unknown,
): RoomListingEditFields {
  const data = (value || {}) as Record<string, any>;

  const title = cleanText(data.title, MAX_ROOM_TITLE_LENGTH);
  if (!title) throw invalidArgument('The listing needs a title.');

  const description = cleanText(data.description, MAX_ROOM_DESCRIPTION_LENGTH);
  if (!description) throw invalidArgument('The listing needs a description.');

  const monthlyRent = Number(data.monthlyRent);
  if (!isValidMonthlyRent(monthlyRent)) {
    throw invalidArgument(
      'The monthly rent must be between ₹1,000 and ₹10,00,000.',
    );
  }

  const securityDeposit = Number(data.securityDeposit);
  if (
    !Number.isFinite(securityDeposit) ||
    securityDeposit < 0 ||
    securityDeposit > MAX_ROOM_SECURITY_DEPOSIT
  ) {
    throw invalidArgument('The security deposit is not valid.');
  }

  const roomType = cleanText(data.roomType, 32);
  if (!ROOM_TYPES.includes(roomType)) {
    throw invalidArgument('The room type is not valid.');
  }

  const furnishing = cleanText(data.furnishing, 32);
  if (!FURNISHING_TYPES.includes(furnishing)) {
    throw invalidArgument('The furnishing is not valid.');
  }

  const genderPreference = cleanText(data.genderPreference, 32);
  if (!GENDER_PREFERENCES.includes(genderPreference)) {
    throw invalidArgument('The gender preference is not valid.');
  }

  const occupancy = Number(data.occupancy);
  if (!isValidRoomCapacity(occupancy)) {
    throw invalidArgument(
      'The number of people who can live in the room must be between 1 and 20.',
    );
  }

  const availableFromMillis = Number(data.availableFromMillis);
  if (
    !Number.isFinite(availableFromMillis) ||
    availableFromMillis <= 0 ||
    availableFromMillis > 4102444800000
  ) {
    throw invalidArgument('The available-from date is not valid.');
  }

  if (!Array.isArray(data.amenities) || data.amenities.length > MAX_ROOM_AMENITIES) {
    throw invalidArgument('The amenities are not valid.');
  }
  const amenities: string[] = [];
  for (const item of data.amenities) {
    if (typeof item !== 'string') {
      throw invalidArgument('The amenities are not valid.');
    }
    const amenity = item.trim().slice(0, MAX_ROOM_AMENITY_LENGTH);
    if (!amenity) {
      throw invalidArgument('The amenities are not valid.');
    }
    if (!amenities.includes(amenity)) amenities.push(amenity);
  }

  return {
    title,
    description,
    monthlyRent,
    securityDeposit,
    roomType,
    furnishing,
    availableFromMillis,
    amenities,
    occupancy,
    genderPreference,
    homeId: cleanText(data.homeId, MAX_ROOM_HOME_ID_LENGTH),
    homeName: cleanText(data.homeName, MAX_ROOM_HOME_NAME_LENGTH),
  };
}

/** The durable document which records one applied owner edit. */
function roomListingEditDocumentId(ownerId: string, commitId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${ownerId}:${commitId}`)
    .digest('hex');
  return `edit-${digest}`;
}

/**
 * The fingerprint of one owner edit.
 *
 * The fingerprint proves that a commit id was reused for the **same** edit. A
 * different edit under the same id is refused, so a lost acknowledgement can
 * never silently apply another edit.
 */
export function roomListingEditRequestHash(options: {
  roomId: string;
  fields: RoomListingEditFields;
  location: ExactRoomLocation;
  uploadIds: string[];
  removeUrls: string[];
}): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        roomId: options.roomId,
        fields: {
          ...options.fields,
          amenities: [...options.fields.amenities].sort(),
        },
        location: {
          address: options.location.address,
          city: options.location.city,
          state: options.location.state,
          pincode: options.location.pincode,
          latitude: options.location.latitude,
          longitude: options.location.longitude,
        },
        uploadIds: [...options.uploadIds].sort(),
        removeUrls: [...options.removeUrls].sort(),
      }),
    )
    .digest('hex');
}

/**
 * Applies one owner edit to a listing in a single transaction.
 *
 * The edit changes three things at once: the owner-editable metadata, the
 * exact location and the photo list. They are committed together, so a
 * failure between them is impossible: the listing either has **all three**
 * new values or none of them.
 *
 * The transaction reads the listing, the owner profile, the private location
 * document, the location-privacy controls, the staged photo operations, the
 * photo quotas and the durable edit record before it writes anything. Every
 * write therefore happens against a state which was fully verified.
 */
export const updateRoomListing = callableHttps.onCall(
  async (data, context): Promise<RoomListingEditResult> => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in before editing a listing.',
      );
    }

    const ownerId = context.auth.uid;
    // The custom claim may be stale. The live server-side profile decides
    // whether this user is still a registered, active owner.
    await assertLiveOwner(ownerId);

    const roomId = String(data?.roomId || '').trim();
    const commitId = String(data?.commitId || '').trim();
    if (!validIdentifier(roomId, 128)) {
      throw invalidArgument('Invalid room id.');
    }
    if (!validIdentifier(commitId, 128)) {
      throw invalidArgument('Invalid commit id.');
    }

    const fields = readRoomListingEditFields(data?.update);
    const location = readOwnerLocationInput(
      (data?.location || {}) as Record<string, any>,
    );

    const uploadIds = uniqueStringList(data?.uploadIds, MAX_ROOM_PHOTOS);
    const removeUrls = uniqueStringList(data?.removeUrls, MAX_ROOM_PHOTOS);
    if (removeUrls.some((url) => url.length > 2048)) {
      throw invalidArgument('A room-photo URL is invalid.');
    }
    if (!uploadIds.every((uploadId) => validIdentifier(uploadId, 128))) {
      throw invalidArgument('An upload id is invalid.');
    }

    const requestHash = roomListingEditRequestHash({
      roomId,
      fields,
      location,
      uploadIds,
      removeUrls,
    });
    const photoRequestHash = roomPhotoCommitRequestHash({
      roomId,
      uploadIds,
      removeUrls,
    });

    const ownerRef = db.collection('users').doc(ownerId);
    const privateRef = db.collection('roomPrivate').doc(roomId);
    const editRef = db
      .collection('roomListingEditOperations')
      .doc(roomListingEditDocumentId(ownerId, commitId));
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
      // ------------------------------------------------------------------
      // The read phase. Every document is read before anything is written.
      // ------------------------------------------------------------------
      const { draft, published } = await readRoomListingPair(
        transaction,
        roomId,
      );
      const listing = resolveRoomListing(draft, published);
      const roomSnapshot = listing ? listing.snapshot : null;
      const room = assertRoomBelongsToOwner(roomSnapshot, ownerId, roomId);
      const listingRef = listing ? listing.ref : published.ref;

      const [
        ownerSnapshot,
        privateSnapshot,
        privacyConfigSnapshot,
        editSnapshot,
        commitSnapshot,
        quotaSnapshot,
        roomQuotaSnapshot,
      ] = await Promise.all([
        transaction.get(ownerRef),
        transaction.get(privateRef),
        transaction.get(locationPrivacyConfigRef),
        transaction.get(editRef),
        transaction.get(commitRef),
        transaction.get(quotaRef),
        transaction.get(roomQuotaRef),
      ]);

      const operationSnapshots = [];
      for (const operationRef of operationRefs) {
        operationSnapshots.push(await transaction.get(operationRef));
      }

      // The live owner role is checked inside the same transaction as the
      // edit. A concurrent demotion or ban cannot edit a listing with a
      // stale claim.
      if (
        !canActAsRoomOwner({
          exists: ownerSnapshot.exists,
          registrationCompleted: ownerSnapshot.get('registrationCompleted'),
          isActive: ownerSnapshot.get('isActive'),
          role: ownerSnapshot.get('role'),
        })
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Only a live owner account can edit this listing.',
        );
      }

      // A retry of an edit which already committed returns the recorded
      // result. The live listing is never touched a second time, so the
      // edit cannot be applied twice.
      if (editSnapshot.exists) {
        const edit = editSnapshot.data() as Record<string, any>;
        if (String(edit.requestHash || '') !== requestHash) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'That listing edit id was already used.',
          );
        }
        return {
          success: true,
          roomId,
          listingCollection: String(edit.listingCollection || ROOM_LISTINGS_COLLECTION),
          images: stringList(edit.images),
          locationRevision: String(edit.locationRevision || ''),
          alreadyCommitted: true,
          updatedAtMillis: Number(edit.updatedAtMillis || 0),
        } satisfies RoomListingEditResult;
      }

      // ------------------------------------------------------------------
      // The validation phase. Nothing is written while a check can still
      // reject the edit.
      // ------------------------------------------------------------------
      const liveOccupancy = Number(room.currentOccupancy || 0);
      if (!isValidCurrentOccupancy(liveOccupancy)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This listing has an invalid occupancy and cannot be edited.',
        );
      }
      if (fields.occupancy < liveOccupancy) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `This room already has ${liveOccupancy} ` +
            `${liveOccupancy === 1 ? 'person' : 'people'} living in it, so ` +
            'the capacity cannot be lower than that.',
        );
      }

      const privacyConfigValue =
        (privacyConfigSnapshot.data() || {}) as Record<string, any>;
      const privacyConfig = readRoomLocationPrivacyConfigFromData(
        privacyConfigValue,
      );
      const stage = effectiveRoomLocationStage(privacyConfig);
      const locationRevision = crypto.randomUUID();

      const hadListingGeneration = Boolean(
        String(room.listingGeneration || '').trim(),
      );
      const listingGeneration = roomListingGeneration(room);

      // The photo changes are validated against the staged operations. A
      // staged photo which does not belong to this listing, to this owner or
      // to this listing lifetime is refused.
      const uploadedUrls: string[] = [];
      let releasedCount = 0;
      let releasedBytes = 0;
      const now = Date.now();
      const currentImages = stringList(room.images);
      const photoCommitExists = commitSnapshot.exists;
      let committedImages = currentImages;

      if (photoCommitExists) {
        // The same commit id was already used for a photo change. The staged
        // uploads of that change are already referenced by the listing, so
        // they are not validated and released a second time.
        const commit = commitSnapshot.data() as Record<string, any>;
        if (String(commit.requestHash || '') !== photoRequestHash) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'That room-photo commit id was already used.',
          );
        }
      } else {
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
        }
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
      committedImages = images;

      // ------------------------------------------------------------------
      // The write phase. Every write is queued here and committed together.
      // ------------------------------------------------------------------
      const existingPrivate = privateSnapshot.data() as
        | Record<string, any>
        | undefined;
      const timestamp = firestore.Timestamp.now();

      const listingPatch: Record<string, unknown> = {
        title: fields.title,
        description: fields.description,
        monthlyRent: fields.monthlyRent,
        securityDeposit: fields.securityDeposit,
        roomType: fields.roomType,
        furnishing: fields.furnishing,
        availableFrom: firestore.Timestamp.fromMillis(
          fields.availableFromMillis,
        ),
        amenities: fields.amenities,
        occupancy: fields.occupancy,
        genderPreference: fields.genderPreference,
        homeId: fields.homeId || firestore.FieldValue.delete(),
        homeName: fields.homeName || firestore.FieldValue.delete(),
        images: committedImages,
        ...publicLocationPatch(location, stage, locationRevision),
        locationUpdatedAt: timestamp,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      };
      if (!hadListingGeneration) {
        listingPatch.listingGeneration = listingGeneration;
      }
      transaction.update(listingRef, listingPatch);

      transaction.set(
        privateRef,
        {
          roomId,
          ownerId,
          ...location,
          locationRevision,
          source: 'owner',
          createdAt: existingPrivate?.createdAt || timestamp,
          updatedAt: timestamp,
        },
        { merge: true },
      );

      if (!photoCommitExists) {
        for (let index = 0; index < operationSnapshots.length; index += 1) {
          const snapshot = operationSnapshots[index];
          const operation = snapshot.data() as Record<string, any>;
          if (String(operation.status || '') !== 'uploaded') continue;
          transaction.update(snapshot.ref, {
            status: 'referenced',
            referencedAt: firestore.FieldValue.serverTimestamp(),
            updatedAt: firestore.FieldValue.serverTimestamp(),
            commitId,
            cleanupAfter: firestore.FieldValue.delete(),
          });
        }

        const quota = quotaState(quotaSnapshot);
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
            requestHash: photoRequestHash,
            listingGeneration,
            uploadIds,
            removeUrls,
            images: committedImages,
            createdAt: firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }

      transaction.set(
        editRef,
        {
          type: 'roomListingEdit',
          ownerId,
          roomId,
          commitId,
          requestHash,
          listingCollection:
            listing?.collection === ROOM_DRAFTS_COLLECTION
              ? ROOM_DRAFTS_COLLECTION
              : ROOM_LISTINGS_COLLECTION,
          listingGeneration,
          locationRevision,
          images: committedImages,
          updatedAtMillis: Date.now(),
          createdAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        success: true,
        roomId,
        listingCollection:
          listing?.collection === ROOM_DRAFTS_COLLECTION
            ? ROOM_DRAFTS_COLLECTION
            : ROOM_LISTINGS_COLLECTION,
        images: committedImages,
        locationRevision,
        alreadyCommitted: false,
        updatedAtMillis: Date.now(),
      } satisfies RoomListingEditResult;
    });
  },
);
