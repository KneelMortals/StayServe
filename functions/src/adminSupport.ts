/**
 * Shared identifiers for administrator support conversations.
 *
 * The recipient-readable conversation deliberately uses an opaque identity
 * instead of the administrator's Firebase Auth uid. The real party mapping is
 * kept in a server-only operation document, so it can authorize the actual
 * administrator without disclosing that uid to the tenant.
 */

import * as firestore from 'firebase-admin/firestore';

/** The server-only collection which maps an opaque support channel to its parties. */
export const ADMIN_SUPPORT_CONVERSATION_OPERATIONS =
  'adminSupportConversationOperations';

/** The non-sensitive identity shown to a support-conversation recipient. */
export const ADMIN_SUPPORT_IDENTITY = 'adminIdentities/support/profile';

/**
 * The opaque identity used for administrator messages in recipient-readable
 * records.
 *
 * The argument is intentionally ignored: every administrator uses the same
 * public-facing identity, while the server-only conversation operation keeps
 * the actual administrator uid.
 */
export function adminSupportIdentityFor(_adminUid: string): string {
  return ADMIN_SUPPORT_IDENTITY;
}

/**
 * Replaces a raw administrator uid in legacy support messages.
 *
 * The parent conversation is migrated separately before this helper runs, so
 * a reply committed after the migration cannot reintroduce the raw uid. The
 * scan is bounded and uses batches below Firestore's write limit.
 */
export async function scrubAdministratorMessageIdentities(options: {
  db: firestore.Firestore;
  conversationRef: firestore.DocumentReference;
  adminUid: string;
  adminIdentity: string;
  pageSize?: number;
  batchSize?: number;
}): Promise<void> {
  const pageSize = Math.max(1, Math.min(options.pageSize || 300, 1000));
  const batchSize = Math.max(1, Math.min(options.batchSize || 400, 500));
  let cursor: firestore.QueryDocumentSnapshot | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = options.conversationRef
      .collection('messages')
      .orderBy('__name__');
    if (cursor) query = query.startAfter(cursor);

    const snapshot = await query.limit(pageSize).get();
    if (snapshot.empty) break;

    let batch = options.db.batch();
    let writes = 0;

    for (const message of snapshot.docs) {
      const data = message.data() as Record<string, any>;
      const update: Record<string, unknown> = {};

      if (String(data.senderId || '') === options.adminUid) {
        update.senderId = options.adminIdentity;
      }
      if (String(data.receiverId || '') === options.adminUid) {
        update.receiverId = options.adminIdentity;
      }
      if (String(data.adminId || '') === options.adminUid) {
        update.adminId = options.adminIdentity;
      }

      if (Object.keys(update).length === 0) continue;
      batch.update(message.ref, update);
      writes += 1;

      if (writes >= batchSize) {
        await batch.commit();
        batch = options.db.batch();
        writes = 0;
      }
    }

    if (writes > 0) await batch.commit();
    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < pageSize) break;
  }
}
