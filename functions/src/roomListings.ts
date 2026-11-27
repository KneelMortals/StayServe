import * as firestore from 'firebase-admin/firestore';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = firestore.getFirestore();

/**
 * The collection which holds the **published** room listings.
 *
 * A published listing is the only kind of listing which the student search
 * may read. The documents are created by the server when the owner publishes
 * a finished draft.
 */
export const ROOM_LISTINGS_COLLECTION = 'rooms';

/**
 * The collection which holds the **unpublished** room listings.
 *
 * A draft belongs to its owner. It lives in its own collection because
 * Firestore rules cannot filter a collection query: a draft which shared the
 * public collection would be returned by every query of that collection and
 * would therefore be readable by every registered account — no matter which
 * single-document rule guarded it.
 */
export const ROOM_DRAFTS_COLLECTION = 'roomDrafts';

/** The two collections which may carry one room id. */
export type RoomListingCollection =
  | typeof ROOM_LISTINGS_COLLECTION
  | typeof ROOM_DRAFTS_COLLECTION;

/** The two documents which may carry one room id. */
export interface RoomListingDocuments {
  draft: firestore.DocumentReference;
  published: firestore.DocumentReference;
}

/**
 * The document references of one room id.
 *
 * The draft is always addressed before the published listing so that every
 * transaction which touches both reads them in the same order.
 */
export function roomListingDocuments(roomId: string): RoomListingDocuments {
  return {
    draft: db.collection(ROOM_DRAFTS_COLLECTION).doc(roomId),
    published: db.collection(ROOM_LISTINGS_COLLECTION).doc(roomId),
  };
}

/** The listing document which currently owns a room id. */
export interface ResolvedRoomListing {
  collection: RoomListingCollection;
  ref: firestore.DocumentReference;
  snapshot: firestore.DocumentSnapshot;
  data: Record<string, any>;
}

/**
 * Selects the listing document of a room id.
 *
 * A published listing wins over a draft. The publication moves the draft into
 * the published collection in one transaction, so both documents only exist at
 * the same time when a stale draft survived an interrupted publication. The
 * published listing is the live one in that case.
 */
export function resolveRoomListing(
  draft: firestore.DocumentSnapshot | null | undefined,
  published: firestore.DocumentSnapshot | null | undefined,
): ResolvedRoomListing | null {
  if (published && published.exists) {
    return {
      collection: ROOM_LISTINGS_COLLECTION,
      ref: published.ref,
      snapshot: published,
      data: published.data() as Record<string, any>,
    };
  }
  if (draft && draft.exists) {
    return {
      collection: ROOM_DRAFTS_COLLECTION,
      ref: draft.ref,
      snapshot: draft,
      data: draft.data() as Record<string, any>,
    };
  }
  return null;
}

/**
 * Reads the draft and the published listing of one room id.
 *
 * The two documents are read together so that a caller never has to decide
 * which collection owns the listing. The reads happen in the same order in
 * every transaction of the backend.
 */
export async function readRoomListingPair(
  transaction: firestore.Transaction,
  roomId: string,
): Promise<{
  draft: firestore.DocumentSnapshot;
  published: firestore.DocumentSnapshot;
}> {
  const documents = roomListingDocuments(roomId);
  const [draft, published] = await Promise.all([
    transaction.get(documents.draft),
    transaction.get(documents.published),
  ]);
  return { draft, published };
}

/**
 * The server-owned fields which never survive the publication of a draft.
 *
 * The deletion marker and the photo-cleanup lock belong to the *published*
 * listing lifecycle. A draft cannot carry them, and a client can never set
 * them, so they are stripped before the draft becomes the public listing.
 */
const DRAFT_ONLY_SERVER_FIELDS = [
  'deletionInProgress',
  'deletionRequestedBy',
  'deletionOperationId',
  'deletionRequestedAt',
  'photoCleanupLock',
];

/**
 * The public listing which a finished draft becomes.
 *
 * The draft carries the complete listing payload. The publication copies it
 * into the public collection and marks the copy as available. The server-owned
 * deletion and cleanup markers are never copied.
 */
export function publishedListingPayload(
  draft: Record<string, any>,
): Record<string, any> {
  const payload: Record<string, any> = { ...draft };
  for (const field of DRAFT_ONLY_SERVER_FIELDS) {
    delete payload[field];
  }
  payload.status = 'available';
  // A new listing never has tenants. The counter is server-owned from the
  // moment the listing exists.
  payload.currentOccupancy = 0;
  payload.publishedAt = firestore.FieldValue.serverTimestamp();
  payload.updatedAt = firestore.FieldValue.serverTimestamp();
  return payload;
}
