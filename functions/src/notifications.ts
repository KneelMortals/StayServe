import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import { assertActiveAccount } from './accounts';

const db = admin.firestore();

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
 * Writes an in-app notification and pushes it to the device.
 *
 * Never throws — a notification that cannot be delivered must never break
 * the action that triggered it (a booking, a payment, …).
 */
export async function notify(
  userId: string,
  title: string,
  body: string,
  type: NotificationType | string,
  data: Record<string, string> = {},
): Promise<void> {
  if (!userId) return;

  try {
    await db.collection('notifications').add({
      userId,
      title,
      body,
      type,
      data,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('Failed to write notification:', error);
  }

  // The type is part of the payload of the push message.
  //
  // It used to be read from `data['type']` — but `data` never holds the
  // type, it only holds the **payload** of the notification (`requestId`,
  // `roomId`, …). Every push message therefore said `general`, and the app
  // could not tell which screen the notification belonged to.
  await pushToDevice(userId, title, body, { ...data, type: String(type) });
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
    const token = snapshot.get('fcmToken');
    if (typeof token !== 'string' || token.trim().length === 0) {
      // The app has not registered a device yet (or it is an old install).
      // The in-app notification is still there, so this is not an error.
      return;
    }

    await admin.messaging().send({
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
export const deleteNotification = functions.https.onCall(
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

    await assertActiveAccount(uid);

    const notificationRef = db.collection('notifications').doc(notificationId);
    const snapshot = await notificationRef.get();
    if (!snapshot.exists) {
      return { success: true, deleted: false };
    }

    if (String(snapshot.get('userId') || '') !== uid) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'You can only delete your own notifications',
      );
    }

    await notificationRef.delete();
    return { success: true, deleted: true };
  },
);
