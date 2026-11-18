import * as firestore from 'firebase-admin/firestore';
import * as messaging from 'firebase-admin/messaging';
import * as functions from 'firebase-functions/v1';
import { callableHttps } from './appCheck';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = firestore.getFirestore();

/**
 * Notifications.
 *
 * There is exactly **one** implementation of "tell the user something", and
 * every part of the backend uses it. Before this module existed each file
 * had its own copy of the `notify` helper, which is how the booking
 * notifications and the payment notifications ended up looking (and
 * behaving) differently.
 *
 * A notification is delivered in two ways:
 *
 *  1. **In the app** — a document in the `notifications` collection. The
 *     notification screen and the unread badge read it.
 *  2. **As a push message** — when the device registered its FCM token, the
 *     message is pushed as well, so the user is told even when the app is
 *     closed. Without this the user only found out about a booking when they
 *     happened to open the app.
 */

/** The kinds of notification the app knows about. */
export type NotificationType =
  | 'joinRequest'
  | 'joinConfirmed'
  | 'invoicePaid'
  | 'adminReview'
  | 'newMessage'
  | 'account'
  | 'review'
  | 'general';

/**
 * Whether a profile may still receive a notification.
 *
 * The live profile is read in the same transaction as every notification
 * write. An account-deletion fence therefore conflicts with a delayed
 * notification: either the notification commits first and is removed by the
 * cleanup, or the fence commits first and the notification is refused.
 */
export function notificationRecipientAllows(
  snapshot: firestore.DocumentSnapshot,
  type: NotificationType | string,
): boolean {
  if (!snapshot.exists) return false;

  const deletionState = String(snapshot.get('deletionState') || '').trim();
  if (deletionState === 'deleting' || snapshot.get('deletionFencedAt')) {
    return false;
  }

  // Account notices are the one exception: the profile is deliberately
  // inactive while a deletion is scheduled or being restored. Every other
  // notification belongs to a live account.
  if (type === 'account') return true;
  return snapshot.get('isActive') === true;
}

/** The server-owned fields of one in-app notification. */
export function notificationDocumentData(
  userId: string,
  title: string,
  body: string,
  type: NotificationType | string,
  data: Record<string, string> = {},
): Record<string, unknown> {
  return {
    userId,
    title,
    body,
    type,
    data,
    read: false,
    createdAt: firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * Writes an in-app notification and pushes it to the device.
 *
 * Never throws — a notification that cannot be delivered must never break
 * the action that triggered it (a booking, a payment, …). The return value
 * says whether the in-app notification was actually committed, so a caller
 * never sends a push for a notification which was rejected by the deletion
 * fence.
 */
export async function notify(
  userId: string,
  title: string,
  body: string,
  type: NotificationType | string,
  data: Record<string, string> = {},
): Promise<boolean> {
  if (!userId) return false;

  const notificationRef = db.collection('notifications').doc();
  let written = false;
  try {
    written = await db.runTransaction(async (transaction) => {
      const profileSnapshot = await transaction.get(
        db.collection('users').doc(userId),
      );
      if (!notificationRecipientAllows(profileSnapshot, type)) return false;

      transaction.set(
        notificationRef,
        notificationDocumentData(userId, title, body, type, data),
      );
      return true;
    });
  } catch (error) {
    console.error('Failed to write notification:', error);
    return false;
  }

  if (!written) return false;

  // The type is part of the payload of the push message.
  //
  // It used to be read from `data['type']` — but `data` never holds the
  // type, it only holds the **payload** of the notification (`requestId`,
  // `roomId`, …). Every push message therefore said `general`, and the app
  // could not tell which screen the notification belonged to.
  await pushToDevice(userId, title, body, { ...data, type: String(type) });
  return true;
}

/**
 * Sends the push message — when the device token is known.
 *
 * The token is written to the profile by the app when it signs in
 * (`users/{uid}.fcmToken`), and it is refreshed whenever Firebase rotates
 * it.
 */
export async function pushToDevice(
  userId: string,
  title: string,
  body: string,
  data: Record<string, string> = {},
): Promise<void> {
  try {
    const snapshot = await db.collection('users').doc(userId).get();
    if (!snapshot.exists) return;

    // Do not push a notification which was queued before the recipient's
    // account was deleted. The in-app write has the same fence, but FCM is a
    // separate system and needs the same live-profile check here.
    const deletionState = String(snapshot.get('deletionState') || '').trim();
    if (deletionState === 'deleting' || snapshot.get('deletionFencedAt')) {
      return;
    }
    const type = String(data['type'] || 'general');
    if (type !== 'account' && snapshot.get('isActive') !== true) return;

    const token = snapshot.get('fcmToken');
    if (typeof token !== 'string' || token.trim().length === 0) {
      // The app has not registered a device yet (or it is an old install).
      // The in-app notification is still there, so this is not an error.
      return;
    }

    await messaging.getMessaging().send({
      token: token.trim(),
      notification: { title, body },
      data: {
        ...data,
        title,
        body,
        // The type tells the app which screen the notification belongs to.
        // It is always a string — FCM only accepts strings in the data
        // payload.
        type: String(data['type'] ?? 'general'),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'stayserve_notifications',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
    });
  } catch (error) {
    // A token that Firebase no longer knows about is normal — it happens
    // every time an app is uninstalled. The in-app notification still
    // reached the user, so this is only logged.
    console.error('Failed to push notification:', error);
  }
}

/**
 * Notifies several users with the same message.
 *
 * Used when a booking touches more than one party (the student and the
 * owner both have to know what happened).
 */
export async function notifyAll(
  userIds: string[],
  title: string,
  body: string,
  type: NotificationType | string,
  data: Record<string, string> = {},
): Promise<void> {
  await Promise.all(
    userIds.filter((uid) => !!uid).map((uid) => notify(uid, title, body, type, data)),
  );
}

/**
 * Deletes one of the caller's own notifications.
 *
 * Firestore rules deliberately allow clients to change only the read
 * bookkeeping of a notification. Creation, routing/content and deletion are
 * server-owned, so the delete goes through this callable instead of a direct
 * client write.
 */
export const deleteNotification = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }

    const uid = context.auth.uid;
    const notificationId = String(data?.notificationId || '').trim();
    if (!notificationId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Missing notification',
      );
    }

    const notificationRef = db.collection('notifications').doc(notificationId);
    const deleted = await db.runTransaction(async (transaction) => {
      // The live profile and the notification are read in the same
      // transaction as the delete. A ban or deletion fence which commits
      // first therefore rejects the late delete.
      const profileSnapshot = await transaction.get(
        db.collection('users').doc(uid),
      );
      if (
        !profileSnapshot.exists ||
        profileSnapshot.get('registrationCompleted') !== true ||
        profileSnapshot.get('isActive') !== true
      ) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'This account is not allowed to delete notifications.',
        );
      }

      const snapshot = await transaction.get(notificationRef);
      if (!snapshot.exists) return false;

      if (String(snapshot.get('userId') || '') !== uid) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'You can only delete your own notifications',
        );
      }

      transaction.delete(notificationRef);
      return true;
    });

    return { success: true, deleted };
  },
);
