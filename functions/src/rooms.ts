import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  assertLiveAdmin,
  assertLiveOwner,
  assertLiveOwnerOrAdmin,
} from './accounts';
import { isActiveBookingStatus } from './bookings';
import { notify } from './notifications';

const db = admin.firestore();

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
 * activation / rollback. Introducing a second listing-status field without
 * migrating the model, the queries and the admin path at the same time would
 * make the owner action invisible to part of the app.
 */
export type RoomListingStatus = 'available' | 'occupied';

/** Why an owner may not change the listing status. */
export type RoomListingAvailabilityRejection =
  | 'invalid-capacity'
  | 'invalid-occupancy'
  | 'already-full'
  | 'has-occupants';

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
 *  - a room with an active occupant may not be marked available again — the
 *    server releases that occupant when the booking itself is rolled back.
 *
 * Keeping those rules in a pure helper makes the important transition logic
 * testable without a Firestore emulator.
 */
export function decideRoomListingAvailability(
  isOccupied: boolean,
  occupancy: number,
  currentOccupancy: number,
): RoomListingAvailabilityDecision {
  if (!Number.isFinite(occupancy) || occupancy <= 0) {
    return { allowed: false, reason: 'invalid-capacity' };
  }
  if (
    !Number.isFinite(currentOccupancy) ||
    currentOccupancy < 0 ||
    currentOccupancy > occupancy
  ) {
    return { allowed: false, reason: 'invalid-occupancy' };
  }

  if (isOccupied && currentOccupancy >= occupancy) {
    return { allowed: false, reason: 'already-full' };
  }
  if (!isOccupied && currentOccupancy > 0) {
    return { allowed: false, reason: 'has-occupants' };
  }

  return {
    allowed: true,
    status: isOccupied ? 'occupied' : 'available',
  };
}

/**
 * Lets a live owner change the availability of one of their own listings.
 *
 * The owner and the room are checked on the server. The room is read inside
 * a Firestore transaction, so the ownership check and the write are based on
 * the same document version.
 *
 * This function never writes `currentOccupancy`. Booking activation and its
 * rollback are the only paths that own that counter.
 */
export const setRoomListingAvailability = functions.https.onCall(
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

    const status = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That room no longer exists',
        );
      }

      const room = snapshot.data() as Record<string, any>;
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

      const occupancy =
        room.occupancy === undefined || room.occupancy === null
          ? 1
          : Number(room.occupancy);
      const currentOccupancy =
        room.currentOccupancy === undefined || room.currentOccupancy === null
          ? 0
          : Number(room.currentOccupancy);

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
          case 'has-occupants':
            throw new functions.https.HttpsError(
              'failed-precondition',
              'This room still has occupants; occupancy is managed by booking activation',
            );
        }
      }

      // Only the legacy listing-status field is changed. In particular,
      // `currentOccupancy` is absent from this update on purpose.
      transaction.update(roomRef, {
        status: decision.status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return decision.status;
    });

    return { success: true, status };
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
  if (
    !Number.isFinite(currentOccupancy) ||
    currentOccupancy < 0
  ) {
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
export const deleteRoomListing = functions.https.onCall(
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

    const role = await assertLiveOwnerOrAdmin(uid);
    const roomRef = db.collection('rooms').doc(roomId);

    // Mark the listing as unavailable first. `createJoinRequest` checks this
    // marker in the same transaction in which it creates a request, so the
    // request set cannot grow while the deletion is being completed.
    const markedRoom = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That room no longer exists',
        );
      }

      const room = snapshot.data() as Record<string, any>;
      const ownerId = String(room.ownerId || '');
      if (role === 'owner' && ownerId !== uid) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'You can only delete your own listings',
        );
      }

      const currentOccupancy = Number(room.currentOccupancy || 0);
      const occupancyDecision = decideRoomDeletion(currentOccupancy, []);
      if (!occupancyDecision.allowed) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          occupancyDecision.reason === 'has-occupants'
            ? 'This room still has occupants. End the active booking before deleting the listing.'
            : 'The room occupancy is invalid; repair it before deleting the listing.',
        );
      }

      transaction.update(roomRef, {
        status: 'inactive',
        deletionInProgress: true,
        deletionRequestedBy: uid,
        deletionRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        previousStatus: String(room.status || 'available'),
      };
    });

    const restoreRoomAfterFailedDeletion = async (): Promise<void> => {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(roomRef);
        if (!snapshot.exists) return;

        const room = snapshot.data() as Record<string, any>;
        if (
          room.deletionInProgress !== true ||
          String(room.deletionRequestedBy || '') !== uid
        ) {
          return;
        }

        const restoreStatus =
          String(room.status || '') === 'inactive' &&
          markedRoom.previousStatus !== 'inactive'
            ? markedRoom.previousStatus
            : String(room.status || 'inactive');

        transaction.update(roomRef, {
          status: restoreStatus,
          deletionInProgress: admin.firestore.FieldValue.delete(),
          deletionRequestedBy: admin.firestore.FieldValue.delete(),
          deletionRequestedAt: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    };

    const requestsSnapshot = await db
      .collection('joinRequests')
      .where('roomId', '==', roomId)
      .get();

    const requestStates = requestsSnapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, any>;
      return {
        status: String(data.status || ''),
        advancePaid: data.advancePaid === true,
        platformCutTaken: data.platformCutTaken === true,
        advancePaymentStatus: String(data.advancePaymentStatus || ''),
      };
    });

    const currentRoom = await roomRef.get();
    const currentOccupancy = Number(
      (currentRoom.data()?.currentOccupancy as number | undefined) || 0,
    );
    const deletionDecision = decideRoomDeletion(
      currentOccupancy,
      requestStates,
    );

    if (!deletionDecision.allowed) {
      // Put the listing back the way it was. The marker is removed as well,
      // so a later retry starts from a clean state.
      await restoreRoomAfterFailedDeletion();

      const message =
        deletionDecision.reason === 'active-booking'
          ? 'This room has an active booking and cannot be deleted.'
          : deletionDecision.reason === 'payment-in-progress'
            ? 'This room has a payment waiting for verification and cannot be deleted.'
            : 'This room still has occupants and cannot be deleted.';

      throw new functions.https.HttpsError('failed-precondition', message);
    }

    const cancelledStudents: string[] = [];

    try {
      // Cancel every open request. The transaction re-reads the request, so a
      // payment or activation that races with the deletion cannot be
      // overwritten by a cancellation.
      for (const requestDoc of requestsSnapshot.docs) {
        const requestRef = requestDoc.ref;
        const cancelled = await db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(requestRef);
          if (!snapshot.exists) return null;

          const request = snapshot.data() as Record<string, any>;
          const status = String(request.status || '');
          const decision = decideRoomDeletion(currentOccupancy, [
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
            cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
            cancelledBy: uid,
            cancellationReason: 'The room listing was deleted',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          return String(request.studentId || '');
        });

        if (cancelled) cancelledStudents.push(cancelled);
      }

      // The final read and delete are transactional. If an occupancy or active
      // booking appeared in the meantime, the listing is not removed.
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(roomRef);
        if (!snapshot.exists) return;

        const room = snapshot.data() as Record<string, any>;
        const finalDecision = decideRoomDeletion(
          Number(room.currentOccupancy || 0),
          [],
        );
        if (!finalDecision.allowed) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'The room changed while the listing was being deleted. Try again.',
          );
        }

        transaction.delete(roomRef);
      });
    } catch (error) {
      // A failed cancellation must not leave the listing permanently marked
      // for deletion. Restore the previous state so the owner can resolve the
      // conflicting booking and try again.
      await restoreRoomAfterFailedDeletion();
      throw error;
    }

    // A notification must never make a successful deletion fail.
    await Promise.all(
      cancelledStudents.map((studentId) =>
        notify(
          studentId,
          'Room listing removed',
          'The room listing you requested was removed. The request was cancelled.',
          'joinRequest',
          { requestId: '', roomId },
        ),
      ),
    );

    return {
      success: true,
      roomId,
      cancelledRequests: cancelledStudents.length,
    };
  },
);

/**
 * Normalizes a freshly created listing.
 *
 * `status` and `currentOccupancy` are server-owned fields: from the moment
 * the listing exists they may only be changed by `setRoomListingAvailability`
 * / `adminSetRoomListingStatus` (the status) and by the booking state machine
 * (the counter).
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
    const data = snapshot.data() as Record<string, any> | undefined;
    if (!data) return;

    const patch: Record<string, unknown> = {};

    if (data.status === undefined || data.status === null) {
      patch.status = 'available';
    }
    if (data.currentOccupancy === undefined || data.currentOccupancy === null) {
      patch.currentOccupancy = 0;
    }

    if (Object.keys(patch).length === 0) return;

    try {
      await snapshot.ref.set(patch, { merge: true });
      console.log(
        `Room ${snapshot.id}: initialized ${Object.keys(patch).join(', ')}`,
      );
    } catch (error) {
      console.error(`Error initializing room ${snapshot.id}:`, error);
      throw error;
    }
  });

/**
 * Changes the listing status of any room as a live administrator.
 *
 * The occupancy counter is deliberately not touched. The status is a
 * listing/legacy compatibility field; actual tenants are represented by
 * `currentOccupancy`, which only the booking state machine may change.
 */
export const adminSetRoomListingStatus = functions.https.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }

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
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(roomRef);
      if (!snapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That room no longer exists',
        );
      }

      const room = snapshot.data() as Record<string, any>;
      if (room.deletionInProgress === true) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This listing is being deleted and its status cannot be changed',
        );
      }
      const currentOccupancy = Number(room.currentOccupancy || 0);

      // A room with tenants cannot be published as available. The server
      // keeps the status consistent with the occupancy counter.
      if (status === 'available' && currentOccupancy > 0) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This room still has occupants and cannot be marked available',
        );
      }

      transaction.update(roomRef, {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return { success: true, status };
  },
);
