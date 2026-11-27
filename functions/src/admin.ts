import * as functions from 'firebase-functions/v1';
import { callableHttps } from './appCheck';
import * as firestore from 'firebase-admin/firestore';
import * as authSdk from 'firebase-admin/auth';
import * as storage from 'firebase-admin/storage';
import * as crypto from 'crypto';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import {
  assertLiveAdmin,
  canActAsAdmin,
  readUserProfilesInPathOrder,
} from './accounts';
import { isActiveBookingStatus } from './bookings';
import { paymentAlreadyMade } from './bookingAccess';
import { BATCH_SIZE, deleteWhere, PAGE_SIZE } from './batches';
import {
  notificationDocumentData,
  notificationRecipientAllows,
  notify,
  pushToDevice,
} from './notifications';
import { isValidCurrentOccupancy } from './roomValidation';
import {
  ROOM_DRAFTS_COLLECTION,
  ROOM_LISTINGS_COLLECTION,
} from './roomListings';
import {
  ADMIN_MESSAGE_NOTIFICATION_OPERATIONS,
  ADMIN_SUPPORT_CONVERSATION_OPERATIONS,
  ADMIN_SUPPORT_REPLY_NOTIFICATION_OPERATIONS,
  adminMessageNotificationId,
  adminSupportIdentityFor,
} from './adminMessaging';
import {
  NOTIFICATION_ATTRIBUTIONS,
  reviewInstanceIdFor,
  reviewNotificationId,
} from './reviews';
import { REGISTRATION_ROLLBACK_OPERATIONS } from './otp';
import { ROOM_PHOTO_BUCKET } from './roomMedia';
import { PHONE_VERIFICATION_PROOFS } from './verifiedPhone';

const db = firestore.getFirestore();
const auth = authSdk.getAuth();

/** The deterministic id of one contact's OTP record. */
function otpDocumentId(channel: 'email' | 'mobile', identifier: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(identifier.trim().toLowerCase())
    .digest('hex');
  return `${channel}_${digest}`;
}

/** An account deletion which cannot safely erase live booking data yet. */
export class AccountDeletionBlockedError extends Error {
  readonly code = 'account-deletion-blocked';

  constructor(message: string) {
    super(message);
    this.name = 'AccountDeletionBlockedError';
  }
}

/**
 * Whether an error means that the deletion is waiting for safe booking data.
 *
 * The code is checked as well as the class so the distinction survives a
 * boundary which serialized the error (for example a queued task).
 */
export function isAccountDeletionBlockedError(error: unknown): boolean {
  return (
    error instanceof AccountDeletionBlockedError ||
    (error as { code?: string })?.code === 'account-deletion-blocked'
  );
}

/**
 * Commits the durable deletion fence for an account.
 *
 * Every booking and payment transition reads the live profiles of both
 * parties in its own transaction. Marking the profile inactive here
 * therefore conflicts with any transition which was already in flight and
 * makes every later transition fail. The safety queries below can then be
 * checked without a gap in which a new request or payment could appear.
 */
async function fenceAccountDeletion(uid: string): Promise<void> {
  const userRef = db.collection('users').doc(uid);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(userRef);
    if (!snapshot.exists) return;

    transaction.update(userRef, {
      isActive: false,
      deletionState: 'deleting',
      deletionFencedAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
  });
}

/**
 * Walks a query in bounded pages.
 *
 * The deletion safety scan used to read every room, request and payment of
 * one account into a single transaction. An account with a long history
 * could make that transaction exceed the request size, the write budget or
 * the transaction time limit. The pages below keep the memory and the
 * transaction size bounded.
 */
async function scanCollectionPages(
  buildQuery: () => firestore.Query,
  inspect: (doc: firestore.QueryDocumentSnapshot) => void,
): Promise<void> {
  let cursor: firestore.QueryDocumentSnapshot | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = buildQuery();
    const snapshot = await (cursor
      ? query.startAfter(cursor)
      : query
    ).limit(PAGE_SIZE).get();
    if (snapshot.empty) break;

    for (const doc of snapshot.docs) inspect(doc);

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }
}

/**
 * Refuses to erase an account which still owns a live tenancy or has money
 * in flight.
 *
 * The durable profile fence is committed first. Every booking and payment
 * transition reads the live profiles of both parties in its own
 * transaction, so a transition which committed before the fence is visible
 * in the scan below and one which starts later observes the inactive
 * profile and is refused.
 *
 * The scan itself runs in bounded pages instead of one unbounded
 * transaction. The fence — not the transaction snapshot — is what closes the
 * race.
 */
async function assertAccountDeletionIsSafe(uid: string): Promise<void> {
  const userRef = db.collection('users').doc(uid);
  await db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    if (!userSnapshot.exists) return;

    transaction.update(userRef, {
      isActive: false,
      deletionState: 'deleting',
      deletionSafetyCheckedAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
  });

  await scanCollectionPages(
    () =>
      db
        .collection('rooms')
        .where('ownerId', '==', uid)
        .orderBy(firestore.FieldPath.documentId()),
    (room) => {
      const occupancy = room.get('currentOccupancy');
      if (!isValidCurrentOccupancy(occupancy)) {
        throw new AccountDeletionBlockedError(
          'A room owned by the account has an invalid occupancy.',
        );
      }
      if (occupancy > 0) {
        throw new AccountDeletionBlockedError(
          'The account still owns a room with an active tenant.',
        );
      }
    },
  );

  for (const field of ['studentId', 'ownerId'] as const) {
    await scanCollectionPages(
      () =>
        db
          .collection('joinRequests')
          .where(field, '==', uid)
          .orderBy(firestore.FieldPath.documentId()),
      (request) => {
        const data = request.data() as Record<string, any>;
        const status = String(data.status || '');
        if (isActiveBookingStatus(status) || paymentAlreadyMade(data)) {
          throw new AccountDeletionBlockedError(
            'The account still has an active booking or a payment waiting for settlement.',
          );
        }
      },
    );

    await scanCollectionPages(
      () =>
        db
          .collection('payments')
          .where(field, '==', uid)
          .orderBy(firestore.FieldPath.documentId()),
      (payment) => {
        const status = String(payment.get('status') || '');
        if (status === 'submitted' || status === 'verified') {
          throw new AccountDeletionBlockedError(
            'The account still has a payment waiting for settlement.',
          );
        }
      },
    );
  }
}

/**
 * The admin surface of the backend.
 *
 * Two things live here that used to live in the client:
 *
 *  - the **admin review** of a booking request, and
 *  - the **deletion of a user account** (with a seven day grace period).
 */

/**
 * Deletes the owner's listings and their deterministic private locations.
 *
 * The private document is addressed by the room's Firestore document id, not
 * only by its `ownerId` field. A corrupt owner id therefore cannot leave an
 * exact address orphaned after the listing is removed.
 *
 * The unpublished drafts are removed as well. They live in their own
 * collection, so a published-only cleanup would leave the unfinished
 * listings of a deleted account behind.
 */
async function deleteOwnerRoomsAndPrivateLocations(uid: string): Promise<void> {
  for (const collection of [ROOM_LISTINGS_COLLECTION, ROOM_DRAFTS_COLLECTION]) {
    let cursor: firestore.QueryDocumentSnapshot | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let query = db
        .collection(collection)
        .where('ownerId', '==', uid)
        .orderBy(firestore.FieldPath.documentId());
      if (cursor) query = query.startAfter(cursor);

      const snapshot = await query.limit(PAGE_SIZE).get();
      if (snapshot.empty) break;

      const roomsPerBatch = Math.max(1, Math.floor(BATCH_SIZE / 2));
      for (
        let index = 0;
        index < snapshot.docs.length;
        index += roomsPerBatch
      ) {
        const batch = db.batch();
        for (const room of snapshot.docs.slice(index, index + roomsPerBatch)) {
          batch.delete(room.ref);
          batch.delete(db.collection('roomPrivate').doc(room.id));
        }
        await batch.commit();
      }

      cursor = snapshot.docs[snapshot.docs.length - 1];
      if (snapshot.size < PAGE_SIZE) break;
    }
  }
}

/**
 * Deletes every conversation of one account without leaving orphaned
 * messages behind.
 *
 * Firestore does not cascade-delete a subcollection. The cleanup therefore
 * marks each conversation as `deletionInProgress` **before** it scans the
 * messages. The Firestore rules reject every new message while that marker
 * is present, so a live conversation partner cannot insert a message between
 * the message scan and the removal of the parent document.
 *
 * The parent is removed only after its messages are gone, and the operation
 * id makes sure that a later replacement of the same conversation is not
 * deleted by an older cleanup step.
 */
/**
 * Removes every notification dependent on one chat message.
 *
 * The recipient-visible copy is removed first. The server-only attribution
 * and delivery records are removed next, and only then may the caller delete
 * the message source. If a server-only delete fails, the message remains and
 * a retry can still discover the operation which belongs to it.
 */
async function deleteNotificationDependentsForMessage(
  messageId: string,
): Promise<void> {
  if (!messageId) return;

  // Legacy notifications identify their source in the recipient-readable
  // data map. Remove those copies first, then discover every deterministic or
  // server-attributed copy which belongs to the same message.
  await deleteNotificationsWithDataValue('messageId', messageId);

  const deterministicNotificationId = adminMessageNotificationId(messageId);
  const attributionSnapshot = await db
    .collection(NOTIFICATION_ATTRIBUTIONS)
    .where('notificationId', '==', deterministicNotificationId)
    .get();
  const sourceAttributionSnapshot = await db
    .collection(NOTIFICATION_ATTRIBUTIONS)
    .where('sourceMessageId', '==', messageId)
    .get();
  const operationSnapshot = await db
    .collection(ADMIN_MESSAGE_NOTIFICATION_OPERATIONS)
    .where('messageId', '==', messageId)
    .get();
  const supportReplyOperationSnapshot = await db
    .collection(ADMIN_SUPPORT_REPLY_NOTIFICATION_OPERATIONS)
    .where('messageId', '==', messageId)
    .get();

  const attributionRecords = [
    ...attributionSnapshot.docs,
    ...sourceAttributionSnapshot.docs,
  ];
  const operationRecords = operationSnapshot.docs;
  const notificationIds = new Set<string>([deterministicNotificationId]);
  for (const record of [
    ...attributionRecords,
    ...operationRecords,
    ...supportReplyOperationSnapshot.docs,
  ]) {
    const notificationId = String(record.get('notificationId') || '').trim();
    if (notificationId) notificationIds.add(notificationId);
  }

  // Every recipient-visible copy is gone before its server-only attribution
  // or delivery record. A failure here leaves the source message in place,
  // so the next retry can discover the remaining dependency again.
  for (const notificationId of notificationIds) {
    await db.collection('notifications').doc(notificationId).delete();
  }

  const serverOnlyRecords = new Map<string, firestore.DocumentReference>();
  for (const record of attributionRecords) {
    serverOnlyRecords.set(record.ref.path, record.ref);
  }
  for (const record of operationRecords) {
    serverOnlyRecords.set(record.ref.path, record.ref);
  }
  for (const record of supportReplyOperationSnapshot.docs) {
    serverOnlyRecords.set(record.ref.path, record.ref);
  }
  serverOnlyRecords.set(
    db
      .collection(NOTIFICATION_ATTRIBUTIONS)
      .doc(deterministicNotificationId)
      .path,
    db.collection(NOTIFICATION_ATTRIBUTIONS).doc(deterministicNotificationId),
  );
  serverOnlyRecords.set(
    db.collection(ADMIN_MESSAGE_NOTIFICATION_OPERATIONS).doc(messageId).path,
    db.collection(ADMIN_MESSAGE_NOTIFICATION_OPERATIONS).doc(messageId),
  );
  serverOnlyRecords.set(
    db
      .collection(ADMIN_SUPPORT_REPLY_NOTIFICATION_OPERATIONS)
      .doc(messageId).path,
    db.collection(ADMIN_SUPPORT_REPLY_NOTIFICATION_OPERATIONS).doc(messageId),
  );

  await Promise.all(
    Array.from(serverOnlyRecords.values()).map((record) => record.delete()),
  );
}

/**
 * Removes conversation-level notification dependents.
 *
 * These records cover notifications which point at the conversation without
 * carrying one exact message id. They are deleted before the conversation
 * parent, and the durable conversation attribution is deleted atomically
 * with that parent in the final cleanup transaction.
 */
async function deleteConversationNotificationDependents(
  conversationId: string,
): Promise<void> {
  if (!conversationId) return;

  await deleteNotificationsWithDataValue('conversationId', conversationId);

  const attributionSnapshot = await db
    .collection(NOTIFICATION_ATTRIBUTIONS)
    .where('sourceConversationId', '==', conversationId)
    .get();
  const operationSnapshot = await db
    .collection(ADMIN_MESSAGE_NOTIFICATION_OPERATIONS)
    .where('conversationId', '==', conversationId)
    .get();
  const supportReplyOperationSnapshot = await db
    .collection(ADMIN_SUPPORT_REPLY_NOTIFICATION_OPERATIONS)
    .where('conversationId', '==', conversationId)
    .get();

  const notificationIds = new Set<string>();
  for (const record of [
    ...attributionSnapshot.docs,
    ...operationSnapshot.docs,
    ...supportReplyOperationSnapshot.docs,
  ]) {
    const notificationId = String(record.get('notificationId') || '').trim();
    if (notificationId) notificationIds.add(notificationId);
  }
  for (const notificationId of notificationIds) {
    await db.collection('notifications').doc(notificationId).delete();
  }

  await Promise.all([
    ...attributionSnapshot.docs.map((document) => document.ref.delete()),
    ...operationSnapshot.docs.map((document) => document.ref.delete()),
    ...supportReplyOperationSnapshot.docs.map((document) => document.ref.delete()),
  ]);
}

/** Deletes one conversation and all of its notification dependents. */
async function deleteConversationForUser(
  uid: string,
  conversationRef: firestore.DocumentReference,
): Promise<void> {
  const conversationId = conversationRef.id;
  const conversationOperationRef = db
    .collection(ADMIN_SUPPORT_CONVERSATION_OPERATIONS)
    .doc(conversationId);
  const operationId = crypto.randomUUID();

  const marked = await db.runTransaction(async (transaction) => {
    const [current, conversationOperation] = await Promise.all([
      transaction.get(conversationRef),
      transaction.get(conversationOperationRef),
    ]);

    if (!current.exists) {
      // A parent and its server-only attribution are normally deleted in one
      // transaction. This branch repairs a legacy/partially-created orphan.
      if (
        conversationOperation.exists &&
        (String(conversationOperation.get('adminUid') || '') === uid ||
          String(conversationOperation.get('targetUid') || '') === uid)
      ) {
        transaction.delete(conversationOperationRef);
      }
      return false;
    }

    const participants = current.get('participantIds');
    const participantMatches =
      Array.isArray(participants) &&
      participants.some((participant) => String(participant) === uid);
    const serverAttributionMatches =
      conversationOperation.exists &&
      (String(conversationOperation.get('adminUid') || '') === uid ||
        String(conversationOperation.get('targetUid') || '') === uid) &&
      String(conversationOperation.get('conversationId') || '') ===
        conversationId;
    if (!participantMatches && !serverAttributionMatches) return false;

    const isAdminSupport =
      String(current.get('conversationType') || '') === 'adminSupport' ||
      String(conversationOperation.get('sourceType') || '') ===
        'adminSupportConversation';

    transaction.update(conversationRef, {
      deletionInProgress: true,
      // A support conversation is readable by its tenant. Never write the
      // real administrator uid into that recipient-visible marker; the raw
      // party mapping remains in the server-only conversation operation.
      deletionRequestedBy: isAdminSupport
        ? adminSupportIdentityFor(uid)
        : uid,
      deletionOperationId: operationId,
      deletionRequestedAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (!marked) return;

  // The marker is committed before this scan. Every message which was
  // committed before the marker is visible to the scan; every later message
  // is rejected by the Firestore rules.
  const messages = await conversationRef
    .collection('messages')
    .orderBy('__name__')
    .get();
  for (const message of messages.docs) {
    await deleteNotificationDependentsForMessage(message.id);
  }
  await deleteWhere(() =>
    conversationRef.collection('messages').orderBy('__name__'),
  );
  await deleteWhere(() =>
    conversationRef.collection('contexts').orderBy('__name__'),
  );

  // Catch a malformed or legacy notification which identifies only the
  // conversation. It must be gone before the parent source is removed.
  await deleteConversationNotificationDependents(conversationId);

  await db.runTransaction(async (transaction) => {
    const [current, conversationOperation] = await Promise.all([
      transaction.get(conversationRef),
      transaction.get(conversationOperationRef),
    ]);
    if (!current.exists) {
      if (
        conversationOperation.exists &&
        (String(conversationOperation.get('adminUid') || '') === uid ||
          String(conversationOperation.get('targetUid') || '') === uid)
      ) {
        transaction.delete(conversationOperationRef);
      }
      return;
    }
    if (current.get('deletionOperationId') !== operationId) return;

    transaction.delete(conversationRef);
    if (
      conversationOperation.exists &&
      String(conversationOperation.get('conversationId') || '') ===
        conversationId
    ) {
      // The conversation and its server-only attribution disappear together.
      // A retry therefore cannot lose the only mapping to an opaque admin
      // conversation before the parent is gone.
      transaction.delete(conversationOperationRef);
    }
  });
}

/**
 * Deletes every conversation of one account without leaving orphaned
 * messages or notification dependencies behind.
 *
 * Firestore does not cascade-delete a subcollection. The cleanup therefore
 * marks each conversation as `deletionInProgress` **before** it scans the
 * messages. The Firestore rules reject every new message while that marker
 * is present, so a live conversation partner cannot insert a message between
 * the message scan and the removal of the parent document.
 *
 * The parent is removed only after its messages, recipient notifications and
 * server-only attribution/delivery records are gone, and the operation id
 * makes sure that a later replacement of the same conversation is not
 * deleted by an older cleanup step.
 */
export async function deleteUserConversations(uid: string): Promise<void> {
  const conversationsQuery = () =>
    db
      .collection('conversations')
      .where('participantIds', 'array-contains', uid)
      .orderBy('__name__');

  let conversationCursor: firestore.QueryDocumentSnapshot | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = conversationsQuery();
    const snapshot = await (conversationCursor
      ? query.startAfter(conversationCursor)
      : query
    ).limit(200).get();
    if (snapshot.empty) break;

    for (const conversation of snapshot.docs) {
      await deleteConversationForUser(uid, conversation.ref);
    }

    conversationCursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < 200) break;
  }

  // New administrator conversations expose only an opaque administrator tick
  // to the tenant. Their raw party uids therefore live in this server-only
  // collection, which is also how an administrator's own conversations are
  // discovered during account cleanup.
  const supportConversationIds = new Set<string>();
  for (const field of ['adminUid', 'targetUid'] as const) {
    await scanCollectionPages(
      () =>
        db
          .collection(ADMIN_SUPPORT_CONVERSATION_OPERATIONS)
          .where(field, '==', uid)
          .orderBy(firestore.FieldPath.documentId()),
      (operation) => {
        const conversationId = String(
          operation.get('conversationId') || '',
        ).trim();
        if (conversationId) supportConversationIds.add(conversationId);
      },
    );
  }
  for (const conversationId of supportConversationIds) {
    await deleteConversationForUser(
      uid,
      db.collection('conversations').doc(conversationId),
    );
  }
}

/** The request states which can still be cancelled without settling money. */
const OPEN_ACCOUNT_DELETION_REQUEST_STATUSES = [
  'pending',
  'ownerConfirmed',
  'studentConfirmed',
];

/**
 * Cancels the open requests of a deleted account and tells the other party.
 *
 * The request document is later removed as part of the account's personal
 * data. It must not disappear silently: the unaffected owner or student
 * still needs to know that the booking will never continue. The recipient
 * profile is read in the same transaction as the cancellation and the
 * notification write, so a concurrent deletion fence either wins (and no
 * late notification is created) or is serialized after this operation.
 */
async function cancelOpenAccountDeletionRequests(uid: string): Promise<number> {
  let cancelledCount = 0;

  for (const field of ['studentId', 'ownerId'] as const) {
    let cursor: firestore.QueryDocumentSnapshot | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let query = db
        .collection('joinRequests')
        .where(field, '==', uid)
        .orderBy(firestore.FieldPath.documentId());
      if (cursor) query = query.startAfter(cursor);

      const snapshot = await query.limit(PAGE_SIZE).get();
      if (snapshot.empty) break;

      for (const requestDoc of snapshot.docs) {
        const cancelled = await db.runTransaction(async (transaction) => {
          const requestSnapshot = await transaction.get(requestDoc.ref);
          if (!requestSnapshot.exists) return false;

          const request = requestSnapshot.data() as Record<string, any>;
          const status = String(request.status || '');
          if (
            OPEN_ACCOUNT_DELETION_REQUEST_STATUSES.indexOf(status) < 0
          ) {
            return false;
          }

          if (
            isActiveBookingStatus(status) ||
            paymentAlreadyMade(request)
          ) {
            throw new AccountDeletionBlockedError(
              'The account still has an active booking or a payment waiting for settlement.',
            );
          }

          const studentId = String(request.studentId || '').trim();
          const ownerId = String(request.ownerId || '').trim();
          const recipientId =
            studentId === uid
              ? ownerId
              : ownerId === uid
                ? studentId
                : '';
          const recipientSnapshot = recipientId
            ? await transaction.get(
                db.collection('users').doc(recipientId),
              )
            : null;

          transaction.update(requestDoc.ref, {
            status: 'cancelled',
            cancelledAt: firestore.FieldValue.serverTimestamp(),
            cancelledBy: uid,
            cancellationReason: 'The booking account was deleted',
            updatedAt: firestore.FieldValue.serverTimestamp(),
          });

          const title = 'Booking request cancelled';
          const body =
            'The other account was deleted, so this booking request was cancelled.';
          const data = {
            requestId: requestDoc.id,
            roomId: String(request.roomId || ''),
          };

          if (
            recipientId &&
            recipientId !== uid &&
            recipientSnapshot &&
            notificationRecipientAllows(recipientSnapshot, 'joinRequest')
          ) {
            const notificationId = `account-deletion-${crypto
              .createHash('sha256')
              .update(`${uid}:${requestDoc.id}:${recipientId}`)
              .digest('hex')}`;
            transaction.set(
              db.collection('notifications').doc(notificationId),
              notificationDocumentData(
                recipientId,
                title,
                body,
                'joinRequest',
                data,
              ),
              { merge: true },
            );
            return {
              cancelled: true as const,
              push: { recipientId, title, body, data },
            };
          }

          return { cancelled: true as const, push: null };
        });

        if (cancelled) {
          cancelledCount += 1;
          if (cancelled.push) {
            // The in-app document is committed by the fenced transaction. The
            // push helper performs its own live-profile check, so a deletion
            // which starts after the commit suppresses the device delivery.
            await pushToDevice(
              cancelled.push.recipientId,
              cancelled.push.title,
              cancelled.push.body,
              { ...cancelled.push.data, type: 'joinRequest' },
            );
          }
        }
      }

      cursor = snapshot.docs[snapshot.docs.length - 1];
      if (snapshot.size < PAGE_SIZE) break;
    }
  }

  return cancelledCount;
}

/** Removes both directions of every personal block involving [uid]. */
async function deletePersonalBlocks(uid: string): Promise<void> {
  // Personal blocks are directional. Remove both the blocks this account
  // created and the blocks other accounts created against it, so a deleted
  // uid can never keep restricting somebody else's interaction.
  //
  // The canonical document path is `userBlocks/{blocker}/blockedUsers/{uid}`.
  // Sweep that path as well as the duplicated `blockedUserId` field: a
  // malformed legacy record whose field disagrees with its path still blocks
  // the surviving participant in the Firestore rules, so it must not survive
  // account deletion.
  await deleteWhere(
    () => db.collectionGroup('blockedUsers').orderBy('__name__'),
    (document) => document.id === uid,
  );
  await deleteWhere(() =>
    db
      .collectionGroup('blockedUsers')
      .where('blockedUserId', '==', uid)
      .orderBy('__name__'),
  );
  await deleteWhere(() =>
    db
      .collection('userBlocks')
      .doc(uid)
      .collection('blockedUsers')
      .orderBy('__name__'),
  );
}

/**
 * Removes legacy notification copies which point at one source record.
 *
 * Older notifications did not have a server-only attribution record. Their
 * `data` map still identifies the exact chat message or review, so account
 * cleanup and moderation can still remove the old copies.
 */
async function deleteNotificationsWithDataValue(
  field: string,
  value: string,
): Promise<void> {
  if (!field || !value) return;
  const snapshot = await db
    .collection('notifications')
    .where(`data.${field}`, '==', value)
    .get();
  await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
}

/**
 * Removes every notification dependent on one review source.
 *
 * The deterministic in-app copy and the legacy copies are removed before the
 * server-only attribution. The attribution is removed last so a failed
 * notification delete cannot make the remaining copy impossible to discover
 * on a retry.
 */
async function deleteReviewNotificationDependents(options: {
  reviewId: string;
  reviewInstanceId: string;
  ownerId: string;
}): Promise<void> {
  if (!options.reviewId) return;

  await deleteNotificationsWithDataValue('reviewId', options.reviewId);

  const notificationId = options.ownerId
    ? reviewNotificationId(
        options.reviewId,
        options.reviewInstanceId,
        options.ownerId,
      )
    : '';
  const attributionSnapshot = await db
    .collection(NOTIFICATION_ATTRIBUTIONS)
    .where('sourceReviewId', '==', options.reviewId)
    .get();
  const lifecycleAttributionSnapshot = options.reviewInstanceId
    ? await db
        .collection(NOTIFICATION_ATTRIBUTIONS)
        .where('sourceId', '==', options.reviewInstanceId)
        .get()
    : { docs: [] as firestore.QueryDocumentSnapshot[] };

  const notificationIds = new Set<string>();
  if (notificationId) notificationIds.add(notificationId);
  for (const record of [
    ...attributionSnapshot.docs,
    ...lifecycleAttributionSnapshot.docs,
  ]) {
    const attributedNotificationId = String(
      record.get('notificationId') || '',
    ).trim();
    if (attributedNotificationId) {
      notificationIds.add(attributedNotificationId);
    }
  }

  // Remove every recipient-visible copy before any server-only attribution.
  // The source review is deleted by the caller only after this helper has
  // completed successfully.
  for (const id of notificationIds) {
    await db.collection('notifications').doc(id).delete();
  }

  const attributionRecords = new Map<
    string,
    firestore.DocumentReference
  >();
  for (const record of [
    ...attributionSnapshot.docs,
    ...lifecycleAttributionSnapshot.docs,
  ]) {
    attributionRecords.set(record.ref.path, record.ref);
  }
  if (notificationId) {
    const deterministicRef = db
      .collection(NOTIFICATION_ATTRIBUTIONS)
      .doc(notificationId);
    attributionRecords.set(deterministicRef.path, deterministicRef);
  }

  await Promise.all(
    Array.from(attributionRecords.values()).map((record) => record.delete()),
  );
}

/**
 * Removes notification copies which are attributable to one account.
 *
 * A notification is normally addressed to only one person, but its server
 * source can involve another participant (for example an administrator who
 * sent a support message, or a student who wrote a review). The source uids
 * live in server-only attribution/delivery records so they are never exposed
 * to the notification recipient.
 *
 * Deleting the account therefore has to remove both the recipient's copy and
 * every copy whose source is the deleted participant.
 */
export async function deleteAttributedNotificationsForUser(
  uid: string,
): Promise<void> {
  if (!uid) return;

  const notificationIds = new Set<string>();
  const serverOnlyRecords: firestore.DocumentReference[] = [];
  const serverOnlyCollections = [
    NOTIFICATION_ATTRIBUTIONS,
    ADMIN_MESSAGE_NOTIFICATION_OPERATIONS,
  ];

  for (const collectionName of serverOnlyCollections) {
    for (const field of ['sourceAuthorUid', 'sourceRecipientUid'] as const) {
      const snapshot = await db
        .collection(collectionName)
        .where(field, '==', uid)
        .get();
      for (const record of snapshot.docs) {
        const notificationId = String(record.get('notificationId') || '').trim();
        if (notificationId) notificationIds.add(notificationId);
        serverOnlyRecords.push(record.ref);
      }
    }
  }

  // Remove the recipient-visible copy first. The server-only mapping is
  // still present at this point, so a transient notification-delete failure
  // can be retried without leaving an untraceable notification behind.
  for (const notificationId of notificationIds) {
    await db.collection('notifications').doc(notificationId).delete();
  }

  // Only after every notification copy is gone may the attribution/delivery
  // records be removed. The order is idempotent and preserves the retry
  // mapping if the first phase fails.
  await Promise.all(serverOnlyRecords.map((record) => record.delete()));
}

/** Deletes every room-photo object below one owner's trusted prefix. */
async function deleteOwnerRoomPhotoObjects(uid: string): Promise<void> {
  const bucket = storage.getStorage().bucket(ROOM_PHOTO_BUCKET);
  const [files] = await bucket.getFiles({ prefix: `rooms/${uid}/` });
  for (const file of files) {
    await file.delete({ ignoreNotFound: true });
  }
}

/**
 * Deletes everything that belongs to a user.
 *
 * The Firestore data is deleted **before** the Auth account — the other way
 * round the account was gone while the personal data (rooms, requests,
 * invoices, notifications, conversations) was still in the database: an
 * orphan nobody could ever clean up.
 */
export async function deleteUserEverywhere(uid: string): Promise<void> {
  // Commit the durable profile fence before taking the safety snapshot.
  // `deleteUserEverywhere` is exported and may be called without going
  // through `enqueueAccountDeletion`, so the fence cannot be assumed here.
  await fenceAccountDeletion(uid);

  // Keep the contact identifiers long enough to remove their deterministic
  // OTP records. The profile itself is removed only after every dependent
  // collection has been cleaned.
  const profileSnapshot = await db.collection('users').doc(uid).get();
  const profile = profileSnapshot.data() as Record<string, any> | undefined;
  const profileEmail = String(profile?.email || '').trim();
  const profilePhone = String(profile?.phone || '').trim();

  // Never erase live booking or payment evidence directly. The durable job
  // keeps this account pending until the other side reaches a safe state.
  await assertAccountDeletionIsSafe(uid);

  // Open requests cannot survive the account deletion, but the unaffected
  // party must not be left waiting for a booking which can no longer
  // continue. They are cancelled and notified before the request documents
  // are removed below.
  await cancelOpenAccountDeletionRequests(uid);

  // Stop the account from being used while the cleanup is in progress. This
  // happens before any related data is deleted, so a partial cleanup cannot
  // leave a fully active account behind.
  try {
    await auth.updateUser(uid, { disabled: true });
    await auth.revokeRefreshTokens(uid);
  } catch (error) {
    if (!isUserNotFound(error)) throw error;
  }

  // Collect the deterministic ids of the records which refer to this
  // account. Some of them cannot be queried by the deleted uid alone (for
  // example an owner-side request lock), but their id can be derived from
  // the booking parties.
  const joinLockIds = new Set<string>();
  for (const field of ['studentId', 'ownerId'] as const) {
    await scanCollectionPages(
      () =>
        db
          .collection('joinRequests')
          .where(field, '==', uid)
          .orderBy(firestore.FieldPath.documentId()),
      (request) => {
        const data = request.data() as Record<string, any>;
        const studentId = String(data.studentId || '').trim();
        const roomId = String(data.roomId || '').trim();
        if (!studentId || !roomId) return;
        joinLockIds.add(
          crypto
            .createHash('sha256')
            .update(`${studentId}:${roomId}`)
            .digest('hex'),
        );
      },
    );
  }

  const paymentReferenceIds = new Set<string>();
  for (const field of ['studentId', 'ownerId'] as const) {
    await scanCollectionPages(
      () =>
        db
          .collection('payments')
          .where(field, '==', uid)
          .orderBy(firestore.FieldPath.documentId()),
      (payment) => {
        const data = payment.data() as Record<string, any>;
        if (data.feeWaived === true) return;
        const reference = String(data.reference || '').trim();
        if (!reference) return;
        paymentReferenceIds.add(
          crypto
            .createHash('sha256')
            .update(reference.toLowerCase())
            .digest('hex'),
        );
      },
    );
  }

  // ---------------------------------------------------------------------
  // Every document of the user is deleted **page by page**.
  //
  // A Firestore batch holds at most 500 writes, and a query without a
  // limit reads everything that matches it into memory. The old code
  // collected *all* references first and deleted them afterwards — so an
  // account with a lot of rooms, requests or messages either blew the
  // memory of the function or left the account half deleted.
  //
  // The helpers in `./batches` walk through the documents in pages of 300
  // and write at most 400 deletions per batch. Nothing is ever held in
  // memory as a whole.
  // ---------------------------------------------------------------------

  // Remove recipient copies and their server-only attribution/delivery
  // records before any of their source records. The notification delete is
  // deliberately first inside the attributed-notification helper so a failed
  // copy removal keeps the attribution available for the next retry.
  await deleteWhere(() =>
    db
      .collection('notifications')
      .where('userId', '==', uid)
      .orderBy('__name__'),
  );
  await deleteAttributedNotificationsForUser(uid);

  // Conversations are sources too. Their messages and notification
  // dependencies are removed while the raw participant mapping is still
  // available, before listings, requests and other source records disappear.
  await deleteUserConversations(uid);

  // A review notification is a dependent of the review source. Remove every
  // deterministic and legacy copy, plus the server-only attribution, before
  // deleting the review itself. A retry can safely repeat each step.
  const reviewsToDelete = new Map<
    string,
    firestore.QueryDocumentSnapshot
  >();
  for (const field of ['studentId', 'ownerId'] as const) {
    const reviews = await db
      .collection('roomReviews')
      .where(field, '==', uid)
      .get();
    for (const review of reviews.docs) {
      if (!reviewsToDelete.has(review.id)) {
        reviewsToDelete.set(review.id, review);
      }
    }
  }
  for (const review of reviewsToDelete.values()) {
    const data = review.data() as Record<string, any>;
    await deleteReviewNotificationDependents({
      reviewId: review.id,
      reviewInstanceId: reviewInstanceIdFor(review),
      ownerId: String(data.ownerId || '').trim(),
    });
    await review.ref.delete();
  }

  // The listings and their deterministic private locations are removed in
  // the same batches. The private document id is the room id, so an
  // inconsistent private ownerId cannot orphan the exact address.
  await deleteOwnerRoomsAndPrivateLocations(uid);

  // The account-deletion path removes the owner's Storage prefix directly.
  // Its listing cleanup records and room-id tombstones are therefore
  // superseded and must not keep the deleted owner's room ids reserved.
  await deleteWhere(() =>
    db
      .collection('cleanupJobs')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );
  await deleteWhere(() =>
    db
      .collection('roomDeletionTombstones')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  // Remove private-location documents which still name this account but no
  // longer have a corresponding listing (for example an old orphan).
  await deleteWhere(() =>
    db.collection('roomPrivate')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  // The join requests — as the student and as the owner.
  await deleteWhere(() =>
    db.collection('joinRequests')
      .where('studentId', '==', uid)
      .orderBy('__name__'),
  );

  await deleteWhere(() =>
    db.collection('joinRequests')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  // The commission invoices — as the owner and as the tenant.
  await deleteWhere(() =>
    db.collection('commissionInvoices')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  await deleteWhere(() =>
    db.collection('commissionInvoices')
      .where('tenantId', '==', uid)
      .orderBy('__name__'),
  );

  // The payment records, so the admin payments list does not keep showing
  // entries for requests that no longer exist.
  await deleteWhere(() =>
    db.collection('payments')
      .where('studentId', '==', uid)
      .orderBy('__name__'),
  );

  await deleteWhere(() =>
    db.collection('payments')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  // Keep the deterministic payment-reference locks (so the same reference
  // cannot be replayed), but remove the plaintext transaction reference from
  // the lock itself.
  for (const referenceId of paymentReferenceIds) {
    await db.collection('paymentReferences').doc(referenceId).set(
      {
        reference: '[deleted]',
        redactedAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  // Moderation events and their idempotency pointers contain the ids of the
  // reviewed student, the room owner and the administrator who performed the
  // moderation. They follow the personal records of the deleted account
  // instead of leaving its uid behind.
  for (const field of ['studentId', 'ownerId', 'deletedByAdminId'] as const) {
    await deleteWhere(() =>
      db.collection('reviewDeletionAudit')
        .where(field, '==', uid)
        .orderBy('__name__'),
    );
    await deleteWhere(() =>
      db.collection('reviewDeletionState')
        .where(field, '==', uid)
        .orderBy('__name__'),
    );
  }

  // The locks of the booking requests — a lock that points at a request of
  // a deleted account would block a new request of somebody else. The
  // deterministic ids cover both the tenant-side and the owner-side locks.
  for (const lockId of joinLockIds) {
    await db.collection('joinRequestLocks').doc(lockId).delete();
  }

  // OTP challenges and the account's send quota can contain the deleted
  // account's contact details or identifier hash.
  await deleteWhere(() =>
    db.collection('otpCodes')
      .where('verifiedByUid', '==', uid)
      .orderBy('__name__'),
  );
  // The deterministic contact records are deleted as well. This covers an
  // optional phone record which was never challenge-bound and any legacy
  // email record which predates the binding above.
  if (profileEmail) {
    await db
      .collection('otpCodes')
      .doc(otpDocumentId('email', profileEmail))
      .delete();
  }
  if (profilePhone) {
    await db
      .collection('otpCodes')
      .doc(otpDocumentId('mobile', profilePhone))
      .delete();
  }
  const otpQuotaId = `uid_${crypto
    .createHash('sha256')
    .update(uid)
    .digest('hex')}`;
  await db.collection('otpSendQuota').doc(otpQuotaId).delete();

  // A verified-email linking operation and its per-account lock contain the
  // uid, the plain email address and the hash of the one-time proof. They are
  // only durable server-side retry/serialisation records and must not outlive
  // the account they belong to.
  await deleteWhere(() =>
    db
      .collection('emailLinkOperations')
      .where('uid', '==', uid)
      .orderBy('__name__'),
  );

  // A pending Auth role-claim publication contains the deleted uid and can
  // no longer have a valid destination profile.
  await db.collection('roleClaimJobs').doc(uid).delete();

  // The durable support-reply delivery records name the deleted account on
  // both sides of the support channel. They are server-only retry records,
  // so they must not outlive the account. The recipient-visible notification
  // is removed before its delivery record.
  for (const field of ['recipientId', 'sourceAuthorUid', 'sourceRecipientUid']) {
    const supportReplyOperations = await db
      .collection(ADMIN_SUPPORT_REPLY_NOTIFICATION_OPERATIONS)
      .where(field, '==', uid)
      .get();
    for (const operation of supportReplyOperations.docs) {
      const notificationId = String(operation.get('notificationId') || '').trim();
      if (notificationId) {
        await db.collection('notifications').doc(notificationId).delete();
      }
      await operation.ref.delete();
    }
  }

  // The phone-verification proof holds the exact phone number of the deleted
  // account. It is the durable source of the signed `stayServeVerifiedPhone`
  // claim, so it has to go with the account: a deleted user must never keep
  // a phone number in a server-only collection.
  await db.collection(PHONE_VERIFICATION_PROOFS).doc(uid).delete();

  // Personal blocks are directional. Remove both the blocks this account
  // created and the blocks other accounts created against it, so a deleted
  // uid can never keep restricting somebody else's interaction.
  await deletePersonalBlocks(uid);

  // The photos of the rooms of the user. Every delete is idempotent, so a
  // partial cleanup can safely be retried. Storage failures are propagated to
  // the durable deletion job instead of being reported as a completed
  // account deletion.
  await deleteOwnerRoomPhotoObjects(uid);

  // The server-mediated room-photo protocol keeps its own durable records.
  // They contain the deleted uid and must not survive the account. The
  // Storage prefix above is deleted first; if that fails, the account-deletion
  // job remains pending and these records still describe the unfinished work.
  await deleteWhere(() =>
    db
      .collection('roomPhotoUploadOperations')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  // A stage request may have written its Storage object while the first
  // prefix sweep was running. The upload-operation records are now gone, so
  // sweep the exact owner prefix once more before this durable job can be
  // completed. If this final sweep fails, the account-deletion job remains
  // pending and retries the sweep; no operation record is discarded while its
  // object has no remaining cleanup trigger.
  await deleteOwnerRoomPhotoObjects(uid);

  await db.collection('roomPhotoUploadQuotas').doc(uid).delete();
  await deleteWhere(() =>
    db
      .collection('roomPhotoRoomQuotas')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );
  await deleteWhere(() =>
    db
      .collection('roomPhotoCommitOperations')
      .where('ownerId', '==', uid)
      .orderBy('__name__'),
  );

  // The Auth account goes last — everything else is already gone.
  //
  // The account may already be gone: the `onUserDelete` trigger runs this
  // very function again, and an admin may delete an account that was
  // already removed in the Firebase console. "User not found" is not an
  // error in that case — the account is gone either way.
  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (!isUserNotFound(error)) {
      throw error;
    }
    console.log(`The Auth account ${uid} was already gone.`);
  }

  // A registration-rollback marker contains the deleted uid and may be the
  // only durable instruction which tells the rollback worker to remove a
  // still-pending incomplete Auth account. Keep it until the Auth deletion
  // above has succeeded (or was already complete). If any earlier cleanup
  // step fails, the marker remains and the worker can still finish the
  // incomplete registration. Once Auth is gone, remove the marker so no
  // later worker pass can act on the deleted account.
  await deleteWhere(() =>
    db
      .collection(REGISTRATION_ROLLBACK_OPERATIONS)
      .where('uid', '==', uid)
      .orderBy('__name__'),
  );
  await db.collection(REGISTRATION_ROLLBACK_OPERATIONS).doc(uid).delete();

  // The profile is deleted only after every dependent Firestore collection,
  // the room photos and the Auth account are gone. Keeping it until the end
  // preserves the account-state marker for a failed or interrupted cleanup.
  await db.collection('users').doc(uid).delete();

  // Run one final block sweep after the profile is gone. A block transaction
  // which was already in flight when the profile was deleted either loses
  // the Firestore transaction race or is observed by this sweep. The profile
  // fence prevents every later block from being created in the first place.
  await deletePersonalBlocks(uid);
}

/**
 * Whether the error means "this Auth account does not exist".
 */
function isUserNotFound(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const message = String((error as { message?: string })?.message || '');
  return (
    code === 'auth/user-not-found' ||
    message.includes('auth/user-not-found')
  );
}

/** The kind of durable cleanup job used for an account deletion. */
export const ACCOUNT_DELETION_JOB_TYPE = 'accountDeletion';

/**
 * The current durable Auth-state revision of an account-deletion job.
 *
 * Auth and Firestore cannot be committed atomically. The revision tells a
 * worker that the desired Auth state changed while its own Auth call was in
 * flight, so it never clears a newer retry marker with stale information.
 */
export function accountAuthStateRevision(
  snapshot: firestore.DocumentSnapshot,
): number {
  const value = Number(snapshot.get('authStateRevision') || 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The revision to write when one operation changes the desired Auth state. */
export function nextAccountAuthStateRevision(
  snapshot: firestore.DocumentSnapshot,
): number {
  return accountAuthStateRevision(snapshot) + 1;
}

/**
 * Whether an account is still owned by the account-deletion state machine.
 *
 * The profile marker and the durable job are both checked. A missing job is
 * not proof that a legacy profile is safe to re-activate.
 */
export function accountDeletionIsPending(
  userSnapshot: firestore.DocumentSnapshot,
  jobSnapshot: firestore.DocumentSnapshot,
): boolean {
  const deletionState = String(
    userSnapshot.get('deletionState') || '',
  ).trim();
  const jobStatus = jobSnapshot.exists
    ? String(jobSnapshot.get('status') || '').trim()
    : '';

  return (
    userSnapshot.get('deletionScheduled') === true ||
    ['scheduled', 'pending', 'deleting', 'restoring'].includes(deletionState) ||
    ['scheduled', 'pending', 'processing', 'cancelled'].includes(jobStatus)
  );
}

/**
 * Whether the profile carries an explicit administrative disable marker.
 *
 * Such a marker is authoritative even when a legacy restore record still
 * claims that the account used to be active.
 */
function accountHasAdministrativeDisableMarker(
  snapshot: firestore.DocumentSnapshot,
): boolean {
  return (
    snapshot.get('banReason') != null ||
    snapshot.get('bannedAt') != null ||
    snapshot.get('forcedLogoutAt') != null
  );
}

/**
 * How long one worker may own an account-deletion job.
 *
 * A worker which crashes is replaced after this lease. Every deletion step is
 * idempotent, so a new worker can safely continue from the beginning.
 */
const ACCOUNT_DELETION_LEASE_MS = 15 * 60 * 1000;

/** The shortest delay before a failed deletion is retried. */
const ACCOUNT_DELETION_RETRY_BASE_MS = 15 * 60 * 1000;

/** The longest delay before a failed deletion is retried. */
const ACCOUNT_DELETION_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * How long a blocked deletion waits before it is checked again.
 *
 * A blocked deletion is not an infrastructure failure: it needs a booking or
 * payment to reach a safe state first. It is therefore retried less often
 * than a transient Firestore, Storage or Auth failure.
 */
const ACCOUNT_DELETION_BLOCKED_RETRY_MS = 60 * 60 * 1000;

/**
 * The id of the durable account-deletion job.
 *
 * The uid is hashed so a completed job does not itself keep the deleted
 * account identifier in Firestore.
 */
export function accountDeletionJobId(uid: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(uid.trim())
    .digest('hex');
  return `account-deletion-${digest}`;
}

/**
 * Writes the durable record which says that an account has to be removed.
 *
 * The job is written **before** any data is deleted. A Firestore, Storage or
 * Auth outage therefore leaves a retryable record instead of an orphaned
 * profile or a half-deleted account.
 */
export async function enqueueAccountDeletion(
  uid: string,
  options: {
    source?: string;
    requestedBy?: string;
    /** The live administrator whose action is being committed. */
    authorizationUid?: string;
  } = {},
): Promise<firestore.DocumentReference> {
  const trimmedUid = uid.trim();
  if (!trimmedUid) throw new Error('The account-deletion job needs a uid');

  const jobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId(trimmedUid));

  await db.runTransaction(async (transaction) => {
    // The deletion job is always read before the user profiles. Every
    // account-deletion transaction uses the same order, so two operations
    // cannot deadlock on the same pair of documents.
    const snapshot = await transaction.get(jobRef);
    const authorizationUid = String(options.authorizationUid || '').trim();
    const profiles = await readUserProfilesInPathOrder(transaction, [
      trimmedUid,
      authorizationUid,
    ]);
    const userSnapshot = profiles.get(trimmedUid)!;
    const authorizationSnapshot = authorizationUid
      ? profiles.get(authorizationUid)!
      : null;

    if (
      authorizationUid &&
      (!authorizationSnapshot ||
        !canActAsAdmin({
          exists: authorizationSnapshot.exists,
          registrationCompleted: authorizationSnapshot.get('registrationCompleted'),
          isActive: authorizationSnapshot.get('isActive'),
          role: authorizationSnapshot.get('role'),
        }))
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Admin access required',
      );
    }

    const status = snapshot.exists
      ? String(snapshot.get('status') || '')
      : '';

    // A completed job is the tombstone of this uid. Never restore the uid or
    // reopen it when the Auth delete trigger arrives after the worker has
    // already finished.
    if (status === 'completed') return;

    // A cancelled job with a restore token is an account which is being
    // restored right now. Re-pending the deletion would overwrite that
    // restore and could delete the account while the worker is enabling it.
    if (status === 'cancelled' && snapshot.get('restoreToken')) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The account restoration is still being finalized. Please try again shortly.',
      );
    }

    const patch: Record<string, unknown> = {
      type: ACCOUNT_DELETION_JOB_TYPE,
      uid: trimmedUid,
      source: options.source || 'unspecified',
      authStateRevision: nextAccountAuthStateRevision(snapshot),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    };
    if (options.requestedBy) patch.requestedBy = options.requestedBy;

    if (!snapshot.exists) {
      patch.status = 'pending';
      patch.attempts = 0;
      patch.createdAt = firestore.FieldValue.serverTimestamp();
    } else if (status !== 'processing') {
      // Keep an active worker undisturbed, but make an expired or pending job
      // eligible for the worker again. A stale worker token must not survive
      // the transition: the new owner of the job has to be unmistakable.
      patch.status = 'pending';
      patch.workerToken = firestore.FieldValue.delete();
      patch.leaseUntil = firestore.FieldValue.delete();
      patch.nextAttemptAt = firestore.FieldValue.delete();
      patch.lastError = firestore.FieldValue.delete();
    }

    if (status !== 'processing') {
      // The deletion always wants Auth to be disabled. A legacy cancelled
      // record may still carry the restore-only fields; clear them before
      // the job becomes a deletion job again.
      patch.authDisablePending = true;
      patch.authEnablePending = firestore.FieldValue.delete();
      patch.restoreToken = firestore.FieldValue.delete();
    }

    if (userSnapshot.exists) {
      transaction.update(userSnapshot.ref, {
        isActive: false,
        deletionState: status === 'processing' ? 'deleting' : 'pending',
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
    }

    transaction.set(jobRef, patch, { merge: true });
  });

  return jobRef;
}

/**
 * Commits a scheduled account deletion and its durable job together.
 *
 * The user document and the job are written in one transaction. This is the
 * ledger which survives a partial cleanup, and it lets a cancellation race
 * with the due-date worker as two competing Firestore transactions.
 */
export async function scheduleAccountDeletionJob(
  uid: string,
  deleteAfter: firestore.Timestamp,
  requestedBy: string,
): Promise<firestore.DocumentReference> {
  const trimmedUid = uid.trim();
  if (!trimmedUid) throw new Error('The scheduled deletion needs a uid');

  const userRef = db.collection('users').doc(trimmedUid);
  const jobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId(trimmedUid));

  await db.runTransaction(async (transaction) => {
    // The deletion job is always read before the user profiles. Every
    // account-deletion transaction uses the same order, so two operations
    // cannot deadlock on the same pair of documents.
    const jobSnapshot = await transaction.get(jobRef);
    const profiles = await readUserProfilesInPathOrder(transaction, [
      trimmedUid,
      requestedBy,
    ]);
    const userSnapshot = profiles.get(trimmedUid)!;
    const requesterSnapshot = profiles.get(requestedBy)!;

    if (
      !canActAsAdmin({
        exists: requesterSnapshot.exists,
        registrationCompleted: requesterSnapshot.get('registrationCompleted'),
        isActive: requesterSnapshot.get('isActive'),
        role: requesterSnapshot.get('role'),
      })
    ) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Admin access required',
      );
    }
    if (!userSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That user does not exist',
      );
    }
    const jobStatus = jobSnapshot.exists
      ? String(jobSnapshot.get('status') || '')
      : '';
    if (jobStatus === 'completed') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'That account was already deleted',
      );
    }
    if (
      jobSnapshot.get('deletionClaimed') === true ||
      jobStatus === 'pending' ||
      jobStatus === 'processing'
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The account deletion has already started and can no longer be scheduled.',
      );
    }
    if (jobStatus === 'cancelled' && jobSnapshot.get('restoreToken')) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The account restoration is still being finalized. Please try again shortly.',
      );
    }

    // The account keeps the activation state it had before the deletion was
    // scheduled. Cancelling the deletion restores exactly that state, so a
    // banned account is not unbanned as a side effect of a cancellation.
    // A rescheduled deletion keeps the state of the first schedule.
    const storedPrevious = userSnapshot.get('deletionPreviousIsActive');
    const jobPrevious = jobSnapshot.exists
      ? jobSnapshot.get('previousIsActive')
      : undefined;
    const hasAdministrativeDisableMarker =
      accountHasAdministrativeDisableMarker(userSnapshot);
    const previousIsActive = hasAdministrativeDisableMarker
      ? false
      : typeof storedPrevious === 'boolean'
        ? storedPrevious
        : typeof jobPrevious === 'boolean'
          ? jobPrevious
          : userSnapshot.get('isActive') === true;

    transaction.update(userRef, {
      deletionScheduled: true,
      deletionScheduledAt: firestore.FieldValue.serverTimestamp(),
      deletionRequestedBy: requestedBy,
      deleteAfter,
      isActive: false,
      deletionState: 'scheduled',
      deletionPreviousIsActive: previousIsActive,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });

    transaction.set(
      jobRef,
      {
        type: ACCOUNT_DELETION_JOB_TYPE,
        uid: trimmedUid,
        status: 'scheduled',
        source: 'scheduled-grace-period',
        requestedBy,
        deleteAfter,
        deletionClaimed: false,
        authDisablePending: true,
        authEnablePending: firestore.FieldValue.delete(),
        restoreToken: firestore.FieldValue.delete(),
        workerToken: firestore.FieldValue.delete(),
        leaseUntil: firestore.FieldValue.delete(),
        previousIsActive,
        authStateRevision: nextAccountAuthStateRevision(jobSnapshot),
        attempts: jobSnapshot.exists
          ? Number(jobSnapshot.get('attempts') || 0)
          : 0,
        createdAt:
          jobSnapshot.exists &&
          jobSnapshot.get('createdAt') !== undefined
            ? jobSnapshot.get('createdAt')
            : firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  return jobRef;
}

/**
 * Claims a scheduled deletion after its grace period.
 *
 * The due date, the live `deletionScheduled` flag and the job are checked in
 * one transaction. A cancellation committed first wins; once this claim is
 * committed, a cancellation reports a conflict instead of falsely claiming
 * that the account was restored.
 */
export async function claimScheduledAccountDeletion(
  jobRef: firestore.DocumentReference,
  uid = '',
  now = Date.now(),
): Promise<boolean> {
  return db.runTransaction(async (transaction) => {
    const jobSnapshot = await transaction.get(jobRef);
    const jobExists = jobSnapshot.exists;
    const status = jobExists
      ? String(jobSnapshot.get('status') || '')
      : '';
    if (
      jobExists &&
      String(jobSnapshot.get('type') || '') !== ACCOUNT_DELETION_JOB_TYPE
    ) {
      return false;
    }
    if (
      status === 'completed' ||
      status === 'processing' ||
      status === 'cancelled'
    ) {
      return false;
    }
    if (jobSnapshot.get('deletionClaimed') === true) return false;

    const resolvedUid = jobExists
      ? String(jobSnapshot.get('uid') || '').trim()
      : uid.trim();
    if (!resolvedUid) return false;

    const userRef = db.collection('users').doc(resolvedUid);
    const userSnapshot = await transaction.get(userRef);
    const deleteAfter = jobExists
      ? jobSnapshot.get('deleteAfter')
      : userSnapshot.get('deleteAfter');
    const due =
      deleteAfter &&
      typeof deleteAfter.toMillis === 'function' &&
      deleteAfter.toMillis() <= now;

    if (!userSnapshot.exists) {
      // The Auth account may already have been removed. The durable job can
      // continue the remaining Firestore and Storage cleanup.
      transaction.set(
        jobRef,
        {
          type: ACCOUNT_DELETION_JOB_TYPE,
          uid: resolvedUid,
          status: 'pending',
          deletionClaimed: true,
          claimedAt: firestore.FieldValue.serverTimestamp(),
          createdAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return true;
    }

    if (userSnapshot.get('deletionScheduled') !== true || !due) {
      return false;
    }

    transaction.set(
      jobRef,
      {
        type: ACCOUNT_DELETION_JOB_TYPE,
        uid: resolvedUid,
        status: 'pending',
        deletionClaimed: true,
        authDisablePending: true,
        authEnablePending: firestore.FieldValue.delete(),
        restoreToken: firestore.FieldValue.delete(),
        workerToken: firestore.FieldValue.delete(),
        leaseUntil: firestore.FieldValue.delete(),
        claimedAt: firestore.FieldValue.serverTimestamp(),
        createdAt:
          jobExists && jobSnapshot.get('createdAt') !== undefined
            ? jobSnapshot.get('createdAt')
            : firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return true;
  });
}

/**
 * Claims one account-deletion job for this worker.
 *
 * A short lease prevents two workers from deleting the same account at the
 * same time. If a worker dies, the lease expires and a later run takes over.
 */
async function claimAccountDeletionJob(
  jobRef: firestore.DocumentReference,
): Promise<string | null> {
  const now = Date.now();

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(jobRef);
    if (!snapshot.exists) return null;

    // Only a real account-deletion job may be claimed. A scheduled job is
    // still inside its grace period, a cancelled job belongs to the
    // restoration flow and a completed job is a tombstone.
    if (String(snapshot.get('type') || '') !== ACCOUNT_DELETION_JOB_TYPE) {
      return null;
    }
    const uid = String(snapshot.get('uid') || '').trim();
    if (!uid) return null;

    const status = String(snapshot.get('status') || '');
    if (status !== 'pending' && status !== 'processing') return null;
    if (snapshot.get('restoreToken')) return null;

    const nextAttemptAt = snapshot.get('nextAttemptAt');
    if (
      nextAttemptAt &&
      typeof nextAttemptAt.toMillis === 'function' &&
      nextAttemptAt.toMillis() > now
    ) {
      return null;
    }

    const leaseUntil = snapshot.get('leaseUntil');
    const leaseMillis =
      leaseUntil && typeof leaseUntil.toMillis === 'function'
        ? leaseUntil.toMillis()
        : 0;
    if (status === 'processing' && leaseMillis > now) return null;

    const workerToken = crypto.randomUUID();
    transaction.set(
      jobRef,
      {
        status: 'processing',
        workerToken,
        leaseUntil: firestore.Timestamp.fromMillis(
          now + ACCOUNT_DELETION_LEASE_MS,
        ),
        attempts: firestore.FieldValue.increment(1),
        nextAttemptAt: firestore.FieldValue.delete(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return workerToken;
  });
}

/** Returns a failed job to the pending state without losing its uid. */
async function releaseAccountDeletionJob(
  jobRef: firestore.DocumentReference,
  workerToken: string,
  error: unknown,
): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(jobRef);
    if (!snapshot.exists) return;
    const status = String(snapshot.get('status') || '');
    if (status === 'completed') return;

    // Only the worker which currently owns the processing lease may release
    // it. A stale worker must not move a pending or cancelled job back into
    // the queue or overwrite its error state.
    if (
      status !== 'processing' ||
      String(snapshot.get('workerToken') || '') !== workerToken
    ) {
      return;
    }

    const attempts = Math.max(1, Number(snapshot.get('attempts') || 1));
    const blocked = isAccountDeletionBlockedError(error);
    const baseDelay = blocked
      ? ACCOUNT_DELETION_BLOCKED_RETRY_MS
      : ACCOUNT_DELETION_RETRY_BASE_MS;
    const retryDelay = Math.min(
      ACCOUNT_DELETION_RETRY_MAX_MS,
      baseDelay * Math.pow(2, attempts - 1),
    );

    transaction.set(
      jobRef,
      {
        status: 'pending',
        lastError: String(error).slice(0, 300),
        nextAttemptAt: firestore.Timestamp.fromMillis(
          Date.now() + retryDelay,
        ),
        workerToken: firestore.FieldValue.delete(),
        leaseUntil: firestore.FieldValue.delete(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

/**
 * Marks a claimed account-deletion job as completed.
 *
 * Only the worker which still owns the processing lease may complete the
 * job. A worker whose lease expired and was taken over must not mark the
 * job as completed behind the new owner's back.
 */
export async function completeAccountDeletionJob(
  jobRef: firestore.DocumentReference,
  workerToken: string,
): Promise<boolean> {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(jobRef);
    if (!snapshot.exists) {
      throw new Error('The account-deletion job no longer exists');
    }
    const status = String(snapshot.get('status') || '');
    if (status === 'completed') return true;

    if (
      status !== 'processing' ||
      String(snapshot.get('workerToken') || '') !== workerToken
    ) {
      throw new Error('The account-deletion job lease was lost');
    }

    transaction.set(
      jobRef,
      {
        status: 'completed',
        completedAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
        // The completed tombstone must not keep personal identifiers.
        uid: firestore.FieldValue.delete(),
        requestedBy: firestore.FieldValue.delete(),
        workerToken: firestore.FieldValue.delete(),
        leaseUntil: firestore.FieldValue.delete(),
        deleteAfter: firestore.FieldValue.delete(),
        deletionClaimed: firestore.FieldValue.delete(),
        authDisablePending: firestore.FieldValue.delete(),
        authEnablePending: firestore.FieldValue.delete(),
        restoreToken: firestore.FieldValue.delete(),
        previousIsActive: firestore.FieldValue.delete(),
        nextAttemptAt: firestore.FieldValue.delete(),
        lastError: firestore.FieldValue.delete(),
      },
      { merge: true },
    );
    return true;
  });
}

/**
 * Runs one durable account-deletion job.
 *
 * The job is completed only after Firestore, Storage and Auth cleanup all
 * succeeded. On failure it returns to `pending` and keeps the uid so a later
 * run can retry it.
 */
export async function processAccountDeletionJob(
  jobRef: firestore.DocumentReference,
): Promise<boolean> {
  const workerToken = await claimAccountDeletionJob(jobRef);
  if (!workerToken) return false;

  try {
    const snapshot = await jobRef.get();
    const uid = String(snapshot.get('uid') || '').trim();
    if (!uid) throw new Error('The account-deletion job has no uid');

    await deleteUserEverywhere(uid);
  } catch (error) {
    await releaseAccountDeletionJob(jobRef, workerToken, error);
    throw error;
  }

  await completeAccountDeletionJob(jobRef, workerToken);

  return true;
}

/**
 * Finishes a cancelled account deletion.
 *
 * The restore is deliberately two-phase:
 *
 *  1. Auth is enabled first. The Firestore profile stays inactive until
 *     that succeeded, so a failed Auth call can never leave an account which
 *     the server trusts while Auth still considers it disabled.
 *  2. The profile is activated and the durable restore record is removed in
 *     one transaction. The restore token proves that this worker still owns
 *     the cancellation, so a concurrently re-pended deletion can never be
 *     deleted by mistake.
 *
 * The activation state of the profile is restored to the state it had
 * before the deletion was scheduled. An account which was already banned
 * therefore stays banned.
 */
export async function finishCancelledAccountDeletion(
  jobRef: firestore.DocumentReference,
  uid: string,
  restoreToken: string,
): Promise<boolean> {
  const userRef = db.collection('users').doc(uid);
  const snapshot = await jobRef.get();
  if (!snapshot.exists) {
    // The restore worker may have completed just before this caller arrived.
    // That is only a successful restore when the profile no longer carries a
    // deletion marker. A missing job with a still-restoring profile is not
    // proof that the account was restored.
    const userSnapshot = await userRef.get();
    const deletionState = userSnapshot.get('deletionState');
    return (
      userSnapshot.exists &&
      (deletionState === undefined || deletionState === null)
    );
  }
  if (String(snapshot.get('status') || '') !== 'cancelled') return false;
  if (String(snapshot.get('restoreToken') || '') !== restoreToken) return false;

  /**
   * Whether the cancelled deletion should restore an active account.
   *
   * The current profile and job are read in one transaction before every
   * Auth call. A ban or forced logout which commits during the restore can
   * therefore change the desired state before the stale worker enables Auth.
   */
  const shouldRestoreActive = (
    jobSnapshot: firestore.DocumentSnapshot,
    userSnapshot: firestore.DocumentSnapshot,
  ): boolean => {
    if (!userSnapshot.exists) return false;
    if (accountHasAdministrativeDisableMarker(userSnapshot)) return false;

    const profilePrevious = userSnapshot.get('deletionPreviousIsActive');
    if (typeof profilePrevious === 'boolean') return profilePrevious;

    const jobPrevious = jobSnapshot.get('previousIsActive');
    return typeof jobPrevious === 'boolean' ? jobPrevious : false;
  };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Prepare the exact Auth transition from the current durable state.
    // This transaction also writes the matching retry marker, so an Auth
    // failure leaves a record which the scheduled worker can finish.
    const prepared = await db.runTransaction(async (transaction) => {
      const jobSnapshot = await transaction.get(jobRef);
      if (!jobSnapshot.exists) return null;
      if (String(jobSnapshot.get('status') || '') !== 'cancelled') return null;
      if (String(jobSnapshot.get('restoreToken') || '') !== restoreToken) {
        return null;
      }

      const userSnapshot = await transaction.get(userRef);
      const restoreActive = shouldRestoreActive(jobSnapshot, userSnapshot);
      const storedPrevious = jobSnapshot.get('previousIsActive');
      const desiredStateChanged = storedPrevious !== restoreActive;
      const revokePending =
        !restoreActive && jobSnapshot.get('authRevokePending') === true;

      transaction.update(jobRef, {
        previousIsActive: restoreActive,
        authEnablePending: restoreActive,
        authDisablePending: !restoreActive,
        authRevokePending: revokePending,
        ...(desiredStateChanged
          ? { authStateRevision: nextAccountAuthStateRevision(jobSnapshot) }
          : {}),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
      if (userSnapshot.exists) {
        transaction.update(userRef, {
          deletionPreviousIsActive: restoreActive,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        });
      }

      return { restoreActive, revokePending };
    });
    if (!prepared) return false;

    if (prepared.restoreActive) {
      try {
        await auth.updateUser(uid, { disabled: false });
      } catch (error) {
        if (!isUserNotFound(error)) throw error;

        // The Auth account is gone. The profile must not be re-activated: the
        // account was deleted in the meantime, so the job goes back to the
        // deletion flow instead of restoring a profile without an identity.
        await db.runTransaction(async (transaction) => {
          const jobSnapshot = await transaction.get(jobRef);
          if (!jobSnapshot.exists) return;
          if (String(jobSnapshot.get('status') || '') !== 'cancelled') return;
          if (String(jobSnapshot.get('restoreToken') || '') !== restoreToken) {
            return;
          }

          const currentUserSnapshot = await transaction.get(userRef);
          transaction.update(jobRef, {
            status: 'pending',
            restoreToken: firestore.FieldValue.delete(),
            authEnablePending: firestore.FieldValue.delete(),
            authDisablePending: true,
            deletionClaimed: false,
            authStateRevision: nextAccountAuthStateRevision(jobSnapshot),
            updatedAt: firestore.FieldValue.serverTimestamp(),
          });
          if (currentUserSnapshot.exists) {
            transaction.update(userRef, {
              isActive: false,
              deletionState: 'deleting',
              updatedAt: firestore.FieldValue.serverTimestamp(),
            });
          }
        });
        return false;
      }
    } else {
      try {
        await auth.updateUser(uid, { disabled: true });
        if (prepared.revokePending) {
          // A stale restore may have enabled Auth after a ban committed.
          // Revoke the refresh sessions again so that enable/disable cannot
          // leave a usable token behind.
          await auth.revokeRefreshTokens(uid);
        }
      } catch (error) {
        if (!isUserNotFound(error)) throw error;
      }
    }

    // The Auth transition is now confirmed. Re-read the durable state before
    // removing the restore record. If an administrator disabled the account
    // while the Auth call was in flight, keep the job and perform the
    // opposite transition instead of deleting the only retry marker.
    const finalized = await db.runTransaction(async (transaction) => {
      const jobSnapshot = await transaction.get(jobRef);
      if (!jobSnapshot.exists) return { done: false as const };
      if (String(jobSnapshot.get('status') || '') !== 'cancelled') {
        return { done: false as const };
      }
      if (String(jobSnapshot.get('restoreToken') || '') !== restoreToken) {
        return { done: false as const };
      }

      const userSnapshot = await transaction.get(userRef);
      const restoreActive = shouldRestoreActive(jobSnapshot, userSnapshot);
      if (restoreActive !== prepared.restoreActive) {
        transaction.update(jobRef, {
          previousIsActive: restoreActive,
          authEnablePending: restoreActive,
          authDisablePending: !restoreActive,
          authRevokePending: !restoreActive,
          authStateRevision: nextAccountAuthStateRevision(jobSnapshot),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        });
        if (userSnapshot.exists) {
          transaction.update(userRef, {
            deletionPreviousIsActive: restoreActive,
            updatedAt: firestore.FieldValue.serverTimestamp(),
          });
        }
        return { done: false as const };
      }

      if (userSnapshot.exists) {
        transaction.update(userRef, {
          isActive: restoreActive,
          deletionScheduled: false,
          deletionScheduledAt: null,
          deletionRequestedBy: null,
          deleteAfter: null,
          deletionState: null,
          deletionPreviousIsActive: firestore.FieldValue.delete(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        });
      }
      // The durable job is removed only after the desired Auth state was
      // confirmed. A failed disable therefore leaves this record available
      // for the scheduled worker to retry.
      transaction.delete(jobRef);
      return { done: true as const };
    });

    if (finalized.done) return true;
  }

  throw new Error(
    'The account restoration and its Auth state did not converge; the durable job will be retried.',
  );
}

/**
 * Reconciles the Auth state of an account with its durable deletion job.
 *
 * Firestore and Firebase Auth cannot be updated in one transaction. A
 * scheduled deletion and its cancellation can therefore overlap: one
 * worker may still be disabling Auth while the cancellation enables it.
 * The job document is the durable source of truth. This helper re-reads it
 * after every Auth call and repeats the transition until the observed job
 * state and the Auth state agree.
 *
 * The helper is deliberately bounded. If another administrator keeps
 * changing the job at the same time, the durable job remains scheduled and
 * a later worker retries instead of looping forever.
 */
async function reconcileAccountDeletionAuthState(
  jobRef: firestore.DocumentReference,
  uid: string,
): Promise<void> {
  const MAX_ATTEMPTS = 4;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await jobRef.get();
    if (!snapshot.exists) {
      // The cancellation worker owns every normal enable transition and
      // removes the job only after that transition succeeded. This branch is
      // only the repair for a stale scheduled disable which was already in
      // flight when the cancellation finished. It may enable Auth only when
      // the live profile proves that the account is active, not deleted and
      // not administratively disabled.
      const userSnapshot = await db.collection('users').doc(uid).get();
      const deletionState = String(
        userSnapshot.get('deletionState') || '',
      ).trim();
      const safeToEnable =
        userSnapshot.exists &&
        userSnapshot.get('isActive') === true &&
        userSnapshot.get('deletionScheduled') !== true &&
        !deletionState &&
        !accountHasAdministrativeDisableMarker(userSnapshot);
      if (!safeToEnable) return;

      try {
        await auth.updateUser(uid, { disabled: false });
      } catch (error) {
        if (isUserNotFound(error)) return;
        throw error;
      }

      // A ban or forced logout may have committed while Auth was being
      // enabled. Re-read the profile and repair the stale enable before this
      // worker returns.
      const currentUser = await db.collection('users').doc(uid).get();
      const currentDeletionState = String(
        currentUser.get('deletionState') || '',
      ).trim();
      const stillSafeToEnable =
        currentUser.exists &&
        currentUser.get('isActive') === true &&
        currentUser.get('deletionScheduled') !== true &&
        !currentDeletionState &&
        !accountHasAdministrativeDisableMarker(currentUser);
      if (!stillSafeToEnable) {
        try {
          await auth.updateUser(uid, { disabled: true });
          await auth.revokeRefreshTokens(uid);
        } catch (error) {
          if (!isUserNotFound(error)) throw error;
        }
      }
      return;
    }

    const status = String(snapshot.get('status') || '');
    const observedAuthStateRevision = accountAuthStateRevision(snapshot);
    if (status === 'completed') return;
    if (
      String(snapshot.get('type') || '') !== ACCOUNT_DELETION_JOB_TYPE
    ) {
      // The document is not an account-deletion job. It must never be
      // allowed to change Auth, but it also must not make every scheduled
      // cleanup invocation fail forever.
      console.warn(
        `Ignoring account-deletion job ${jobRef.id} with unexpected type.`,
      );
      return;
    }

    if (status === 'cancelled') {
      const restoreToken = String(snapshot.get('restoreToken') || '');
      if (!restoreToken) {
        throw new Error(
          'The cancelled account-deletion job has no restore record',
        );
      }
      const restored = await finishCancelledAccountDeletion(
        jobRef,
        uid,
        restoreToken,
      );
      if (restored) return;
      continue;
    }

    if (
      status !== 'scheduled' &&
      status !== 'pending' &&
      status !== 'processing'
    ) {
      // An unknown state is not proof that Auth may be enabled.
      throw new Error(
        `The account-deletion job has an unsupported status: ${status || 'missing'}`,
      );
    }

    try {
      await auth.updateUser(uid, { disabled: true });
      await auth.revokeRefreshTokens(uid);
    } catch (error) {
      if (!isUserNotFound(error)) throw error;
    }

    if (status !== 'scheduled') return;

    // Clear the retry marker only when the same scheduled job is still
    // current. If a cancellation or a new deletion committed while Auth was
    // being updated, the next loop observes the new state and repairs it.
    const stillScheduled = await db.runTransaction(async (transaction) => {
      const current = await transaction.get(jobRef);
      if (!current.exists) return false;
      if (String(current.get('status') || '') !== 'scheduled') return false;
      // A newer ban, forced logout or scheduling operation changed the
      // desired Auth state while this worker was disabling Auth. Its retry
      // marker must not be cleared with the stale revision.
      if (
        accountAuthStateRevision(current) !== observedAuthStateRevision
      ) {
        return false;
      }
      transaction.update(jobRef, {
        authDisablePending: false,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (stillScheduled) return;
  }

  throw new Error(
    'The account deletion and its Auth state did not converge; the durable job will be retried.',
  );
}

/**
 * Retries durable account-deletion jobs.
 *
 * This worker handles deletions requested through the Auth console, through
 * the self-service trigger and through the seven-day grace period. A failed
 * job remains pending and is retried on the next run.
 */
export const processAccountDeletionJobs = functions.pubsub
  .schedule('every 15 minutes')
  .onRun(async () => {
    let completed = 0;
    let deferred = 0;
    let failed = 0;
    let inspected = 0;
    let cursor: firestore.QueryDocumentSnapshot | undefined;

    // Every unfinished job is inspected. A fixed page limit allowed a large
    // number of future scheduled deletions to hide the jobs which were ready
    // to run behind them.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let query = db
        .collection('accountDeletionJobs')
        .where('status', 'in', [
          'scheduled',
          'pending',
          'processing',
          'cancelled',
        ])
        .orderBy('__name__');
      if (cursor) query = query.startAfter(cursor);
      const jobs = await query.limit(100).get();
      if (jobs.empty) break;

      for (const job of jobs.docs) {
        inspected += 1;
        const data = job.data() || {};
        const status = String(data.status || '');
        const uid = String(data.uid || '').trim();
        const nextAttemptAt = data.nextAttemptAt;
        if (
          nextAttemptAt &&
          typeof nextAttemptAt.toMillis === 'function' &&
          nextAttemptAt.toMillis() > Date.now()
        ) {
          continue;
        }

        try {
          if (
            status !== 'scheduled' &&
            status !== 'cancelled' &&
            data.authDisablePending === true &&
            uid
          ) {
            // An immediate deletion can also be blocked by an active booking.
            // Its Auth state must converge even while the data cleanup waits
            // for a safe booking state.
            await reconcileAccountDeletionAuthState(job.ref, uid);
          }

          if (status === 'scheduled') {
            // The grace period may still be running. The Auth account is
            // disabled immediately, and a failed disable is retried here.
            if (data.authDisablePending === true && uid) {
              await reconcileAccountDeletionAuthState(job.ref, uid);
            }

            const deleteAfter = data.deleteAfter;
            const due =
              deleteAfter &&
              typeof deleteAfter.toMillis === 'function' &&
              deleteAfter.toMillis() <= Date.now();
            if (due && (await claimScheduledAccountDeletion(job.ref, uid))) {
              if (await processAccountDeletionJob(job.ref)) completed += 1;
            }
            continue;
          }

          if (status === 'cancelled') {
            // The Firestore cancellation won the race. The restore token
            // proves that this record still belongs to the cancellation; a
            // job which was re-pended in the meantime has a different token
            // (or none) and is left untouched.
            if (!uid) {
              throw new Error(
                'The cancelled account-deletion job has no uid',
              );
            }
            const restoreToken = String(data.restoreToken || '');
            if (!restoreToken) {
              // A cancellation record from before the restore token existed.
              // The profile was already activated by the old flow, so only
              // the Auth transition and the durable record are left. The
              // delete is still transactional: a job which was re-pended in
              // the meantime keeps its new state.
              if (data.authEnablePending === true) {
                try {
                  await auth.updateUser(uid, { disabled: false });
                } catch (error) {
                  if (!isUserNotFound(error)) throw error;
                }
              }
              await db.runTransaction(async (transaction) => {
                const jobSnapshot = await transaction.get(job.ref);
                if (!jobSnapshot.exists) return;
                if (String(jobSnapshot.get('status') || '') !== 'cancelled') {
                  return;
                }
                if (jobSnapshot.get('restoreToken')) return;
                transaction.delete(job.ref);
              });
              continue;
            }
            await finishCancelledAccountDeletion(
              job.ref,
              uid,
              restoreToken,
            );
            continue;
          }

          if (await processAccountDeletionJob(job.ref)) completed += 1;
        } catch (error) {
          if (isAccountDeletionBlockedError(error)) {
            deferred += 1;
            console.warn(
              `The account deletion for job ${job.id} is waiting for a safe booking state:`,
              error,
            );
            continue;
          }
          failed += 1;
          console.error(
            `Could not delete the account for job ${job.id}:`,
            error,
          );
        }
      }

      cursor = jobs.docs[jobs.docs.length - 1];
      if (jobs.size < 100) break;
    }

    if (failed > 0) {
      // Make the scheduler invocation fail as well. The durable job remains
      // the source of truth, while the failed invocation is retried by the
      // Cloud Scheduler / Functions retry machinery.
      throw new Error(`${failed} account-deletion job(s) failed`);
    }

    console.log(
      `Account deletions completed: ${completed}/${inspected}; deferred: ${deferred}`,
    );
    return null;
  });

/**
 * The admin reviews a booking request.
 *
 * The review used to be a Firestore transaction in the app. That had two
 * problems: the transaction was written by the client (so it could be
 * tampered with) and it did **not** create a notification — the student and
 * the owner never heard that the booking was approved.
 *
 * The review happens inside a **transaction** that re-reads the request, so
 * a cancellation that happens at the same moment cannot be overwritten by
 * the review.
 */
export const adminReviewRequest = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // Do not trust the `admin` custom claim alone: it stays in an already
  // issued token until that token expires.
  const adminUid = context.auth.uid;
  await assertLiveAdmin(adminUid);

  const requestId = String(data?.requestId || '').trim();
  const approve = data?.approve === true;
  const rejectionReason = data?.rejectionReason
    ? String(data.rejectionReason).trim()
    : null;

  if (!requestId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing booking request');
  }

  const requestRef = db.collection('joinRequests').doc(requestId);
  const paymentRef = db.collection('payments').doc(requestId);

  const { request, alreadyActive } = await db.runTransaction(async (transaction) => {
    // The caller's live administrator role is checked in the same
    // transaction as the review decision.
    const adminSnapshot = await transaction.get(
      db.collection('users').doc(adminUid),
    );
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

    const snapshot = await transaction.get(requestRef);
    if (!snapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That booking request no longer exists',
      );
    }

    const request = snapshot.data() as Record<string, any>;
    const paymentSnapshot = await transaction.get(paymentRef);

    // -------------------------------------------------------------------
    // A booking that is already active is **final**.
    //
    // Approving it again would recreate its invoice — and the invoice would
    // go back to `pending` even when the admin had already marked it as
    // paid. The payment history would silently disappear.
    //
    // And it may not be rejected either: the room, the invoice and the
    // payment of an active booking are only released together — by
    // rejecting the **payment** (`verifyPayment`), which does the whole
    // rollback in one transaction.
    // -------------------------------------------------------------------
    if (isActiveBookingStatus(String(request.status || ''))) {
      if (!approve) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This booking is already active — reject its payment instead',
        );
      }
      return { request, alreadyActive: true };
    }

    const ownerApproved =
      request.status === 'ownerConfirmed' || request.status === 'studentConfirmed';
    if (!ownerApproved) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        request.status === 'cancelled'
          ? 'This booking was cancelled'
          : 'The owner has to approve the request before it can be reviewed',
      );
    }

    // A request that already points at another invoice must not get a
    // second one.
    const invoiceId = `INV-${requestId}`;
    if (approve && request.invoiceId && request.invoiceId !== invoiceId) {
      throw new functions.https.HttpsError(
        'already-exists',
        `This booking already has an invoice (${request.invoiceId})`,
      );
    }

    if (approve) {
      // -------------------------------------------------------------------
      // A booking is activated by **verifying its payment** only.
      //
      // The old admin-review path could create the invoice and increment
      // the occupancy without checking that any money had arrived. That
      // made a second, independent activation path and allowed a request
      // with a fake payment to become a tenancy.
      //
      // `verifyPayment` is the single activation transition. This function
      // remains as an idempotent acknowledgement for bookings that are
      // already active and as the rejection path for a request that has
      // not been paid.
      // -------------------------------------------------------------------
      if (request.advancePaymentStatus !== 'verified') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Verify the platform fee payment first — the booking is activated when the payment is verified',
        );
      }

      // A verified payment normally activates the request in
      // `verifyPayment`. Reaching this point means the request is in an
      // inconsistent legacy state; refuse it instead of creating a second
      // activation path.
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Use the Verify Payment action to activate this booking',
      );
    } else {
      const paymentStatus = paymentSnapshot.exists
        ? String(paymentSnapshot.get('status') || '')
        : '';
      if (
        paymentAlreadyMade(request) ||
        paymentStatus === 'submitted' ||
        paymentStatus === 'verified'
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'A payment is waiting for verification — reject the payment instead',
        );
      }

      transaction.update(requestRef, {
        status: 'rejected',
        rejectionReason,
        rejectedAt: firestore.FieldValue.serverTimestamp(),
        adminReviewedAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
    }

    return { request, alreadyActive: false };
  });

  // The booking was already active — nothing changed, so nobody is told
  // about it a second time.
  if (alreadyActive) {
    return { success: true, status: 'adminReviewed', alreadyActive: true };
  }

  // Both sides are told what happened.
  await notify(
    String(request.studentId || ''),
    approve ? 'Your booking is confirmed' : 'Your booking was declined',
    approve
      ? 'Your room is booked. The rent is settled directly with the owner.'
      : rejectionReason || 'The booking could not be completed.',
    approve ? 'invoicePaid' : 'adminReview',
    { requestId, roomId: String(request.roomId || '') },
  );

  await notify(
    String(request.ownerId || ''),
    approve ? 'Booking confirmed' : 'Booking declined',
    approve
      ? 'The student booked your room. The rent is settled directly with them.'
      : rejectionReason || 'The booking could not be completed.',
    approve ? 'invoicePaid' : 'adminReview',
    { requestId, roomId: String(request.roomId || '') },
  );

  return { success: true, status: approve ? 'adminReviewed' : 'rejected' };
});

/** How many days the user has before the account is really deleted. */
export const DELETION_GRACE_DAYS = 7;

/**
 * Schedules the deletion of a user account.
 *
 * The account is **not** deleted right away: the user gets seven days to
 * change their mind, and the admin can cancel the deletion in the meantime.
 * The account is disabled immediately, so nobody can use it while the
 * clock is running.
 */
export const scheduleUserDeletion = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // Do not trust the `admin` custom claim alone: it stays in an already
  // issued token until that token expires.
  await assertLiveAdmin(context.auth.uid);

  const uid = String(data?.uid || '').trim();
  const rawDays = data?.days;
  const days =
    rawDays === undefined || rawDays === null
      ? DELETION_GRACE_DAYS
      : Number(rawDays);

  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }
  if (uid === context.auth.uid) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'You cannot schedule the deletion of your own account',
    );
  }
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid number of days');
  }

  const deleteAfter = firestore.Timestamp.fromMillis(
    Date.now() + days * 24 * 60 * 60 * 1000,
  );

  // The live profile and the durable deletion job are committed together.
  // This transaction is also what makes a later cancellation race with the
  // due-date worker safely.
  const jobRef = await scheduleAccountDeletionJob(
    uid,
    deleteAfter,
    context.auth.uid,
  );

  // The account is disabled right away — it may not be used while the
  // seven days are running. The job keeps `authDisablePending` set if this
  // Auth operation fails, so the scheduled worker can finish it later.
  try {
    await reconcileAccountDeletionAuthState(jobRef, uid);
  } catch (error) {
    console.error('Failed to disable the account:', error);
    throw new functions.https.HttpsError(
      'internal',
      'The account was scheduled, but Auth could not disable it yet. The server will retry.',
    );
  }

  // The cancellation may have won while Auth was being disabled. In that
  // case the durable job is gone or already cancelled and the restored
  // account must not receive a deletion notice.
  const reconciledJob = await jobRef.get();
  const reconciledStatus = reconciledJob.exists
    ? String(reconciledJob.get('status') || '')
    : '';
  if (!reconciledJob.exists || reconciledStatus === 'cancelled') {
    return {
      success: true,
      uid,
      days,
      state: 'cancelled',
      message: 'The deletion was cancelled while the account was being disabled.',
    };
  }

  await notify(
    uid,
    'Your account will be deleted',
    `Your StayServe account has been scheduled for deletion in ${days} ` +
      'days. All your data — your listings, requests and invoices — will be ' +
      'removed. Contact support if you did not request this.',
    'account',
    { uid, days: String(days) },
  );

  return {
    success: true,
    uid,
    deleteAfter: deleteAfter.toDate().toISOString(),
    days,
  };
});

/**
 * Cancels a scheduled deletion and re-enables the account.
 */
export const cancelUserDeletion = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Please sign in first');
  }
  // Do not trust the `admin` custom claim alone: it stays in an already
  // issued token until that token expires.
  const adminUid = context.auth.uid;
  await assertLiveAdmin(adminUid);

  const uid = String(data?.uid || '').trim();
  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'UID is required');
  }

  const userRef = db.collection('users').doc(uid);
  const jobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId(uid));
  const restoreToken = crypto.randomUUID();

  await db.runTransaction(async (transaction) => {
    // The deletion job is read before the user profiles. Every
    // account-deletion transaction uses the same lock order.
    const jobSnapshot = await transaction.get(jobRef);
    const profiles = await readUserProfilesInPathOrder(transaction, [
      adminUid,
      uid,
    ]);
    const adminSnapshot = profiles.get(adminUid)!;
    const userSnapshot = profiles.get(uid)!;

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
    if (!userSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That user does not exist',
      );
    }

    const jobStatus = jobSnapshot.exists
      ? String(jobSnapshot.get('status') || '')
      : '';
    if (jobStatus === 'completed') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'That account was already deleted.',
      );
    }
    if (
      jobSnapshot.get('deletionClaimed') === true ||
      jobStatus === 'processing' ||
      jobStatus === 'pending'
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The deletion has already started and can no longer be cancelled.',
      );
    }
    if (jobStatus === 'cancelled') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'The account restoration is already being finalized. Please try again shortly.',
      );
    }
    if (
      jobStatus !== 'scheduled' &&
      userSnapshot.get('deletionScheduled') !== true
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This account has no scheduled deletion to cancel.',
      );
    }

    // The account keeps the activation state it had before the deletion was
    // scheduled. A banned account therefore stays banned.
    //
    // A legacy scheduled deletion can have no stored activation state. That
    // state is ambiguous, so the cancellation fails closed and leaves the
    // account inactive instead of guessing that it used to be active.
    const storedPrevious = userSnapshot.get('deletionPreviousIsActive');
    const jobPrevious = jobSnapshot.exists
      ? jobSnapshot.get('previousIsActive')
      : undefined;
    const hasAdministrativeDisableMarker =
      accountHasAdministrativeDisableMarker(userSnapshot);
    const previousIsActive = hasAdministrativeDisableMarker
      ? false
      : typeof storedPrevious === 'boolean'
        ? storedPrevious
        : typeof jobPrevious === 'boolean'
          ? jobPrevious
          : false;

    // The profile stays inactive until Auth has been enabled again. The
    // durable record below keeps the restore retryable.
    transaction.update(userRef, {
      deletionScheduled: false,
      deletionScheduledAt: null,
      deletionRequestedBy: null,
      deleteAfter: null,
      deletionState: 'restoring',
      deletionPreviousIsActive: previousIsActive,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });

    transaction.set(
      jobRef,
      {
        type: ACCOUNT_DELETION_JOB_TYPE,
        uid,
        status: 'cancelled',
        source: 'scheduled-grace-period',
        requestedBy: adminUid,
        deletionClaimed: false,
        deleteAfter: firestore.FieldValue.delete(),
        authEnablePending: previousIsActive,
        authDisablePending: !previousIsActive,
        previousIsActive,
        authStateRevision: nextAccountAuthStateRevision(jobSnapshot),
        restoreToken,
        attempts: jobSnapshot.exists
          ? Number(jobSnapshot.get('attempts') || 0)
          : 0,
        createdAt:
          jobSnapshot.exists && jobSnapshot.get('createdAt') !== undefined
            ? jobSnapshot.get('createdAt')
            : firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  // Restore Auth as well. A failure leaves the cancelled job pending so the
  // scheduled worker can retry the Auth transition; the callable never claims
  // that the account is fully restored while Auth still disagrees.
  try {
    const restored = await finishCancelledAccountDeletion(
      jobRef,
      uid,
      restoreToken,
    );
    if (!restored) {
      throw new functions.https.HttpsError(
        'internal',
        'The deletion was cancelled, but the account could not be restored yet. The server will retry.',
      );
    }
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Failed to re-enable the account:', error);
    throw new functions.https.HttpsError(
      'internal',
      'The deletion was cancelled, but Auth could not re-enable the account yet. The server will retry.',
    );
  }

  const restoredProfile = await userRef.get();
  const accountIsActive = restoredProfile.get('isActive') === true;
  await notify(
    uid,
    accountIsActive
      ? 'Your account was restored'
      : 'Your scheduled deletion was cancelled',
    accountIsActive
      ? 'The scheduled deletion of your StayServe account was cancelled. ' +
        'Your account is active again.'
      : 'The scheduled deletion of your StayServe account was cancelled. ' +
        'The account remains disabled because it was banned.',
    'account',
    { uid },
  );

  return { success: true, uid, isActive: accountIsActive };
});

/**
 * Deletes every account whose seven days are over.
 *
 * Runs once a day. The query only asks for the accounts that are marked for
 * deletion — the date is checked in the code, because a range query on a
 * timestamp together with an equality filter would need an extra composite
 * index.
 */
export const processScheduledDeletions = functions.pubsub
  .schedule('every day 03:00')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const now = Date.now();
    let deleted = 0;
    let failed = 0;
    let cursor: firestore.QueryDocumentSnapshot | undefined;

    // The scheduled profiles are walked in bounded pages. An account
    // administrator with many profiles must not turn one daily invocation
    // into an unbounded Firestore read.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let query = db
        .collection('users')
        .where('deletionScheduled', '==', true)
        .orderBy(firestore.FieldPath.documentId());
      if (cursor) query = query.startAfter(cursor);
      const pending = await query.limit(PAGE_SIZE).get();
      if (pending.empty) break;

      for (const doc of pending.docs) {
        const data = doc.data() || {};
        const deleteAfter = data.deleteAfter;
        const due =
          deleteAfter &&
          typeof deleteAfter.toMillis === 'function' &&
          deleteAfter.toMillis() <= now;

        if (!due) continue;

        const uid = doc.id;
        try {
          // Claim the due deletion transactionally. A cancellation which was
          // committed first wins; once this claim commits, a later cancellation
          // is told that the deletion has already started.
          const jobRef = db
            .collection('accountDeletionJobs')
            .doc(accountDeletionJobId(uid));
          if (
            !(await claimScheduledAccountDeletion(jobRef, uid, now))
          ) {
            continue;
          }
          if (await processAccountDeletionJob(jobRef)) {
            deleted += 1;
            console.log(`Deleted the account ${uid} — the seven days were over.`);
          }
        } catch (error) {
          failed += 1;
          console.error(`Failed to delete the account ${uid}:`, error);
        }
      }

      cursor = pending.docs[pending.docs.length - 1];
      if (pending.size < PAGE_SIZE) break;
    }

    if (failed > 0) {
      throw new Error(`${failed} scheduled account deletion(s) failed`);
    }

    console.log(`Scheduled deletions: ${deleted} account(s) deleted.`);
    return null;
  });
