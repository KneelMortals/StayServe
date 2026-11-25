import * as functions from 'firebase-functions/v1';
import * as firestore from 'firebase-admin/firestore';

import { callableHttps } from './appCheck';
import {
  assertActiveAccount,
  assertLiveVerifiedPhone,
  canActAsAdmin,
} from './accounts';
import {
  canActAsRoomOwner,
  canBookAsStudent,
} from './bookingAccess';
import {
  ADMIN_SUPPORT_CONVERSATION_OPERATIONS,
  ADMIN_SUPPORT_IDENTITY,
  scrubAdministratorMessageIdentities,
} from './adminSupport';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = firestore.getFirestore();

/** The normalized role stored in a user profile. */
function participantRole(snapshot: firestore.DocumentSnapshot): string {
  if (!snapshot.exists) return '';
  return String(snapshot.get('role') || '')
    .trim()
    .toLowerCase();
}

/**
 * Verifies the live phone of a student or owner interaction participant.
 *
 * Administrators do not participate as tenants and remain exempt from the
 * phone requirement. An invalid role is left to the transaction-time
 * role/registration/activity checks, which fail closed.
 */
async function assertLiveParticipantPhone(
  uid: string,
  role: string,
): Promise<void> {
  if (role === 'student' || role === 'owner') {
    await assertLiveVerifiedPhone(uid);
  }
}

/**
 * Ensures that the participant still has the role which was checked against
 * live Firebase Auth before the transaction started.
 */
function assertParticipantRoleUnchanged(
  snapshot: firestore.DocumentSnapshot,
  expectedRole: string,
  message: string,
): void {
  if (participantRole(snapshot) !== expectedRole) {
    throw new functions.https.HttpsError('failed-precondition', message);
  }
}

/**
 * A personal block between two StayServe accounts.
 *
 * The block is stored below the blocker, so the direction is explicit:
 *
 *   userBlocks/{blockerId}/blockedUsers/{blockedUserId}
 *
 * The documents are server-owned. Clients never need to read the collection
 * directly; the interaction callables return the two booleans they need and
 * the Firestore rules use the documents to refuse new chat messages.
 */
export function blockedUserRef(
  blockerId: string,
  blockedUserId: string,
): firestore.DocumentReference {
  return db
    .collection('userBlocks')
    .doc(blockerId)
    .collection('blockedUsers')
    .doc(blockedUserId);
}

/** The two directional block flags for a pair of accounts. */
export interface PairBlockState {
  firstBlockedSecond: boolean;
  secondBlockedFirst: boolean;
}

/** Whether either account has blocked the other. */
export function pairIsEffectivelyBlocked(state: PairBlockState): boolean {
  return state.firstBlockedSecond || state.secondBlockedFirst;
}

/** Removes control characters and limits a user-controlled display string. */
export function safeDisplayText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

/**
 * The readable name stored on a user profile.
 *
 * Only the name is ever copied into a request or conversation. The rest of
 * the private profile — including the email address — stays private.
 */
export function profileDisplayName(
  snapshot: firestore.DocumentSnapshot,
): string {
  if (!snapshot.exists) return '';
  const data = snapshot.data() as Record<string, any>;
  return safeDisplayText(data.name, 80);
}

/** A bounded room/listing title copied into server-owned metadata. */
export function safeRoomTitle(value: unknown): string {
  return safeDisplayText(value, 120);
}

/** Whether the live profile may act as a student. */
function isLiveStudentAccount(snapshot: firestore.DocumentSnapshot): boolean {
  return canBookAsStudent({
    exists: snapshot.exists,
    registrationCompleted: snapshot.get('registrationCompleted'),
    isActive: snapshot.get('isActive'),
    role: snapshot.get('role'),
  });
}

/** Whether the live profile may act as a room owner. */
function isLiveOwnerAccount(snapshot: firestore.DocumentSnapshot): boolean {
  return canActAsRoomOwner({
    exists: snapshot.exists,
    registrationCompleted: snapshot.get('registrationCompleted'),
    isActive: snapshot.get('isActive'),
    role: snapshot.get('role'),
  });
}

/** Whether the live profile may take part in a student-owner interaction. */
function isLiveInteractionAccount(
  snapshot: firestore.DocumentSnapshot,
): boolean {
  return isLiveStudentAccount(snapshot) || isLiveOwnerAccount(snapshot);
}

/**
 * Reads the block documents for a pair inside a transaction.
 *
 * Booking and chat transitions use this helper in the same transaction as
 * their protected write. A block which commits first therefore wins, and a
 * transition which commits first is observed by the later block operation.
 */
export async function readPairBlockStateInTransaction(
  transaction: firestore.Transaction,
  firstUserId: string,
  secondUserId: string,
): Promise<PairBlockState> {
  const sortedIds = normalizedInteractionPair(firstUserId, secondUserId);

  // Every transaction reads the two block documents in the same global
  // order. Without this, the student/owner and owner/student call sites
  // could acquire the same locks in opposite orders and abort repeatedly.
  const firstSnapshot = await transaction.get(
    blockedUserRef(sortedIds[0], sortedIds[1]),
  );
  const secondSnapshot = await transaction.get(
    blockedUserRef(sortedIds[1], sortedIds[0]),
  );
  const firstBlockedSecond = firstSnapshot.exists;
  const secondBlockedFirst = secondSnapshot.exists;
  return sortedIds[0] === firstUserId
    ? { firstBlockedSecond, secondBlockedFirst }
    : { firstBlockedSecond: secondBlockedFirst, secondBlockedFirst: firstBlockedSecond };
}

/** Reads the block documents for a pair outside a transaction. */
export async function readPairBlockState(
  firstUserId: string,
  secondUserId: string,
): Promise<PairBlockState> {
  const sortedIds = normalizedInteractionPair(firstUserId, secondUserId);
  const [firstSnapshot, secondSnapshot] = await Promise.all([
    blockedUserRef(sortedIds[0], sortedIds[1]).get(),
    blockedUserRef(sortedIds[1], sortedIds[0]).get(),
  ]);
  const firstBlockedSecond = firstSnapshot.exists;
  const secondBlockedFirst = secondSnapshot.exists;
  return sortedIds[0] === firstUserId
    ? { firstBlockedSecond, secondBlockedFirst }
    : { firstBlockedSecond: secondBlockedFirst, secondBlockedFirst: firstBlockedSecond };
}

/** Refuses a protected operation when either side has blocked the other. */
export function assertPairIsNotBlocked(state: PairBlockState): void {
  if (!pairIsEffectivelyBlocked(state)) return;
  throw new functions.https.HttpsError(
    'failed-precondition',
    'This interaction is unavailable because one account has blocked the other.',
  );
}

/**
 * Validates and normalizes the two identities used for a personal block.
 *
 * The block ids are Firestore document ids. An empty or duplicated identity
 * would otherwise reach `.doc(...)` and surface as an internal server error
 * instead of the expected, actionable precondition failure.
 */
function normalizedInteractionPair(
  firstUserId: string,
  secondUserId: string,
): [string, string] {
  const first = firstUserId.trim();
  const second = secondUserId.trim();
  if (!first || !second || first === second) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This interaction does not identify two different participants.',
    );
  }
  return [first, second].sort() as [string, string];
}

function participantIdsFromConversation(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (id): id is string =>
          typeof id === 'string' && id.trim().length > 0,
      ),
    ),
  );
}

/**
 * Whether the server-only operation exactly describes an opaque support
 * conversation.
 *
 * The operation is the only place where the real administrator uid is kept.
 * It authorizes that administrator to read the channel without exposing the
 * uid in a tenant-readable conversation document.
 */
function adminSupportOperationMatches(
  conversationId: string,
  conversation: Record<string, any>,
  participantIds: string[],
  operationSnapshot: firestore.DocumentSnapshot | undefined,
): boolean {
  if (!operationSnapshot?.exists) return false;
  const operation = operationSnapshot.data() as Record<string, any>;
  const conversationAdminId = String(conversation.adminId || '').trim();
  const operationAdminUid = String(operation.adminUid || '').trim();
  const targetUid = String(operation.targetUid || '').trim();
  return (
    conversationAdminId === ADMIN_SUPPORT_IDENTITY &&
    String(operation.conversationId || '').trim() === conversationId &&
    String(operation.adminIdentity || '').trim() === conversationAdminId &&
    operationAdminUid.length > 0 &&
    targetUid.length > 0 &&
    participantIds.includes(conversationAdminId) &&
    participantIds.includes(targetUid)
  );
}

/**
 * Migrates a legacy support conversation before it is returned to a client.
 *
 * Legacy conversations stored the administrator's raw uid in the parent and
 * in message sender/receiver fields. The direct Firestore rules refuse those
 * records. This server-only migration creates the durable party mapping,
 * fences message writes, scrubs the old messages and then publishes the
 * opaque identity in one final parent update.
 */
async function migrateLegacyAdminSupportConversation(
  conversationRef: firestore.DocumentReference,
  conversationId: string,
): Promise<void> {
  const initialSnapshot = await conversationRef.get();
  if (!initialSnapshot.exists) return;
  const initialData = initialSnapshot.data() as Record<string, any>;
  if (initialData.conversationType !== 'adminSupport') return;

  const operationRef = db
    .collection(ADMIN_SUPPORT_CONVERSATION_OPERATIONS)
    .doc(conversationId);
  const rawAdminId = String(initialData.adminId || '').trim();
  const privacyMigrationInProgress =
    initialData.privacyMigrationInProgress === true;

  if (rawAdminId === ADMIN_SUPPORT_IDENTITY) {
    if (!privacyMigrationInProgress) return;
    const operationSnapshot = await operationRef.get();
    if (!operationSnapshot.exists) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This administrator conversation is malformed.',
      );
    }
    const operation = operationSnapshot.data() as Record<string, any>;
    const adminUid = String(operation.adminUid || '').trim();
    if (!adminUid) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This administrator conversation is malformed.',
      );
    }
    await scrubAdministratorMessageIdentities({
      db,
      conversationRef,
      adminUid,
      adminIdentity: ADMIN_SUPPORT_IDENTITY,
    });
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(conversationRef);
      if (!current.exists) return;
      if (
        current.get('conversationType') !== 'adminSupport' ||
        String(current.get('adminId') || '').trim() !== ADMIN_SUPPORT_IDENTITY
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This administrator conversation is malformed.',
        );
      }
      transaction.update(conversationRef, {
        privacyMigrationInProgress: firestore.FieldValue.delete(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
    });
    return;
  }

  const participants = participantIdsFromConversation(
    initialData.participantIds,
  );
  if (
    participants.length !== 2 ||
    !rawAdminId ||
    !participants.includes(rawAdminId)
  ) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This administrator conversation is malformed.',
    );
  }
  const targetUid =
    participants.find((participantId) => participantId !== rawAdminId) || '';
  if (!targetUid) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This administrator conversation does not identify a recipient.',
    );
  }

  const initialOperationSnapshot = await operationRef.get();
  if (initialOperationSnapshot.exists) {
    const operation = initialOperationSnapshot.data() as Record<string, any>;
    if (
      String(operation.adminUid || '').trim() !== rawAdminId ||
      String(operation.targetUid || '').trim() !== targetUid ||
      String(operation.conversationId || '').trim() !== conversationId
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This administrator conversation is malformed.',
      );
    }
  }

  const [adminSnapshot, targetSnapshot] = await Promise.all([
    db.collection('users').doc(rawAdminId).get(),
    db.collection('users').doc(targetUid).get(),
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
      'The administrator for this conversation is no longer available.',
    );
  }
  if (!isLiveInteractionAccount(targetSnapshot)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'The recipient is no longer available for this conversation.',
    );
  }

  // Fence the legacy parent before any message is changed. Direct reads stay
  // denied while the parent still contains the raw uid, and the marker also
  // prevents a late target reply from reintroducing that uid.
  await db.runTransaction(async (transaction) => {
    const [current, operation] = await Promise.all([
      transaction.get(conversationRef),
      transaction.get(operationRef),
    ]);
    if (!current.exists) return;
    const currentData = current.data() as Record<string, any>;
    const currentAdminId = String(currentData.adminId || '').trim();
    const currentParticipants = participantIdsFromConversation(
      currentData.participantIds,
    );
    if (
      currentData.conversationType !== 'adminSupport' ||
      (currentAdminId !== rawAdminId &&
        currentAdminId !== ADMIN_SUPPORT_IDENTITY)
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This administrator conversation is malformed.',
      );
    }
    if (
      currentAdminId === rawAdminId &&
      (currentParticipants.length !== 2 ||
        !currentParticipants.includes(rawAdminId) ||
        !currentParticipants.includes(targetUid))
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This administrator conversation is malformed.',
      );
    }
    if (operation.exists) {
      const operationData = operation.data() as Record<string, any>;
      if (
        String(operationData.adminUid || '').trim() !== rawAdminId ||
        String(operationData.targetUid || '').trim() !== targetUid ||
        String(operationData.conversationId || '').trim() !== conversationId
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This administrator conversation is malformed.',
        );
      }
    } else {
      transaction.set(operationRef, {
        operationId: conversationId,
        conversationId,
        adminUid: rawAdminId,
        adminIdentity: ADMIN_SUPPORT_IDENTITY,
        targetUid,
        sourceType: 'adminSupportConversation',
        createdAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      });
    }
    transaction.update(conversationRef, {
      privacyMigrationInProgress: true,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
  });

  await scrubAdministratorMessageIdentities({
    db,
    conversationRef,
    adminUid: rawAdminId,
    adminIdentity: ADMIN_SUPPORT_IDENTITY,
  });

  await db.runTransaction(async (transaction) => {
    const [current, operation] = await Promise.all([
      transaction.get(conversationRef),
      transaction.get(operationRef),
    ]);
    if (!current.exists) return;
    const currentData = current.data() as Record<string, any>;
    const currentAdminId = String(currentData.adminId || '').trim();
    if (currentData.conversationType !== 'adminSupport') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This administrator conversation is malformed.',
      );
    }
    if (
      currentAdminId !== rawAdminId &&
      currentAdminId !== ADMIN_SUPPORT_IDENTITY
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This administrator conversation is malformed.',
      );
    }
    if (!operation.exists) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This administrator conversation is malformed.',
      );
    }
    const operationData = operation.data() as Record<string, any>;
    if (
      String(operationData.adminUid || '').trim() !== rawAdminId ||
      String(operationData.targetUid || '').trim() !== targetUid ||
      String(operationData.conversationId || '').trim() !== conversationId
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This administrator conversation is malformed.',
      );
    }

    const storedNames =
      currentData.participantNames &&
      typeof currentData.participantNames === 'object' &&
      !Array.isArray(currentData.participantNames)
        ? (currentData.participantNames as Record<string, unknown>)
        : {};
    const targetName =
      safeDisplayText(storedNames[targetUid], 80) || targetUid;
    const safeParticipantNames: Record<string, string> = {
      [ADMIN_SUPPORT_IDENTITY]: 'StayServe Admin',
      [targetUid]: targetName,
    };

    const safeUnreadCount: Record<string, number> = {};
    const storedUnread =
      currentData.unreadCount &&
      typeof currentData.unreadCount === 'object' &&
      !Array.isArray(currentData.unreadCount)
        ? (currentData.unreadCount as Record<string, unknown>)
        : {};
    for (const [participantId, value] of Object.entries(storedUnread)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        continue;
      }
      const safeParticipantId =
        participantId === rawAdminId ? ADMIN_SUPPORT_IDENTITY : participantId;
      safeUnreadCount[safeParticipantId] =
        (safeUnreadCount[safeParticipantId] || 0) + Math.floor(value);
    }

    const updates: Record<string, any> = {
      participantIds: [ADMIN_SUPPORT_IDENTITY, targetUid].sort(),
      participantNames: safeParticipantNames,
      conversationType: 'adminSupport',
      adminId: ADMIN_SUPPORT_IDENTITY,
      adminVerified: true,
      createdByServer: true,
      unreadCount: safeUnreadCount,
      privacyMigrationInProgress: firestore.FieldValue.delete(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    };
    if (String(currentData.deletionRequestedBy || '') === rawAdminId) {
      updates.deletionRequestedBy = ADMIN_SUPPORT_IDENTITY;
    }
    transaction.update(conversationRef, updates);
  });
}

/** Whether the pair has a real student-owner booking relationship. */
async function hasBookingRelationshipInTransaction(
  transaction: firestore.Transaction,
  userId: string,
  otherUserId: string,
): Promise<boolean> {
  const [studentSide, ownerSide] = await Promise.all([
    transaction.get(
      db
        .collection('joinRequests')
        .where('studentId', '==', userId)
        .where('ownerId', '==', otherUserId)
        .limit(1),
    ),
    transaction.get(
      db
        .collection('joinRequests')
        .where('studentId', '==', otherUserId)
        .where('ownerId', '==', userId)
        .limit(1),
    ),
  ]);
  return !studentSide.empty || !ownerSide.empty;
}

/** Whether a pair has a booking relationship outside a transaction. */
async function hasBookingRelationship(
  userId: string,
  otherUserId: string,
): Promise<boolean> {
  const [studentSide, ownerSide] = await Promise.all([
    db
      .collection('joinRequests')
      .where('studentId', '==', userId)
      .where('ownerId', '==', otherUserId)
      .limit(1)
      .get(),
    db
      .collection('joinRequests')
      .where('studentId', '==', otherUserId)
      .where('ownerId', '==', userId)
      .limit(1)
      .get(),
  ]);
  return !studentSide.empty || !ownerSide.empty;
}

/**
 * Whether two accounts have a legitimate StayServe relationship.
 *
 * A caller may only block somebody they booked with or contacted in a
 * server-verified conversation. The exact context is read by the server in
 * the same transaction as the block write; a guessed uid is not enough.
 */
async function hasInteractionRelationshipInTransaction(
  transaction: firestore.Transaction,
  userId: string,
  otherUserId: string,
  context: {
    requestId?: string;
    conversationId?: string;
  },
): Promise<boolean> {
  if (context.requestId) {
    const request = await transaction.get(
      db.collection('joinRequests').doc(context.requestId),
    );
    if (!request.exists) return false;
    const studentId = String(request.get('studentId') || '').trim();
    const ownerId = String(request.get('ownerId') || '').trim();
    return (
      (studentId === userId && ownerId === otherUserId) ||
      (ownerId === userId && studentId === otherUserId)
    );
  }

  if (context.conversationId) {
    const conversation = await transaction.get(
      db.collection('conversations').doc(context.conversationId),
    );
    if (!conversation.exists) return false;
    if (conversation.get('deletionInProgress') === true) return false;
    const participants = participantIdsFromConversation(
      conversation.get('participantIds'),
    );
    const participantsMatch =
      participants.length === 2 &&
      participants.includes(userId) &&
      participants.includes(otherUserId);
    if (!participantsMatch) return false;

    // Administrator support conversations are not student-owner
    // interactions. They are moderated support channels and do not create a
    // personal booking block.
    if (conversation.get('conversationType') === 'adminSupport') {
      return false;
    }

    // New conversations carry an explicit server-verification marker. A
    // legacy conversation is accepted only when a real booking proves the
    // same student-owner relationship.
    return (
      conversation.get('createdByServer') === true ||
      (await hasBookingRelationshipInTransaction(
        transaction,
        userId,
        otherUserId,
      ))
    );
  }

  return false;
}

/**
 * The display and safety details of a conversation.
 *
 * The peer profile cannot be read by an ordinary client, so the server
 * resolves the peer's name. It also reports whether either side has blocked
 * the other; the client uses those flags to make the chat read-only.
 */
export const getConversationInteractionDetails = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }

    const uid = context.auth.uid;
    const conversationId = String(data?.conversationId || '').trim();
    const requestedRoomId = String(data?.roomId || '').trim();
    const requestedRequestId = String(data?.requestId || '').trim();
    if (!conversationId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Missing conversation',
      );
    }

    await assertActiveAccount(uid);

    const conversationRef = db
      .collection('conversations')
      .doc(conversationId);

    // Legacy support records are never returned with their raw administrator
    // uid. Migrate them through the server-only mapping before resolving the
    // caller or peer.
    await migrateLegacyAdminSupportConversation(
      conversationRef,
      conversationId,
    );

    // Resolve and verify the peer before the transaction. The peer is a
    // student/owner in an ordinary interaction and may be an exempt
    // administrator in a support conversation. The transaction re-reads the
    // conversation and peer profile and refuses a changed peer or role.
    const preliminaryConversation = await conversationRef.get();
    if (!preliminaryConversation.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'This conversation no longer exists',
      );
    }
    const preliminaryData = preliminaryConversation.data() as Record<string, any>;
    const preliminaryParticipants = participantIdsFromConversation(
      preliminaryData.participantIds,
    );
    const preliminaryIsSupport =
      preliminaryData.conversationType === 'adminSupport';
    const preliminaryOperationSnapshot = preliminaryIsSupport
      ? await db
          .collection(ADMIN_SUPPORT_CONVERSATION_OPERATIONS)
          .doc(conversationId)
          .get()
      : undefined;
    const preliminaryUsesOpaqueAdmin =
      String(preliminaryData.adminId || '').trim() === ADMIN_SUPPORT_IDENTITY;
    if (
      preliminaryParticipants.length !== 2 ||
      (preliminaryUsesOpaqueAdmin &&
        !adminSupportOperationMatches(
          conversationId,
          preliminaryData,
          preliminaryParticipants,
          preliminaryOperationSnapshot,
        ))
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This administrator conversation is malformed.',
      );
    }

    const preliminaryCallerIsParticipant =
      preliminaryParticipants.includes(uid);
    let expectedPeerId = '';
    if (preliminaryCallerIsParticipant) {
      expectedPeerId =
        preliminaryParticipants.find((participantId) => participantId !== uid) ||
        '';
    } else if (
      preliminaryIsSupport &&
      preliminaryOperationSnapshot?.exists &&
      String(
        (preliminaryOperationSnapshot.data() as Record<string, any>).adminUid ||
          '',
      ).trim() === uid
    ) {
      // The real administrator is deliberately absent from the tenant-readable
      // participant list. The server-only operation proves that this account
      // owns the opaque support identity for this exact channel.
      expectedPeerId = String(
        (preliminaryOperationSnapshot.data() as Record<string, any>).targetUid ||
          '',
      ).trim();
    }

    if (!expectedPeerId || !preliminaryParticipants.includes(expectedPeerId)) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'This conversation belongs to somebody else',
      );
    }
    let expectedPeerRole = '';
    if (preliminaryIsSupport && expectedPeerId === ADMIN_SUPPORT_IDENTITY) {
      // The tenant's peer is the real administrator, whose role is checked
      // from the live administrator profile inside the transaction. The
      // opaque identity itself does not need a readable synthetic profile.
      expectedPeerRole = 'admin';
    } else {
      const preliminaryPeer = await db
        .collection('users')
        .doc(expectedPeerId)
        .get();
      expectedPeerRole = participantRole(preliminaryPeer);
    }
    await assertLiveParticipantPhone(expectedPeerId, expectedPeerRole);

    const details = await db.runTransaction(async (transaction) => {
      const [conversationSnapshot, supportOperationSnapshot] =
        await Promise.all([
          transaction.get(conversationRef),
          transaction.get(
            db
              .collection(ADMIN_SUPPORT_CONVERSATION_OPERATIONS)
              .doc(conversationId),
          ),
        ]);
      if (!conversationSnapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'This conversation no longer exists',
        );
      }

      const conversation =
        conversationSnapshot.data() as Record<string, any>;
      const participantIds = participantIdsFromConversation(
        conversation.participantIds,
      );
      const isSupportConversation =
        conversation.conversationType === 'adminSupport';
      const usesOpaqueAdmin =
        String(conversation.adminId || '').trim() === ADMIN_SUPPORT_IDENTITY;
      const supportOperationMatches = adminSupportOperationMatches(
        conversationId,
        conversation,
        participantIds,
        supportOperationSnapshot,
      );
      const callerIsParticipant = participantIds.includes(uid);
      const callerIsMappedAdmin =
        isSupportConversation &&
        supportOperationMatches &&
        String(
          (supportOperationSnapshot?.data() as Record<string, any> | undefined)
            ?.adminUid || '',
        ).trim() === uid;

      if (
        participantIds.length !== 2 ||
        (usesOpaqueAdmin && !supportOperationMatches)
      ) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This administrator conversation is malformed.',
        );
      }
      if (!callerIsParticipant && !callerIsMappedAdmin) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'This conversation belongs to somebody else',
        );
      }

      const peerId = callerIsParticipant
        ? participantIds.find((id) => id !== uid) || ''
        : String(
            (supportOperationSnapshot?.data() as Record<string, any> | undefined)
              ?.targetUid || '',
          ).trim();
      if (peerId !== expectedPeerId) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The other participant is no longer available for this conversation.',
        );
      }

      // Administrator support conversations are a separate, server-owned
      // route. They have exactly one live administrator and one live
      // student/owner; they are not tied to a room or a booking request.
      if (conversation.conversationType === 'adminSupport') {
        const adminId = String(conversation.adminId || '').trim();
        if (
          !adminId ||
          conversation.adminVerified !== true ||
          !participantIds.includes(adminId)
        ) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'This administrator conversation is malformed.',
          );
        }

        const targetId = participantIds.find((id) => id !== adminId) || '';
        if (!targetId) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'This administrator conversation does not identify a recipient.',
          );
        }

        const operation = supportOperationSnapshot?.exists
          ? (supportOperationSnapshot.data() as Record<string, any>)
          : null;
        const operationAdminUid = String(operation?.adminUid || '').trim();
        if (!supportOperationMatches || !operationAdminUid) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'This administrator conversation is malformed.',
          );
        }
        const actualAdminUid = operationAdminUid;

        const [adminSnapshot, targetSnapshot] = await Promise.all([
          transaction.get(db.collection('users').doc(actualAdminUid)),
          transaction.get(db.collection('users').doc(targetId)),
        ]);
        const callerIsAdmin = uid === actualAdminUid;
        assertParticipantRoleUnchanged(
          callerIsAdmin ? targetSnapshot : adminSnapshot,
          expectedPeerRole,
          'The other participant is no longer available for this conversation.',
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
            'The administrator for this conversation is no longer available.',
          );
        }
        if (!isLiveInteractionAccount(targetSnapshot)) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'The recipient is no longer available for this conversation.',
          );
        }

        const targetName =
          profileDisplayName(targetSnapshot) ||
          safeDisplayText(targetSnapshot.get('email'), 80).split('@')[0] ||
          targetId;
        return {
          success: true,
          conversationId,
          peerId: callerIsAdmin ? targetId : adminId,
          peerName: callerIsAdmin ? targetName : 'StayServe Admin',
          peerRole: callerIsAdmin
            ? String(targetSnapshot.get('role') || '').trim().toLowerCase()
            : 'admin',
          roomId: '',
          roomTitle: 'StayServe Support',
          requestId: null,
          blockedByMe: false,
          blockedMe: false,
          blockedByCaller: false,
          callerBlockedByPeer: false,
          canSend: true,
          isAdminSupport: true,
        };
      }

      const contextId = requestedRequestId || requestedRoomId;
      const contextSnapshot = contextId
        ? await transaction.get(
            conversationRef.collection('contexts').doc(contextId),
          )
        : null;
      const context =
        contextSnapshot?.exists
          ? (contextSnapshot.data() as Record<string, any>)
          : null;

      let requestSnapshot: firestore.DocumentSnapshot | null = null;
      if (requestedRequestId) {
        requestSnapshot = await transaction.get(
          db.collection('joinRequests').doc(requestedRequestId),
        );
        if (!requestSnapshot.exists) {
          throw new functions.https.HttpsError(
            'not-found',
            'This booking request no longer exists',
          );
        }
        const request = requestSnapshot.data() as Record<string, any>;
        const studentId = String(request.studentId || '').trim();
        const ownerId = String(request.ownerId || '').trim();
        if (
          (uid !== studentId && uid !== ownerId) ||
          (uid === studentId && ownerId !== peerId) ||
          (uid === ownerId && studentId !== peerId)
        ) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'This booking request belongs to somebody else',
          );
        }
      }

      const roomId =
        String(context?.roomId || '').trim() ||
        String(
          requestSnapshot?.exists ? requestSnapshot.get('roomId') : '',
        ).trim() ||
        requestedRoomId ||
        String(conversation.roomId || '').trim();
      const [callerSnapshot, peerSnapshot, roomSnapshot, blockState] =
        await Promise.all([
          transaction.get(db.collection('users').doc(uid)),
          transaction.get(db.collection('users').doc(peerId)),
          roomId
            ? transaction.get(db.collection('rooms').doc(roomId))
            : Promise.resolve(null),
          readPairBlockStateInTransaction(transaction, uid, peerId),
        ]);

      assertParticipantRoleUnchanged(
        peerSnapshot,
        expectedPeerRole,
        'The other participant is no longer available for this conversation.',
      );
      const peerRole = String(peerSnapshot.get('role') || '')
        .trim()
        .toLowerCase();
      const callerIsLiveStudent = isLiveStudentAccount(callerSnapshot);
      const callerIsLiveOwner = isLiveOwnerAccount(callerSnapshot);
      if (!callerIsLiveStudent && !callerIsLiveOwner) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Only a live student or owner account can view conversation details.',
        );
      }
      if (!isLiveInteractionAccount(peerSnapshot)) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'The other participant is no longer available for this conversation.',
        );
      }

      // A request-backed chat has an unambiguous student/owner direction.
      // The role is checked again from the profile snapshot in this
      // transaction, so a demotion or ban cannot race the metadata read.
      if (requestSnapshot?.exists) {
        const requestStudentId = String(
          requestSnapshot.get('studentId') || '',
        ).trim();
        const requestOwnerId = String(
          requestSnapshot.get('ownerId') || '',
        ).trim();
        if (
          !requestStudentId ||
          !requestOwnerId ||
          requestStudentId === requestOwnerId
        ) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            'This booking request does not identify two different participants.',
          );
        }
        if (uid === requestStudentId && !callerIsLiveStudent) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'Only a live student account can view this conversation.',
          );
        }
        if (uid === requestOwnerId && !callerIsLiveOwner) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'Only a live owner account can view this conversation.',
          );
        }
        const requestStudentSnapshot =
          requestStudentId === uid ? callerSnapshot : peerSnapshot;
        const requestOwnerSnapshot =
          requestOwnerId === uid ? callerSnapshot : peerSnapshot;
        if (
          !isLiveStudentAccount(requestStudentSnapshot) ||
          !isLiveOwnerAccount(requestOwnerSnapshot)
        ) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'One of the booking accounts is no longer available.',
          );
        }
      }

      const storedParticipantNames =
        conversation.participantNames &&
        typeof conversation.participantNames === 'object'
          ? (conversation.participantNames as Record<string, unknown>)
          : {};
      const requestStudentId = String(
        requestSnapshot?.get('studentId') || '',
      ).trim();
      const requestOwnerId = String(
        requestSnapshot?.get('ownerId') || '',
      ).trim();
      const requestPeerCurrentName =
        peerId === requestStudentId
          ? safeDisplayText(requestSnapshot?.get('studentName'), 80)
          : peerId === requestOwnerId
          ? safeDisplayText(requestSnapshot?.get('ownerName'), 80)
          : '';
      const requestPeerSnapshotName =
        peerId === requestStudentId
          ? safeDisplayText(requestSnapshot?.get('studentNameAtRequest'), 80)
          : peerId === requestOwnerId
          ? safeDisplayText(requestSnapshot?.get('ownerNameAtRequest'), 80)
          : '';
      const requestCallerCurrentName =
        uid === requestStudentId
          ? safeDisplayText(requestSnapshot?.get('studentName'), 80)
          : uid === requestOwnerId
          ? safeDisplayText(requestSnapshot?.get('ownerName'), 80)
          : '';
      const requestCallerSnapshotName =
        uid === requestStudentId
          ? safeDisplayText(requestSnapshot?.get('studentNameAtRequest'), 80)
          : uid === requestOwnerId
          ? safeDisplayText(requestSnapshot?.get('ownerNameAtRequest'), 80)
          : '';
      const peerName =
        profileDisplayName(peerSnapshot) ||
        safeDisplayText(storedParticipantNames[peerId], 80) ||
        requestPeerCurrentName ||
        requestPeerSnapshotName ||
        peerId;
      const callerName =
        profileDisplayName(callerSnapshot) ||
        safeDisplayText(storedParticipantNames[uid], 80) ||
        requestCallerCurrentName ||
        requestCallerSnapshotName ||
        uid;
      const room = roomSnapshot?.data() as Record<string, any> | undefined;
      const roomOwnerId = String(roomSnapshot?.get('ownerId') || '').trim();
      if (roomSnapshot?.exists) {
        // The owner may open the same chat from the booking-request screen.
        // In that direction the owner is the **caller** and the student is
        // the peer, so the listing owner has to be compared with both
        // participants rather than with the peer alone.
        const roomOwnerParticipantId =
          roomOwnerId === uid ? uid : roomOwnerId === peerId ? peerId : '';
        if (!roomOwnerParticipantId) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'The room owner must be one of the conversation participants.',
          );
        }
        if (requestSnapshot?.exists) {
          const requestOwnerId = String(
            requestSnapshot.get('ownerId') || '',
          ).trim();
          if (requestOwnerId !== roomOwnerId) {
            throw new functions.https.HttpsError(
              'permission-denied',
              'The room does not match this booking request.',
            );
          }
        } else if (
          roomOwnerParticipantId === uid &&
          (!callerIsLiveOwner || !isLiveStudentAccount(peerSnapshot))
        ) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'This conversation requires a live owner and a live student.',
          );
        } else if (
          roomOwnerParticipantId === peerId &&
          (!callerIsLiveStudent || !isLiveOwnerAccount(peerSnapshot))
        ) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'This conversation requires a live owner and a live student.',
          );
        }
      }
      // A request-scoped context keeps the listing title which opened the
      // chat. The live title remains the current value on the room and on
      // the request; the captured title is only the stable chat context.
      const roomTitle =
        safeRoomTitle(context?.roomTitle) ||
        safeRoomTitle(room?.title) ||
        safeRoomTitle(conversation.roomTitle) ||
        safeRoomTitle(requestSnapshot?.get('roomTitle')) ||
        safeRoomTitle(requestSnapshot?.get('roomTitleAtRequest'));

      // The metadata is server-owned. Backfill older conversations which
      // predate the participant-name fields, but do not write when every
      // value is already current. Read-only metadata calls must not create
      // a new parent-document version on every poll.
      const nextParticipantNames = {
        [uid]: callerName,
        [peerId]: peerName,
      };
      const participantNamesChanged =
        Object.keys(storedParticipantNames).length !==
          Object.keys(nextParticipantNames).length ||
        Object.entries(nextParticipantNames).some(
          ([participantId, name]) => storedParticipantNames[participantId] !== name,
        );
      const conversationUpdates: Record<string, any> = {};
      if (participantNamesChanged) {
        conversationUpdates.participantNames = nextParticipantNames;
      }
      if (!contextId && conversation.roomTitle !== roomTitle) {
        conversationUpdates.roomTitle = roomTitle;
      }
      if (Object.keys(conversationUpdates).length > 0) {
        transaction.update(conversationRef, conversationUpdates);
      }

      return {
        success: true,
        conversationId,
        peerId,
        peerName,
        peerRole: String(peerSnapshot.get('role') || '').trim(),
        roomId,
        roomTitle,
        requestId: requestedRequestId || null,
        blockedByMe: blockState.firstBlockedSecond,
        blockedMe: blockState.secondBlockedFirst,
        blockedByCaller: blockState.firstBlockedSecond,
        callerBlockedByPeer: blockState.secondBlockedFirst,
        canSend: !pairIsEffectivelyBlocked(blockState),
        isAdminSupport: false,
      };
    });

    return details;
  },
);

/**
 * The display and safety details of a booking request.
 *
 * The names are resolved by the server because an owner cannot read a
 * student's private profile document directly. The block flags are dynamic:
 * they always describe the current state and are never copied into the
 * booking itself.
 */
export const getBookingInteractionDetails = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }

    const uid = context.auth.uid;
    const requestId = String(data?.requestId || '').trim();
    if (!requestId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Missing booking request',
      );
    }

    await assertActiveAccount(uid);

    const requestRef = db.collection('joinRequests').doc(requestId);

    // A participant viewing a booking interacts with the other party, so the
    // peer's live Firebase phone is verified before the transaction. An
    // administrator is only reviewing the record and remains exempt. The
    // transaction re-reads the request and profiles and verifies that the
    // participant identities and roles did not change.
    const preliminaryRequest = await requestRef.get();
    if (!preliminaryRequest.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'This booking request no longer exists',
      );
    }
    const preliminaryData = preliminaryRequest.data() as Record<string, any>;
    const expectedStudentId = String(preliminaryData.studentId || '').trim();
    const expectedOwnerId = String(preliminaryData.ownerId || '').trim();
    let expectedPeerId = '';
    let expectedPeerRole = '';
    if (uid === expectedStudentId) {
      expectedPeerId = expectedOwnerId;
    } else if (uid === expectedOwnerId) {
      expectedPeerId = expectedStudentId;
    }
    if (expectedPeerId) {
      const preliminaryPeer = await db
        .collection('users')
        .doc(expectedPeerId)
        .get();
      expectedPeerRole = participantRole(preliminaryPeer);
      await assertLiveParticipantPhone(
        expectedPeerId,
        expectedPeerRole,
      );
    }

    return db.runTransaction(async (transaction) => {
      const requestSnapshot = await transaction.get(requestRef);
      if (!requestSnapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'This booking request no longer exists',
        );
      }

      const request = requestSnapshot.data() as Record<string, any>;
      const studentId = String(request.studentId || '').trim();
      const ownerId = String(request.ownerId || '').trim();
      if (!studentId || !ownerId || studentId === ownerId) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This booking request does not identify two different participants',
        );
      }
      if (studentId !== expectedStudentId || ownerId !== expectedOwnerId) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The participants on this booking request changed. Please try again.',
        );
      }

      const roomId = String(request.roomId || '').trim();
      const [
        callerSnapshot,
        studentSnapshot,
        ownerSnapshot,
        roomSnapshot,
        blockState,
      ] = await Promise.all([
        transaction.get(db.collection('users').doc(uid)),
        transaction.get(db.collection('users').doc(studentId)),
        transaction.get(db.collection('users').doc(ownerId)),
        roomId
          ? transaction.get(db.collection('rooms').doc(roomId))
          : Promise.resolve(null),
        readPairBlockStateInTransaction(transaction, studentId, ownerId),
      ]);

      const callerIsParticipant = uid === studentId || uid === ownerId;
      const callerIsAdmin = canActAsAdmin({
        exists: callerSnapshot.exists,
        registrationCompleted: callerSnapshot.get('registrationCompleted'),
        isActive: callerSnapshot.get('isActive'),
        role: callerSnapshot.get('role'),
      });
      if (!callerIsParticipant && !callerIsAdmin) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'This booking request belongs to somebody else',
        );
      }
      if (callerIsParticipant && !callerIsAdmin) {
        assertParticipantRoleUnchanged(
          uid === studentId ? ownerSnapshot : studentSnapshot,
          expectedPeerRole,
          'The other participant is no longer available for this booking request.',
        );
        if (uid === studentId && !isLiveStudentAccount(callerSnapshot)) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'Only a live student account can view this booking request.',
          );
        }
        if (uid === ownerId && !isLiveOwnerAccount(callerSnapshot)) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'Only a live owner account can view this booking request.',
          );
        }
        if (
          !isLiveStudentAccount(studentSnapshot) ||
          !isLiveOwnerAccount(ownerSnapshot)
        ) {
          throw new functions.https.HttpsError(
            'permission-denied',
            'One of the booking accounts is no longer available.',
          );
        }
      }

      const room = roomSnapshot?.data() as Record<string, any> | undefined;
      // The unsuffixed fields are the current display values. The
      // `AtRequest` fields are immutable request-time snapshots and are only
      // used when neither the live profile nor the current value is present.
      const studentName =
        profileDisplayName(studentSnapshot) ||
        safeDisplayText(request.studentName, 80) ||
        safeDisplayText(request.studentNameAtRequest, 80) ||
        studentId;
      const ownerName =
        profileDisplayName(ownerSnapshot) ||
        safeDisplayText(request.ownerName, 80) ||
        safeDisplayText(request.ownerNameAtRequest, 80) ||
        ownerId;
      const roomTitle =
        safeRoomTitle(room?.title) ||
        safeRoomTitle(request.roomTitle) ||
        safeRoomTitle(request.roomTitleAtRequest);

      // Backfill older requests with the server-resolved display metadata.
      // The booking state and money fields are not touched. Avoid a write
      // when the values are already current so a read-only detail call does
      // not contend with the booking transitions.
      const requestUpdates: Record<string, any> = {};
      if (request.studentName !== studentName) {
        requestUpdates.studentName = studentName;
      }
      if (request.ownerName !== ownerName) {
        requestUpdates.ownerName = ownerName;
      }
      if (request.roomTitle !== roomTitle) {
        requestUpdates.roomTitle = roomTitle;
      }
      if (Object.keys(requestUpdates).length > 0) {
        transaction.update(requestRef, requestUpdates);
      }

      const callerIsStudent = uid === studentId;
      const callerIsOwner = uid === ownerId;
      const blockedByMe = callerIsStudent
        ? blockState.firstBlockedSecond
        : callerIsOwner
        ? blockState.secondBlockedFirst
        : false;
      const blockedMe = callerIsStudent
        ? blockState.secondBlockedFirst
        : callerIsOwner
        ? blockState.firstBlockedSecond
        : false;

      return {
        success: true,
        requestId,
        studentId,
        ownerId,
        studentName,
        ownerName,
        roomId,
        roomTitle,
        blockedByMe,
        blockedMe,
        blockedByCaller: blockedByMe,
        callerBlockedByPeer: blockedMe,
        canSend:
          callerIsParticipant && !pairIsEffectivelyBlocked(blockState),
      };
    });
  },
);

/**
 * The owner contact details shown before a student books a room.
 *
 * Only the public display name and the block state are returned. The owner's
 * private profile document is never exposed to the student.
 */
export const getRoomContactDetails = callableHttps.onCall(
  async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Please sign in first',
      );
    }

    const uid = context.auth.uid;
    await assertActiveAccount(uid);
    const roomId = String(data?.roomId || '').trim();
    if (!roomId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Missing room',
      );
    }

    // Resolve and verify the room owner before the transaction. The owner is
    // the other party in this student-to-owner interaction and therefore needs
    // a live verified Firebase phone. The transaction re-reads the listing
    // and owner profile and refuses a changed owner or role.
    const roomRef = db.collection('rooms').doc(roomId);
    const preliminaryRoom = await roomRef.get();
    if (!preliminaryRoom.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'That room no longer exists',
      );
    }
    const expectedOwnerId = String(
      preliminaryRoom.get('ownerId') || '',
    ).trim();
    if (!expectedOwnerId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This listing has no owner',
      );
    }
    if (expectedOwnerId === uid) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You cannot contact the owner of your own listing.',
      );
    }
    const preliminaryOwner = await db
      .collection('users')
      .doc(expectedOwnerId)
      .get();
    const expectedOwnerRole = participantRole(preliminaryOwner);
    await assertLiveParticipantPhone(
      expectedOwnerId,
      expectedOwnerRole,
    );

    // The caller, listing, owner and block state are read in one transaction.
    // The student's live role is therefore checked against the same snapshot
    // which supplies the contact details; a demotion or ban cannot race this
    // read and leave a stale student-only contact path available.
    return db.runTransaction(async (transaction) => {
      const callerSnapshot = await transaction.get(
        db.collection('users').doc(uid),
      );
      if (!isLiveStudentAccount(callerSnapshot)) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'Only a live student account can contact a room owner.',
        );
      }

      const roomSnapshot = await transaction.get(
        db.collection('rooms').doc(roomId),
      );
      if (!roomSnapshot.exists) {
        throw new functions.https.HttpsError(
          'not-found',
          'That room no longer exists',
        );
      }

      const room = roomSnapshot.data() as Record<string, any>;
      const ownerId = String(room.ownerId || '').trim();
      if (!ownerId) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This listing has no owner',
        );
      }
      if (ownerId === uid) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'You cannot contact the owner of your own listing.',
        );
      }
      if (ownerId !== expectedOwnerId) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'The owner of this listing changed. Please try again.',
        );
      }

      const ownerSnapshot = await transaction.get(
        db.collection('users').doc(ownerId),
      );
      assertParticipantRoleUnchanged(
        ownerSnapshot,
        expectedOwnerRole,
        'This room owner is no longer available for contact.',
      );
      if (!isLiveOwnerAccount(ownerSnapshot)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This room owner is no longer available for contact.',
        );
      }

      const blockState = await readPairBlockStateInTransaction(
        transaction,
        uid,
        ownerId,
      );
      const ownerName = profileDisplayName(ownerSnapshot) || ownerId;
      const roomTitle = safeRoomTitle(room.title || '');

      return {
        success: true,
        roomId,
        roomTitle,
        ownerId,
        ownerName,
        blockedByMe: blockState.firstBlockedSecond,
        blockedMe: blockState.secondBlockedFirst,
        blockedByCaller: blockState.firstBlockedSecond,
        callerBlockedByPeer: blockState.secondBlockedFirst,
        canContact: !pairIsEffectivelyBlocked(blockState),
        canSend: !pairIsEffectivelyBlocked(blockState),
      };
    });
  },
);

/** Blocks the other account from direct chat and new bookings. */
export const blockUser = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Please sign in first',
    );
  }

  const uid = context.auth.uid;
  await assertActiveAccount(uid);
  const otherUserId = String(data?.otherUserId || '').trim();
  if (!otherUserId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Missing user to block',
    );
  }
  if (otherUserId === uid) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'You cannot block yourself',
    );
  }

  const requestId = String(data?.requestId || '').trim();
  const conversationId = String(data?.conversationId || '').trim();
  if (!requestId && !conversationId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Missing booking request or conversation',
    );
  }

  // Prove the caller/peer relationship before checking the peer's live
  // phone. `otherUserId` is client supplied, so an Auth lookup first would
  // let a tenant use this callable as a phone-presence oracle.
  let expectedPeerRole = '';
  let expectedPeerIsStudent = false;
  if (requestId) {
    const preliminaryRequest = await db
      .collection('joinRequests')
      .doc(requestId)
      .get();
    if (!preliminaryRequest.exists) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You can only block somebody you have contacted or booked with.',
      );
    }
    const preliminaryData =
      preliminaryRequest.data() as Record<string, any>;
    const studentId = String(preliminaryData.studentId || '').trim();
    const ownerId = String(preliminaryData.ownerId || '').trim();
    if (
      !studentId ||
      !ownerId ||
      studentId === ownerId ||
      (studentId !== uid && ownerId !== uid)
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You can only block somebody you have contacted or booked with.',
      );
    }
    if (otherUserId !== studentId && otherUserId !== ownerId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You can only block somebody you have contacted or booked with.',
      );
    }
    expectedPeerIsStudent = otherUserId === studentId;
  } else {
    const preliminaryConversation = await db
      .collection('conversations')
      .doc(conversationId)
      .get();
    if (!preliminaryConversation.exists) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You can only block somebody you have contacted or booked with.',
      );
    }
    if (preliminaryConversation.get('deletionInProgress') === true) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You can only block somebody you have contacted or booked with.',
      );
    }
    const preliminaryParticipants = participantIdsFromConversation(
      preliminaryConversation.get('participantIds'),
    );
    if (
      preliminaryParticipants.length !== 2 ||
      !preliminaryParticipants.includes(uid) ||
      !preliminaryParticipants.includes(otherUserId)
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You can only block somebody you have contacted or booked with.',
      );
    }
    if (preliminaryConversation.get('conversationType') === 'adminSupport') {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Administrator support conversations cannot be blocked.',
      );
    }
    if (
      preliminaryConversation.get('createdByServer') !== true &&
      !(await hasBookingRelationship(uid, otherUserId))
    ) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You can only block somebody you have contacted or booked with.',
      );
    }
  }

  const [preliminaryCaller, preliminaryPeer] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('users').doc(otherUserId).get(),
  ]);
  if (!isLiveInteractionAccount(preliminaryCaller)) {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Only a live student or owner account can block somebody.',
    );
  }
  if (!isLiveInteractionAccount(preliminaryPeer)) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This user account is no longer available for interactions.',
    );
  }
  if (
    requestId &&
    (expectedPeerIsStudent
      ? !isLiveStudentAccount(preliminaryPeer)
      : !isLiveOwnerAccount(preliminaryPeer))
  ) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'This user account is no longer available for interactions.',
    );
  }

  // The peer is now proven to be the other party in this exact booking or
  // conversation. Only then is its live Firebase phone checked. The
  // transaction below re-reads both profiles and the relationship.
  expectedPeerRole = participantRole(preliminaryPeer);
  await assertLiveParticipantPhone(otherUserId, expectedPeerRole);

  const result = await db.runTransaction(async (transaction) => {
    const callerSnapshot = await transaction.get(
      db.collection('users').doc(uid),
    );
    const otherSnapshot = await transaction.get(
      db.collection('users').doc(otherUserId),
    );
    if (!isLiveInteractionAccount(callerSnapshot)) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only a live student or owner account can block somebody.',
      );
    }
    if (!otherSnapshot.exists) {
      throw new functions.https.HttpsError(
        'not-found',
        'This user account no longer exists',
      );
    }
    assertParticipantRoleUnchanged(
      otherSnapshot,
      expectedPeerRole,
      'This user account is no longer available for interactions.',
    );
    // The deletion flow fences the target profile before it removes the
    // blocks and conversations. Reading that fence in this transaction
    // closes the race in which a peer created a new incoming block after
    // the cleanup scan had already passed.
    if (!isLiveInteractionAccount(otherSnapshot)) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'This user account is no longer available for interactions.',
      );
    }

    const relationshipVerified =
      await hasInteractionRelationshipInTransaction(
        transaction,
        uid,
        otherUserId,
        {
          requestId: requestId || undefined,
          conversationId: conversationId || undefined,
        },
      );
    if (!relationshipVerified) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You can only block somebody you have contacted or booked with.',
      );
    }

    // Read the two directional documents in one global order. The caller's
    // profile and the exact relationship are read in the same transaction,
    // so an account ban, role change or deletion fence cannot race the
    // block write.
    const sortedIds = [uid, otherUserId].sort();
    const lowerSnapshot = await transaction.get(
      blockedUserRef(sortedIds[0], sortedIds[1]),
    );
    const upperSnapshot = await transaction.get(
      blockedUserRef(sortedIds[1], sortedIds[0]),
    );
    const firstBlockedSecond = lowerSnapshot.exists;
    const secondBlockedFirst = upperSnapshot.exists;
    const callerBlocked = uid === sortedIds[0]
      ? firstBlockedSecond
      : secondBlockedFirst;
    const blockedByCaller = uid === sortedIds[0]
      ? secondBlockedFirst
      : firstBlockedSecond;

    if (!callerBlocked) {
      transaction.set(blockedUserRef(uid, otherUserId), {
        blockerId: uid,
        blockedUserId: otherUserId,
        scope: 'person',
        blockedAt: firestore.FieldValue.serverTimestamp(),
      });
    }

    return {
      otherName: profileDisplayName(otherSnapshot) || otherUserId,
      blockedByMe: true,
      blockedMe: blockedByCaller,
      blockedByCaller: true,
      callerBlockedByPeer: blockedByCaller,
      // Blocking is effective immediately, even when only the caller has
      // created the block.
      canSend: false,
    };
  });

  return {
    success: true,
    blocked: true,
    otherUserId,
    otherName: result.otherName || otherUserId,
    blockedByMe: result.blockedByMe,
    blockedMe: result.blockedMe,
    blockedByCaller: result.blockedByMe,
    callerBlockedByPeer: result.blockedMe,
    canSend: result.canSend,
  };
});

/** Removes the current user's block of the other account. */
export const unblockUser = callableHttps.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Please sign in first',
    );
  }

  const uid = context.auth.uid;
  await assertActiveAccount(uid);
  const otherUserId = String(data?.otherUserId || '').trim();
  if (!otherUserId || otherUserId === uid) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'Invalid user to unblock',
    );
  }

  const result = await db.runTransaction(async (transaction) => {
    const callerSnapshot = await transaction.get(
      db.collection('users').doc(uid),
    );
    if (!isLiveInteractionAccount(callerSnapshot)) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only a live student or owner account can unblock somebody.',
      );
    }

    const sortedIds = [uid, otherUserId].sort();
    const lowerSnapshot = await transaction.get(
      blockedUserRef(sortedIds[0], sortedIds[1]),
    );
    const upperSnapshot = await transaction.get(
      blockedUserRef(sortedIds[1], sortedIds[0]),
    );

    const firstBlockedSecond = lowerSnapshot.exists;
    const secondBlockedFirst = upperSnapshot.exists;
    const callerBlocked = uid === sortedIds[0]
      ? firstBlockedSecond
      : secondBlockedFirst;
    if (!callerBlocked) {
      // Do not turn this callable into an oracle for whether an arbitrary
      // peer has blocked the caller. Only the owner of a block may remove
      // it, and only that caller already has a legitimate relationship with
      // the peer.
      throw new functions.https.HttpsError(
        'failed-precondition',
        'You have not blocked this user.',
      );
    }
    transaction.delete(blockedUserRef(uid, otherUserId));

    const blockedByMe = false;
    const blockedMe = uid === sortedIds[0]
      ? secondBlockedFirst
      : firstBlockedSecond;
    return {
      blockedByMe,
      blockedMe,
      canSend: !blockedMe,
    };
  });

  return {
    success: true,
    blocked: false,
    otherUserId,
    blockedByMe: result.blockedByMe,
    blockedMe: result.blockedMe,
    blockedByCaller: result.blockedByMe,
    callerBlockedByPeer: result.blockedMe,
    canSend: result.canSend,
  };
});
