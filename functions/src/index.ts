import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Creates the default Firebase app **before** any other module is loaded —
// see the comment in `./firebase.ts`.
import './firebase';

import { assertLiveAdmin } from './accounts';
import { deleteUserEverywhere } from './admin';
import { deleteWhere, deleteWhereAsync, updateWhere } from './batches';

const db = admin.firestore();
const auth = admin.auth();

// OTP verification (email + mobile).
export { sendOtp, verifyOtp, registerUserRole, completeRegistration } from './otp';

// Platform-fee payments (server-authoritative payee, amount and verification).
export { createUpiPayment, submitPayment, verifyPayment } from './payments';

// Booking requests and client notifications.
//
// The join-request documents are written by the server, so the rent, the
// owner and the commission percentage cannot be forged by a modified client.
export {
  createJoinRequest,
  respondToJoinRequest,
  confirmJoinAsStudent,
  cancelJoinRequest,
  notifyUser,
} from './requests';

// Notification content and deletion are server-owned. Clients may only
// update the read bookkeeping of their own notification.
export { deleteNotification } from './notifications';

// The admin surface: the review of a booking request and the deletion of a
// user account (with a seven day grace period).
export {
  adminReviewRequest,
  scheduleUserDeletion,
  cancelUserDeletion,
  processScheduledDeletions,
  deleteUserEverywhere,
} from './admin';

// Reviews of a room.
//
// A student may only review a room whose request the owner has accepted —
// the check is made on the server, so a modified client cannot review a
// room it was never accepted for.
export { submitRoomReview, deleteRoomReview } from './reviews';

// The visit details of a room.
//
// The address of a room is only handed out to the students whose request
// the owner has accepted.
export { getRoomVisitDetails } from './visits';

// Owner-controlled listing availability.
//
// The occupancy counter stays server-owned; this callable changes only the
// listing status after checking the live owner and the listing's ownership.
export {
  setRoomListingAvailability,
  deleteRoomListing,
  adminSetRoomListingStatus,
  onRoomCreated,
} from './rooms';

// ============================================
// ADMIN: Revoke User Refresh Tokens (Force Logout)
// ============================================
export const revokeUserTokens = functions.https.onCall(async (data, context) => {
  // Verify admin access
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  await assertLiveAdmin(context.auth.uid);

  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }

  try {
    await auth.revokeRefreshTokens(uid);
    // Disable the Auth account as well. Revoking refresh tokens alone does
    // not invalidate an ID token that is already on a device.
    await auth.updateUser(uid, { disabled: true });
    // Also update Firestore to ensure consistency
    await db.collection('users').doc(uid).update({
      isActive: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true, message: `Tokens revoked for user ${uid}` };
  } catch (error) {
    console.error('Error revoking tokens:', error);
    throw new functions.https.HttpsError('internal', 'Failed to revoke tokens');
  }
});

// ============================================
// ADMIN: Set Custom Claims (Role)
// ============================================
export const setUserRole = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  await assertLiveAdmin(context.auth.uid);

  const { uid, role } = data;
  if (!uid || !role) {
    throw new functions.https.HttpsError('invalid-argument', 'UID and role are required');
  }

  const validRoles = ['student', 'owner', 'admin'];
  if (!validRoles.includes(role)) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid role');
  }

  try {
    // Write the live role **first**. The Firestore rules and the server
    // checks read this document, so a demotion takes effect even if the
    // custom-claim update below is delayed or fails.
    await db.collection('users').doc(uid).update({
      role,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await auth.setCustomUserClaims(uid, { admin: role === 'admin', role });

    // A demotion must not leave an already-issued administrator token
    // usable. New tokens receive the new claims; old refresh sessions are
    // revoked as well.
    if (role !== 'admin') {
      await auth.revokeRefreshTokens(uid);
    }

    return { success: true, message: `Role set to ${role} for user ${uid}` };
  } catch (error) {
    console.error('Error setting role:', error);
    throw new functions.https.HttpsError('internal', 'Failed to set role');
  }
});

// ============================================
// ADMIN: Ban User (Disable + Revoke Tokens)
// ============================================
export const banUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  await assertLiveAdmin(context.auth.uid);

  const { uid, reason } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }

  try {
    await auth.revokeRefreshTokens(uid);
    await auth.updateUser(uid, { disabled: true });
    await db.collection('users').doc(uid).update({
      isActive: false,
      banReason: reason || 'Banned by admin',
      bannedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true, message: `User ${uid} banned` };
  } catch (error) {
    console.error('Error banning user:', error);
    throw new functions.https.HttpsError('internal', 'Failed to ban user');
  }
});

// ============================================
// ADMIN: Unban User (Enable)
// ============================================
export const unbanUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  await assertLiveAdmin(context.auth.uid);

  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }

  try {
    await auth.updateUser(uid, { disabled: false });
    await db.collection('users').doc(uid).update({
      isActive: true,
      banReason: admin.firestore.FieldValue.delete(),
      bannedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { success: true, message: `User ${uid} unbanned` };
  } catch (error) {
    console.error('Error unbanning user:', error);
    throw new functions.https.HttpsError('internal', 'Failed to unban user');
  }
});

// ============================================
// ADMIN: Delete User Completely
// ============================================
//
// The cleanup itself lives in `./admin` — it is shared with the scheduled
// deletion (the seven day grace period) and with the `onUserDelete`
// trigger, so there is only one implementation of "remove this account".
export const deleteUserCompletely = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  await assertLiveAdmin(context.auth.uid);

  const { uid } = data;
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }
  if (uid === context.auth.uid) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'You cannot delete your own account',
    );
  }

  try {
    await deleteUserEverywhere(String(uid));
    return { success: true, message: `User ${uid} deleted completely` };
  } catch (error) {
    console.error('Error deleting user:', error);
    throw new functions.https.HttpsError('internal', 'Failed to delete user');
  }
});

// ============================================
// TRIGGER: On User Create - Set Default Claims
// ============================================
export const onUserCreate = functions.auth.user().onCreate(async (user) => {
  try {
    const userRef = db.collection('users').doc(user.uid);

    // ---------------------------------------------------------------
    // The profile is seeded with `create()`, **not** with
    // `set({...}, {merge: true})`.
    //
    // The old code first read the document and only then wrote it, which
    // left a window in which the client — which writes the role the user
    // actually picked during the sign-up — could create the profile
    // first. The seed then merged over it and replaced `role: 'owner'`
    // with `role: 'student'`.
    //
    // The result was an account that had the "owner" claim but a
    // "student" profile, so the app opened the student home for an owner.
    //
    // `create()` is atomic: it fails with ALREADY_EXISTS when the document
    // is already there, so the seed can never overwrite a profile that
    // somebody else has written.
    // ---------------------------------------------------------------
    try {
      await userRef.create({
        uid: user.uid,
        name: user.displayName || 'User',
        email: user.email || '',
        phone: user.phoneNumber || null,
        role: 'student',
        isActive: true,
        // The account is not usable until the server has verified the
        // registration challenge and written the final role.
        registrationCompleted: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        savedRooms: [],
      });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      // Somebody else (the client) created the profile first — keep it.
    }

    // ---------------------------------------------------------------
    // The profile is re-read here, *after* the seed above.
    //
    // `completeRegistration` may have finished in the meantime and written
    // the real role ('owner') to the profile. Reading the profile only
    // once — at the top of this trigger — meant the role was almost always
    // the hard-coded 'student', and the claim could overwrite the correct
    // one that `completeRegistration` had just set.
    // ---------------------------------------------------------------
    const profile = await userRef.get();

    // ---------------------------------------------------------------
    // The role in the profile is **never** trusted to be 'admin'.
    //
    // The profile document can be written by the client (the rules only
    // allow a user to write their *own* document), and a modified client
    // could put `role: 'admin'` into it. If this trigger then copied that
    // role into the custom claims, the client would have handed itself the
    // `admin` claim — the profile write simply has to win the race against
    // this trigger.
    //
    // Only the two roles a person may claim for themselves are accepted
    // here. An admin is made an admin by `setUserRole` (which needs the
    // admin claim in the first place).
    // ---------------------------------------------------------------
    const storedRole = String(profile.get('role') || 'student');
    const role = storedRole === 'owner' ? 'owner' : 'student';

    await auth.setCustomUserClaims(user.uid, {
      role,
      admin: false,
    });

    console.log(`User profile created for ${user.uid} (role: ${role})`);
  } catch (error) {
    console.error('Error in onUserCreate:', error);
  }
});

/**
 * Whether the error means "the document already exists".
 *
 * The gRPC status code for `ALREADY_EXISTS` is 6. Depending on the version
 * of the Firebase Admin SDK the error carries that number, or the string
 * `already-exists`, so both are accepted.
 */
function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: number | string })?.code;
  return (
    code === 6 ||
    code === 'already-exists' ||
    code === 'ALREADY_EXISTS' ||
    code === 'already_exists'
  );
}

// ============================================
// TRIGGER: On User Delete - Cleanup
// ============================================
//
// The cleanup lives in `./admin` — it is shared with the admin delete and
// with the scheduled (seven day) deletion, so there is only one
// implementation of "remove this account".
export const onUserDelete = functions.auth.user().onDelete(async (user) => {
  try {
    await deleteUserEverywhere(user.uid);
    console.log(`Cleanup completed for deleted user ${user.uid}`);
  } catch (error) {
    console.error('Error in onUserDelete:', error);
  }
});

// ============================================
// ADMIN: Run a maintenance task on demand
// ============================================
//
// The "Clear Old Notifications" and "Archive Inactive Rooms" buttons in
// Admin → Settings used to be empty `onPressed: () {}` handlers: they
// looked like they worked but did absolutely nothing. These callable
// functions run the very same logic as the scheduled jobs, so the button
// really does what it says.
export const runMaintenanceTask = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // The custom claim may be stale. The live server-side role decides
  // whether this administrator may still perform the operation.
  await assertLiveAdmin(context.auth.uid);

  const task = String(data?.task || '');

  try {
    if (task === 'cleanNotifications') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const timestamp = admin.firestore.Timestamp.fromDate(thirtyDaysAgo);

      // The notifications are deleted **page by page** — a single batch
      // holds at most 500 writes, so a collection with more than 500 old
      // notifications made the whole job fail.
      const deleted = await deleteWhere(() =>
        db.collection('notifications')
          .where('createdAt', '<', timestamp)
          .orderBy('createdAt'),
      );

      if (deleted === 0) {
        return { success: true, message: 'There was nothing to clean' };
      }

      return {
        success: true,
        message: `Deleted ${deleted} old notifications`,
      };
    }

    if (task === 'archiveRooms') {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const timestamp = admin.firestore.Timestamp.fromDate(ninetyDaysAgo);

      // The rooms are archived **page by page** — see above.
      const archived = await updateWhere(
        () =>
          db.collection('rooms')
            .where('status', '==', 'inactive')
            .where('updatedAt', '<', timestamp)
            .orderBy('updatedAt'),
        () => ({ status: 'inactive' }),
      );

      if (archived === 0) {
        return { success: true, message: 'There was nothing to archive' };
      }

      return {
        success: true,
        message: `Archived ${archived} inactive rooms`,
      };
    }

    throw new functions.https.HttpsError(
      'invalid-argument',
      'Unknown maintenance task',
    );
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error running maintenance task:', error);
    throw new functions.https.HttpsError('internal', 'The task could not be run');
  }
});

// ============================================
// SCHEDULED: Archive Inactive Rooms (Daily)
// ============================================
export const archiveInactiveRooms = functions.pubsub
  .schedule('0 3 * * *') // 3 AM daily
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const timestamp = admin.firestore.Timestamp.fromDate(ninetyDaysAgo);

      // The rooms are archived **page by page** — a single batch holds at
      // most 500 writes, so more than 500 inactive rooms made the whole job
      // fail with an `INVALID_ARGUMENT` error.
      const archived = await updateWhere(
        () =>
          db.collection('rooms')
            .where('status', '==', 'inactive')
            .where('updatedAt', '<', timestamp)
            .orderBy('updatedAt'),
        () => ({ status: 'inactive' }),
      );

      console.log(`Archived ${archived} inactive rooms`);
      return null;
    } catch (error) {
      console.error('Error archiving rooms:', error);
      return null;
    }
  });

// ============================================
// SCHEDULED: Clean Old Notifications + Expired OTPs (Daily)
// ============================================
export const cleanOldNotifications = functions.pubsub
  .schedule('0 4 * * *') // 4 AM daily
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const timestamp = admin.firestore.Timestamp.fromDate(thirtyDaysAgo);

      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      // The notifications are deleted **page by page** — a single batch
      // holds at most 500 writes.
      const deletedNotifications = await deleteWhere(() =>
        db.collection('notifications')
          .where('createdAt', '<', timestamp)
          .orderBy('createdAt'),
      );

      if (deletedNotifications === 0) {
        console.log('No old notifications to clean');
      } else {
        console.log(`Deleted ${deletedNotifications} old notifications`);
      }

      // ---------------------------------------------------------------
      // Expired OTP records.
      //
      // Every sign-up writes two `otpCodes` documents (one per channel)
      // and nothing else ever removes them, so the collection grows
      // without bound. Two passes, both using single-field indexes so no
      // composite index is required:
      //
      //   1. anything older than an hour that was never verified is dead
      //      weight (the code itself expires after 5 minutes);
      //   2. anything older than 30 days is removed regardless — by then
      //      the registration it belonged to has long finished.
      //
      // Verified documents are deliberately kept for 30 days because
      // `completeRegistration` and `registerUserRole` re-read them to
      // prove the address was really verified.
      // ---------------------------------------------------------------
      const oneHourAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);

      const deletedUnverified = await deleteWhere(
        () =>
          db.collection('otpCodes')
            .where('createdAt', '<', oneHourAgo)
            .orderBy('createdAt'),
        // Only the documents that were **never** verified are deleted — the
        // verified ones are kept for 30 days, because they are the proof
        // that the address really was verified.
        (doc) => doc.get('verified') !== true,
      );
      console.log(`Deleted ${deletedUnverified} expired OTP records`);

      const deletedAncient = await deleteWhere(() =>
        db.collection('otpCodes')
          .where('createdAt', '<', timestamp)
          .orderBy('createdAt'),
      );
      console.log(`Deleted ${deletedAncient} ancient OTP records`);

      // ---------------------------------------------------------------
      // The locks of the transaction references.
      //
      // One document is written for every payment attempt, and it is
      // never removed — so the collection would grow without bound. The
      // lock only has to outlive the payment itself; after 90 days the
      // booking it belongs to is long finished and the reference cannot
      // be replayed any more (the request is not open any more either).
      // ---------------------------------------------------------------
      const ninetyDaysAgoTimestamp = admin.firestore.Timestamp.fromDate(
        ninetyDaysAgo,
      );
      const deletedReferences = await deleteWhere(() =>
        db.collection('paymentReferences')
          .where('createdAt', '<', ninetyDaysAgoTimestamp)
          .orderBy('createdAt'),
      );
      console.log(
        `Deleted ${deletedReferences} old transaction reference locks`,
      );

      // ---------------------------------------------------------------
      // The quota of the OTP sources.
      //
      // The quota counts the sends of **one hour** — when the window is
      // over the counter starts at zero again, so a quota document of an
      // old window is dead weight. It is deleted as soon as the window it
      // belongs to is over (two hours are enough to be on the safe side).
      // ---------------------------------------------------------------
      const twoHoursAgo = admin.firestore.Timestamp.fromMillis(
        Date.now() - 2 * 60 * 60 * 1000,
      );
      const deletedQuotas = await deleteWhere(() =>
        db.collection('otpSendQuota')
          .where('windowStart', '<', twoHoursAgo)
          .orderBy('windowStart'),
      );
      console.log(`Deleted ${deletedQuotas} expired OTP source quotas`);

      // ---------------------------------------------------------------
      // The locks of the booking requests.
      //
      // A lock points at the request that created it. It may only be
      // deleted when that request is **over** — a lock of a request that
      // is still open would let the student send a second request for the
      // same room, which is exactly what the lock is there to prevent.
      //
      // A request that was cancelled or declined is over, and a request
      // that no longer exists at all is over as well.
      // ---------------------------------------------------------------
      const OVER_STATUSES = ['cancelled', 'rejected'];
      const deletedLocks = await deleteWhereAsync(
        () =>
          db.collection('joinRequestLocks')
            .where('updatedAt', '<', ninetyDaysAgoTimestamp)
            .orderBy('updatedAt'),
        async (lock) => {
          const requestId = String(lock.get('requestId') || '');
          if (!requestId) return true;

          const request = await db.collection('joinRequests').doc(requestId).get();
          if (!request.exists) return true;

          return OVER_STATUSES.indexOf(String(request.get('status') || '')) >= 0;
        },
      );
      console.log(`Deleted ${deletedLocks} locks of over booking requests`);

      return null;
    } catch (error) {
      console.error('Error cleaning notifications:', error);
      return null;
    }
  });