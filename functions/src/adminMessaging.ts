import * as functions from 'firebase-functions/v1';
import * as firestore from 'firebase-admin/firestore';
import * as crypto from 'crypto';

import { callableHttps } from './appCheck';
import {
  assertLiveAdmin,
  assertLiveVerifiedPhone,
  canActAsAdmin,
} from './accounts';
import {
  canActAsRoomOwner,
  canBookAsStudent,
} from './bookingAccess';
import {
  notificationDocumentData,
  notificationRecipientAllows,
  pushToDevice,
} from './notifications';
import { profileDisplayName, safeDisplayText } from './interactions';
import {
  ADMIN_SUPPORT_CONVERSATION_OPERATIONS,
  adminSupportIdentityFor,
  scrubAdministratorMessageIdentities,
} from './adminSupport';

export {
  ADMIN_SUPPORT_CONVERSATION_OPERATIONS,
  adminSupportIdentityFor,
} from './adminSupport';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = firestore.getFirestore();

/** The longest admin message the server accepts. */
export const MAX_ADMIN_MESSAGE_LENGTH = 1000;

/**
 * The durable delivery/attribution record of an administrator message.
 *
 * The record is server-only. Keeping the author and recipient uids out of
 * the notification document means a recipient can read their notification
 * without learning the administrator's uid. Account cleanup can still find
 * every attributable copy through this collection.
 */
export const ADMIN_MESSAGE_NOTIFICATION_OPERATIONS =
  'adminMessageNotificationOperations';

/** The deterministic notification id of one administrator message. */
export function adminMessageNotificationId(messageId: string): string {
  return `admin-message-${crypto
    .createHash('sha256')
    .update(`admin-message:${messageId.trim()}`)
    .digest('hex')}`;
}

/**
 * The deterministic id of the support conversation between an administrator
 * and one account.
 *
 * A prefix keeps it disjoint from the ordinary student-owner conversation
 * ids, which are simply the two sorted uids joined with an underscore.
 */
export function adminConversationId(adminUid: string, targetUid: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${adminUid.trim()}:${targetUid.trim()}`)
    .digest('hex');
  return `ADMIN-${digest.slice(0, 40)}`;
}

/** Whether a live profile may receive an administrator support message. */
function canReceiveAdminMessage(profile: firestore.DocumentSnapshot): boolean {
  const state = {
    exists: profile.exists,
    registrationCompleted: profile.get('registrationCompleted'),
    isActive: profile.get('isActive'),
    role: profile.get('role'),
    phoneVerified: profile.get('phoneVerified'),
  };
  return canBookAsStudent(state) || canActAsRoomOwner(state);
}

/** The immutable fields of one administrator-message delivery operation. */
function adminMessageOperationData(options: {
  adminUid: string;
  adminIdentity: string;
  targetUid: string;
  conversationId: string;
  messageId: string;
}): Record<string, unknown> {
  const notificationId = adminMessageNotificationId(options.messageId);
  return {
    operationId: options.messageId,
    notificationId,
    messageId: options.messageId,
    conversationId: options.conversationId,
    recipientId: options.targetUid,
    sourceAuthorUid: options.adminUid,
    sourceRecipientUid: options.targetUid,
    sourceType: 'adminMessage',
    adminIdentity: options.adminIdentity,
    title: 'StayServe Admin',
    // The message text deliberately stays in the conversation. A copied
    // excerpt in a notification would survive the deletion of either party
    // and disclose private support content.
    body: 'You have a new support message.',
    type: 'newMessage',
    data: {
      conversationId: options.conversationId,
      messageId: options.messageId,
    },
    createdAt: firestore.FieldValue.serverTimestamp(),
    updatedAt: firestore.FieldValue.serverTimestamp(),
  };
}

/** The server-only identity and party record of one support channel. */
function adminSupportConversationOperationData(options: {
  adminUid: string;
  adminIdentity: string;
  targetUid: string;
  conversationId: string;
}): Record<string, unknown> {
  return {
    operationId: options.conversationId,
    conversationId: options.conversationId,
    adminUid: options.adminUid,
    adminIdentity: options.adminIdentity,
    targetUid: options.targetUid,
    sourceType: 'adminSupportConversation',
    createdAt: firestore.FieldValue.serverTimestamp(),
    updatedAt: firestore.FieldValue.serverTimestamp(),
  };
}

/**
 * Creates the in-app notification and attempts the device push.
 *
 * Both steps are idempotent and are represented by a durable operation. A
 * retry of the original `sendAdminMessage` request therefore repairs a
 * failed in-app write or FCM delivery instead of silently treating the
 * already-stored message as fully delivered.
 */
async function deliverAdminMessageNotification(options: {
  adminUid: string;
  targetUid: string;
  conversationId: string;
  messageId: string;
}): Promise<void> {
  const operationRef = db
    .collection(ADMIN_MESSAGE_NOTIFICATION_OPERATIONS)
    .doc(options.messageId);
  const notificationId = adminMessageNotificationId(options.messageId);
  const notificationRef = db.collection('notifications').doc(notificationId);
  const title = 'StayServe Admin';
  const body = 'You have a new support message.';
  const pushData = {
    conversationId: options.conversationId,
    messageId: options.messageId,
  };

  const claim = await db.runTransaction(async (transaction) => {
    const [operationSnapshot, authorSnapshot, recipientSnapshot, notificationSnapshot] =
      await Promise.all([
        transaction.get(operationRef),
        transaction.get(db.collection('users').doc(options.adminUid)),
        transaction.get(db.collection('users').doc(options.targetUid)),
        transaction.get(notificationRef),
      ]);

    if (!operationSnapshot.exists) return null;

    const operation = operationSnapshot.data() as Record<string, any>;
    if (
      String(operation.sourceAuthorUid || '') !== options.adminUid ||
      String(operation.sourceRecipientUid || '') !== options.targetUid ||
      String(operation.recipientId || '') !== options.targetUid ||
      String(operation.messageId || '') !== options.messageId ||
      String(operation.conversationId || '') !== options.conversationId ||
      String(operation.notificationId || '') !== notificationId
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The administrator-message notification operation is malformed.',
      );
    }

    // Both parties are fenced again. A delayed retry can therefore never
    // create a notification after the administrator was demoted/deleted or
    // after the recipient entered the account-deletion fence.
    if (
      !canActAsAdmin({
        exists: authorSnapshot.exists,
        registrationCompleted: authorSnapshot.get('registrationCompleted'),
        isActive: authorSnapshot.get('isActive'),
        role: authorSnapshot.get('role'),
      })
    ) {
      return null;
    }
    if (!notificationRecipientAllows(recipientSnapshot, 'newMessage')) {
      return null;
    }

    if (notificationSnapshot.exists) {
      const notification = notificationSnapshot.data() as Record<string, any>;
      if (String(notification.userId || '') !== options.targetUid) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The administrator-message notification is malformed.',
        );
      }
    } else {
      transaction.set(
        notificationRef,
        notificationDocumentData(
          options.targetUid,
          title,
          body,
          'newMessage',
          pushData,
        ),
      );
    }

    const now = Date.now();
    const deliveryState = String(operation.pushDeliveryState || 'pending');
    const leaseUntil = operation.pushDeliveryLeaseUntil;
    const leaseMillis =
      leaseUntil &&
      typeof leaseUntil === 'object' &&
      typeof (leaseUntil as { toMillis?: unknown }).toMillis === 'function'
        ? Number((leaseUntil as { toMillis: () => number }).toMillis())
        : 0;
    const pushAlreadyDelivered = deliveryState === 'delivered';
    const pushLeaseIsActive = deliveryState === 'delivering' && leaseMillis > now;
    const attemptId = pushAlreadyDelivered || pushLeaseIsActive
      ? ''
      : crypto.randomUUID();

    transaction.update(operationRef, {
      inAppCreatedAt:
        operation.inAppCreatedAt || firestore.FieldValue.serverTimestamp(),
      pushDeliveryState: attemptId ? 'delivering' : deliveryState || 'pending',
      pushDeliveryLeaseUntil: attemptId
        ? firestore.Timestamp.fromMillis(now + 60_000)
        : leaseUntil || null,
      pushAttemptId: attemptId || operation.pushAttemptId || null,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });

    return attemptId || null;
  });

  if (!claim) return;

  const pushed = await pushToDevice(
    options.targetUid,
    title,
    body,
    { ...pushData, type: 'newMessage' },
    { sourceAuthorUid: options.adminUid },
  );

  await db.runTransaction(async (transaction) => {
    const operationSnapshot = await transaction.get(operationRef);
    if (!operationSnapshot.exists) return;
    const operation = operationSnapshot.data() as Record<string, any>;
    if (String(operation.pushAttemptId || '') !== claim) return;

    transaction.update(operationRef, {
      pushDeliveryState: pushed ? 'delivered' : 'pending',
      pushDeliveredAt: pushed
        ? firestore.FieldValue.serverTimestamp()
        : operation.pushDeliveredAt || null,
      pushDeliveryLeaseUntil: null,
      pushAttemptId: null,
      lastPushError: pushed ? null : 'The device push could not be delivered.',
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
  });
}

/**
 * Sends a message from a live administrator to a student or room owner.
 *
 * The whole operation is server-owned. The client supplies only the target
 * uid and the message text; it cannot choose the sender, the participant
 * list, the verified-admin marker or the conversation id.
 *
 * The marker is deliberately absent from the ordinary client message schema.
 * A user can therefore neither create an admin-looking message nor add the
 * badge to somebody else's message.
 */
export const sendAdminMessage = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Please sign in before sending a message.',
    );
  }

  const adminUid = context.auth.uid;

  // Reject a forged administrator before looking up the target. Otherwise a
  // tenant could use this callable as an oracle for another account's live
  // phone-verification state.
  await assertLiveAdmin(adminUid);

  const targetUid = String(data?.userId || '').trim();
  const content = String(data?.content || '').trim();
  const clientRequestId = String(data?.requestId || '').trim();
  if (!clientRequestId || clientRequestId.length > 128) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Invalid message request id',
    );
  }

  if (!targetUid || targetUid.length > 128) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid recipient');
  }
  if (targetUid === adminUid) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'You cannot send an administrator message to yourself.',
    );
  }
  if (!content) {
    throw new functions.https.HttpsError('invalid-argument', 'Enter a message');
  }
  if (content.length > MAX_ADMIN_MESSAGE_LENGTH) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `A message can be at most ${MAX_ADMIN_MESSAGE_LENGTH} characters long`,
    );
  }

  const conversationId = adminConversationId(adminUid, targetUid);
  const conversationRef = db.collection('conversations').doc(conversationId);
  const messageId = `MSG-${crypto
    .createHash('sha256')
    .update(`${adminUid}:${targetUid}:${clientRequestId}`)
    .digest('hex')
    .slice(0, 48)}`;
  const messageRef = conversationRef.collection('messages').doc(messageId);
  const operationRef = db
    .collection(ADMIN_MESSAGE_NOTIFICATION_OPERATIONS)
    .doc(messageId);
  const conversationOperationRef = db
    .collection(ADMIN_SUPPORT_CONVERSATION_OPERATIONS)
    .doc(conversationId);
  const adminIdentity = adminSupportIdentityFor(adminUid);
  const identityProfileRef = db.collection('users').doc(adminIdentity);
  const participants = [adminIdentity, targetUid].sort();
  const legacyParticipants = [adminUid, targetUid].sort();

  // The cached profile can still say that a phone was verified after the
  // provider was unlinked in Firebase Auth. A support message is sensitive,
  // so the recipient's live identity is checked before the message is stored.
  await assertLiveVerifiedPhone(targetUid);

  const result = await db.runTransaction(async (transaction) => {
    const [
      adminSnapshot,
      targetSnapshot,
      conversationSnapshot,
      existingMessageSnapshot,
      existingOperationSnapshot,
      conversationOperationSnapshot,
    ] = await Promise.all([
      transaction.get(db.collection('users').doc(adminUid)),
      transaction.get(db.collection('users').doc(targetUid)),
      transaction.get(conversationRef),
      transaction.get(messageRef),
      transaction.get(operationRef),
      transaction.get(conversationOperationRef),
    ]);

    if (
      !canActAsAdmin({
        exists: adminSnapshot.exists,
        registrationCompleted: adminSnapshot.get('registrationCompleted'),
        isActive: adminSnapshot.get('isActive'),
        role: adminSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Admin access required',
      );
    }
    if (!canReceiveAdminMessage(targetSnapshot)) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'This account is not available for administrator messages.',
      );
    }

    const targetName =
      profileDisplayName(targetSnapshot) ||
      safeDisplayText(targetSnapshot.get('email'), 80).split('@')[0] ||
      targetUid;

    const operationData = adminMessageOperationData({
      adminUid,
      adminIdentity,
      targetUid,
      conversationId,
      messageId,
    });
    const conversationOperationData = adminSupportConversationOperationData({
      adminUid,
      adminIdentity,
      targetUid,
      conversationId,
    });

    if (conversationOperationSnapshot.exists) {
      const existingConversationOperation =
        conversationOperationSnapshot.data() as Record<string, any>;
      if (
        String(existingConversationOperation.adminUid || '') !== adminUid ||
        String(existingConversationOperation.targetUid || '') !== targetUid ||
        String(existingConversationOperation.conversationId || '') !==
          conversationId
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The administrator conversation operation is malformed.',
        );
      }
    }

    if (conversationSnapshot.exists) {
      if (conversationSnapshot.get('deletionInProgress') === true) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This administrator conversation is being deleted.',
        );
      }

      const existingParticipants = Array.from(
        new Set(
          (conversationSnapshot.get('participantIds') || []) as string[],
        ),
      ).sort();
      const usesOpaqueIdentity =
        existingParticipants.length === 2 &&
        existingParticipants[0] === participants[0] &&
        existingParticipants[1] === participants[1] &&
        conversationSnapshot.get('adminId') === adminIdentity;
      const usesLegacyAdminUid =
        existingParticipants.length === 2 &&
        existingParticipants[0] === legacyParticipants[0] &&
        existingParticipants[1] === legacyParticipants[1] &&
        conversationSnapshot.get('adminId') === adminUid;
      if (
        (!usesOpaqueIdentity && !usesLegacyAdminUid) ||
        conversationSnapshot.get('conversationType') !== 'adminSupport'
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This administrator conversation is malformed.',
        );
      }
    }

    const unreadValue = conversationSnapshot.get('unreadCount');
    const unread: Record<string, number> = {};
    if (
      unreadValue &&
      typeof unreadValue === 'object' &&
      !Array.isArray(unreadValue)
    ) {
      for (const [participant, value] of Object.entries(
        unreadValue as Record<string, unknown>,
      )) {
        if (
          participant !== adminUid &&
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= 0
        ) {
          unread[participant] = Math.floor(value);
        }
      }
    }

    // The nested alias is not a top-level user profile and is not readable by
    // a client. It lets the trusted server resolve the opaque support
    // identity without putting the real administrator uid in a tenant-readable
    // conversation.
    transaction.set(
      identityProfileRef,
      {
        uid: adminIdentity,
        role: 'admin',
        roleClaimed: true,
        registrationCompleted: true,
        isActive: true,
        name: 'StayServe Admin',
        identityType: 'adminSupportIdentity',
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      conversationOperationRef,
      {
        ...conversationOperationData,
        createdAt: conversationOperationSnapshot.exists
          ? conversationOperationSnapshot.get('createdAt')
          : firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    if (existingMessageSnapshot.exists) {
      const existingMessage = existingMessageSnapshot.data() as Record<string, any>;
      const existingSenderId = String(existingMessage.senderId || '');
      if (
        (existingSenderId !== adminUid && existingSenderId !== adminIdentity) ||
        String(existingMessage.receiverId || '') !== targetUid ||
        String(existingMessage.content || '') !== content
      ) {
        throw new functions.https.HttpsError(
          'already-exists',
          'That request id was already used for a different message.',
        );
      }

      if (existingOperationSnapshot.exists) {
        const existingOperation = existingOperationSnapshot.data() as Record<string, any>;
        if (
          String(existingOperation.sourceAuthorUid || '') !== adminUid ||
          String(existingOperation.sourceRecipientUid || '') !== targetUid ||
          String(existingOperation.messageId || '') !== messageId
        ) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'The administrator-message notification operation is malformed.',
          );
        }
      } else {
        transaction.set(operationRef, operationData);
      }

      // Scrub the raw administrator uid from a legacy recipient-readable
      // conversation and message when the idempotent request is retried.
      transaction.update(conversationRef, {
        participantIds: participants,
        participantNames: {
          [adminIdentity]: 'StayServe Admin',
          [targetUid]: targetName,
        },
        conversationType: 'adminSupport',
        adminId: adminIdentity,
        adminVerified: true,
        unreadCount: unread,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
      transaction.update(messageRef, {
        senderId: adminIdentity,
        receiverId: targetUid,
        senderType: 'admin',
        adminVerified: true,
        adminId: adminIdentity,
      });

      return {
        success: true,
        conversationId,
        messageId,
        adminIdentity,
        peerId: targetUid,
        peerName: targetName,
        peerRole: String(targetSnapshot.get('role') || '').trim().toLowerCase(),
        alreadySent: true,
      };
    }

    unread[targetUid] = (unread[targetUid] ?? 0) + 1;
    unread[adminIdentity] = unread[adminIdentity] ?? 0;

    const conversation = {
      conversationId,
      participantIds: participants,
      participantNames: {
        [adminIdentity]: 'StayServe Admin',
        [targetUid]: targetName,
      },
      conversationType: 'adminSupport',
      adminId: adminIdentity,
      adminVerified: true,
      roomId: '',
      roomTitle: 'StayServe Support',
      createdByServer: true,
      lastMessage: content,
      lastMessageAt: firestore.FieldValue.serverTimestamp(),
      createdAt: conversationSnapshot.exists
        ? conversationSnapshot.get('createdAt')
        : firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
      unreadCount: unread,
    };

    if (conversationSnapshot.exists) {
      transaction.update(conversationRef, conversation);
    } else {
      transaction.set(conversationRef, conversation);
    }
    transaction.set(messageRef, {
      messageId,
      conversationId,
      senderId: adminIdentity,
      receiverId: targetUid,
      content,
      type: 'text',
      senderType: 'admin',
      adminVerified: true,
      adminId: adminIdentity,
      createdAt: firestore.FieldValue.serverTimestamp(),
      readAt: null,
      roomId: '',
      imageUrl: null,
    });
    transaction.set(operationRef, operationData);

    return {
      success: true,
      conversationId,
      messageId,
      adminIdentity,
      peerId: targetUid,
      peerName: targetName,
      peerRole: String(targetSnapshot.get('role') || '').trim().toLowerCase(),
      alreadySent: false,
    };
  });

  // The transaction has already moved the conversation parent to the opaque
  // identity. Repair every older message in the channel before the
  // notification is delivered, so no recipient-readable support record keeps
  // the administrator's raw uid.
  await scrubAdministratorMessageIdentities({
    db,
    conversationRef,
    adminUid,
    adminIdentity,
  });

  try {
    // A failed notification is repairable by retrying the same request. It
    // must not make the administrator believe that the stored message was
    // lost, so delivery errors do not fail the callable.
    await deliverAdminMessageNotification({
      adminUid,
      targetUid,
      conversationId,
      messageId,
    });
  } catch (error) {
    console.error('Could not deliver the admin-message notification:', error);
  }

  return result;
});
