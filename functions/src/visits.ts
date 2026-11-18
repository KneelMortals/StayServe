import * as functions from 'firebase-functions/v1';
import { callableHttps } from './appCheck';
import * as firestore from 'firebase-admin/firestore';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  canBookAsStudent,
  displayNameOf,
  OWNER_ACCEPTED_STATUSES,
} from './bookingAccess';
import { assertLiveStudent } from './accounts';
import {
  readPrivateRoomLocationFromData,
  readRoomLocationPrivacyConfigFromData,
} from './privateLocations';
import {
  configuredRoomLocationStage,
  hasCompleteExactRoomLocation,
  readExactPublicRoomLocation,
} from './roomLocation';

const db = firestore.getFirestore();

/**
 * The visit details of a room — the address the student has to go to.
 *
 * ## Why this is a server call
 *
 * The student may only see where the room is **after the owner has accepted
 * their request**. Before that the student only gets the rough area (the
 * city), which is what the search shows.
 *
 * The exact location is stored in `roomPrivate/{roomId}`. This callable is
 * the only path which hands it to a student, and it does so only after the
 * server has verified an accepted join request. Firestore rules cannot hide
 * one field inside a document, which is why the exact address is a separate
 * document in the first place.
 */

/**
 * The visit details of a room.
 */
export interface VisitDetails {
  roomId: string;
  title: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  latitude: number | null;
  longitude: number | null;
  ownerId: string;
  ownerName: string;
  requestId: string;
}

/**
 * The full address of the room — the single line a student can copy.
 */
function fullAddress(location: {
  address: string;
  city: string;
  state: string;
  pincode: string;
}): string {
  return [location.address, location.city, location.state, location.pincode]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');
}

/**
 * The visit details of a room — for the students the owner accepted.
 */
export const getRoomVisitDetails = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const roomId = String(data?.roomId || '').trim();
  if (!roomId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing room');
  }

  // Fast failure for an account which is already known to be ineligible.
  // The transaction below repeats the check against the live profile and is
  // the authoritative one.
  await assertLiveStudent(uid);

  const studentRef = db.collection('users').doc(uid);
  const roomRef = db.collection('rooms').doc(roomId);
  const privateLocationRef = db.collection('roomPrivate').doc(roomId);
  const privacyConfigRef = db.collection('system').doc('locationPrivacy');

  // The accepted request, both profiles, the public listing, the private
  // location and the durable privacy latch are all read from one transaction
  // snapshot. A request which is cancelled, a listing which is removed, a
  // role change or a location finalization therefore cannot race with the
  // release of an exact address.
  const details = await db.runTransaction(async (transaction) => {
    const acceptedQuery = db
      .collection('joinRequests')
      .where('roomId', '==', roomId)
      .where('studentId', '==', uid)
      .where('status', 'in', OWNER_ACCEPTED_STATUSES)
      .limit(1);

    const [
      studentSnapshot,
      acceptedSnapshot,
      roomSnapshot,
      privateLocationSnapshot,
      privacyConfigSnapshot,
    ] = await Promise.all([
      transaction.get(studentRef),
      transaction.get(acceptedQuery),
      transaction.get(roomRef),
      transaction.get(privateLocationRef),
      transaction.get(privacyConfigRef),
    ]);

    if (
      !canBookAsStudent({
        exists: studentSnapshot.exists,
        registrationCompleted: studentSnapshot.get('registrationCompleted'),
        isActive: studentSnapshot.get('isActive'),
        role: studentSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only active student accounts can view visit details.',
      );
    }

    // ---------------------------------------------------------------------
    // The rule: the owner has to have accepted the request first.
    // ---------------------------------------------------------------------
    if (acceptedSnapshot.empty) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The owner has not accepted your request for this room yet',
      );
    }

    const acceptedDocument = acceptedSnapshot.docs[0];
    const accepted = acceptedDocument.data() as Record<string, any>;

    if (!roomSnapshot.exists) {
      throw new functions.https.HttpsError('not-found', 'That room no longer exists');
    }
    const room = roomSnapshot.data() as Record<string, any>;
    const ownerId = String(room.ownerId || '').trim();

    // A corrupt request must not be able to point an accepted student at a
    // different listing's private address.
    const acceptedOwnerId = String(accepted.ownerId || '').trim();
    if (
      !ownerId ||
      acceptedOwnerId !== ownerId ||
      String(accepted.roomId || '').trim() !== roomId
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The booking details for this room are inconsistent. Please contact support.',
      );
    }

    const ownerSnapshot = await transaction.get(
      db.collection('users').doc(ownerId),
    );

    const privacyConfig = readRoomLocationPrivacyConfigFromData(
      privacyConfigSnapshot.data() as Record<string, any> | undefined,
    );
    const privateLocation = readPrivateRoomLocationFromData(
      privateLocationSnapshot.exists
        ? (privateLocationSnapshot.data() as Record<string, any>)
        : undefined,
    );

    let location: {
      address: string;
      city: string;
      state: string;
      pincode: string;
      latitude: number | null;
      longitude: number | null;
    };

    if (privateLocation) {
      if (
        privateLocation.ownerId !== ownerId ||
        privateLocation.roomId !== roomId ||
        !hasCompleteExactRoomLocation(privateLocation)
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The private location for this room is inconsistent. Please contact support.',
        );
      }
      location = {
        address: privateLocation.address,
        city: privateLocation.city,
        state: privateLocation.state,
        pincode: privateLocation.pincode,
        latitude: privateLocation.latitude,
        longitude: privateLocation.longitude,
      };
    } else if (
      configuredRoomLocationStage() === 'dual' &&
      !privacyConfig.finalized
    ) {
      // Compatibility fallback while the migration is still running. It is
      // removed automatically when ROOM_LOCATION_STAGE=private is deployed,
      // and the durable finalization latch closes it even earlier.
      const publicLocation = readExactPublicRoomLocation(room);
      if (!hasCompleteExactRoomLocation(publicLocation)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This room location has not been migrated yet. Please try again shortly.',
        );
      }
      location = publicLocation;
    } else {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This room location has not been migrated yet. Please contact support.',
      );
    }

    const ownerValue = ownerSnapshot.exists
      ? (ownerSnapshot.data() as Record<string, any>)
      : undefined;
    const ownerName = ownerValue
      ? String(ownerValue.name || '').trim() ||
        String(ownerValue.email || '').trim().split('@')[0]
      : '';

    return {
      roomId,
      title: String(room.title || 'The room'),
      ...location,
      ownerId,
      ownerName,
      requestId: acceptedDocument.id,
    } satisfies VisitDetails;
  });

  // The Auth display name is only a presentation fallback. It is never part
  // of the authorization decision and therefore does not have to be in the
  // transaction.
  const ownerName = details.ownerName || (await displayNameOf(details.ownerId));

  return {
    success: true,
    ...details,
    ownerName,
    fullAddress: fullAddress(details),
  };
});
