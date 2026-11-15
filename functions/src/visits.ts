import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import { displayNameOf, findOwnerAcceptedRequest } from './bookingAccess';
import { assertActiveAccount } from './accounts';

const db = admin.firestore();

/**
 * The visit details of a room — the address the student has to go to.
 *
 * ## Why this is a server call
 *
 * The student may only see where the room is **after the owner has accepted
 * their request**. Before that the student only gets the rough area (the
 * city), which is what the search shows.
 *
 * The check is made on the server, so a modified client cannot ask for the
 * address of a room it was never accepted for. The room document itself
 * still holds the address (the owner needs it in the app) — this function
 * is the **only** way the app hands the visit details out, and it hands them
 * out only to the students the owner accepted.
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
 * The address of the room — as the owner published it.
 */
function readLocation(room: Record<string, any>) {
  const location = (room.location || {}) as Record<string, any>;

  const address = String(location.address || room.address || '').trim();
  const city = String(location.city || '').trim();
  const state = String(location.state || '').trim();
  const pincode = String(location.pincode || '').trim();

  const latitude = location.latitude !== undefined && location.latitude !== null
    ? Number(location.latitude)
    : room.latitude !== undefined && room.latitude !== null
      ? Number(room.latitude)
      : null;
  const longitude = location.longitude !== undefined && location.longitude !== null
    ? Number(location.longitude)
    : room.longitude !== undefined && room.longitude !== null
      ? Number(room.longitude)
      : null;

  return {
    address,
    city,
    state,
    pincode,
    latitude: Number.isFinite(latitude as number) ? latitude : null,
    longitude: Number.isFinite(longitude as number) ? longitude : null,
  };
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
export const getRoomVisitDetails = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }

  const uid = context.auth.uid;
  const roomId = String(data?.roomId || '').trim();
  if (!roomId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing room');
  }

  await assertActiveAccount(uid);

  // ---------------------------------------------------------------------
  // The rule: the owner has to have accepted the request first.
  // ---------------------------------------------------------------------
  const accepted = await findOwnerAcceptedRequest(uid, roomId);
  if (!accepted) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The owner has not accepted your request for this room yet',
    );
  }

  const roomSnapshot = await db.collection('rooms').doc(roomId).get();
  if (!roomSnapshot.exists) {
    throw new functions.https.HttpsError('not-found', 'That room no longer exists');
  }
  const room = roomSnapshot.data() as Record<string, any>;

  const location = readLocation(room);
  const ownerId = String(room.ownerId || '');

  const details: VisitDetails = {
    roomId,
    title: String(room.title || 'The room'),
    ...location,
    ownerId,
    ownerName: ownerId ? await displayNameOf(ownerId) : '',
    requestId: accepted.requestId,
  };

  return {
    success: true,
    ...details,
    fullAddress: fullAddress(location),
  };
});
