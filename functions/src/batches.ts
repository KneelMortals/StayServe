import * as firestore from 'firebase-admin/firestore';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = firestore.getFirestore();

/**
 * Batched writes for the maintenance jobs.
 *
 * A Firestore batch holds at most **500** writes. The maintenance jobs
 * used to put *every* matching document into a single batch — so a
 * collection with more than 500 old documents made the whole job fail with
 * an `INVALID_ARGUMENT` error, and nothing was cleaned up at all.
 *
 * The helpers below walk through the documents **page by page** and write
 * at most 400 documents per batch. Nothing is ever held in memory as a
 * whole: a user with thousands of rooms does not blow up the memory of the
 * function any more.
 *
 * The query that is handed to the helpers must be **ordered** — the cursor
 * of the next page is the last document of the previous one, and Firestore
 * can only continue a query that has an order.
 */

/** The number of documents that are read in one go. */
export const PAGE_SIZE = 300;

/** The number of writes that are sent in one batch (the limit is 500). */
export const BATCH_SIZE = 400;

/**
 * The query of the next page.
 *
 * The helpers add the cursor and the limit themselves — the query that is
 * returned here must only carry the filters and the order.
 */
type QueryBuilder = () => firestore.Query;

/**
 * An authorization guard for one privileged batch.
 *
 * The guard document is read in the same Firestore transaction as the batch
 * writes. A demoted or banned administrator therefore cannot pass a
 * preflight check and still commit a batch: if the guard profile changes
 * while the transaction is open, Firestore aborts and retries it.
 */
export interface BatchWriteGuard {
  /** The profile document which proves that the caller may write. */
  ref: firestore.DocumentReference;
  /** Throws when the live profile is no longer authorized. */
  assertAuthorized(snapshot: firestore.DocumentSnapshot): void;
}

/** Commits one guarded deletion batch. */
async function commitGuardedDeletes(
  refs: firestore.DocumentReference[],
  guard?: BatchWriteGuard,
): Promise<void> {
  if (!guard) {
    const batch = db.batch();
    for (const ref of refs) batch.delete(ref);
    await batch.commit();
    return;
  }

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(guard.ref);
    guard.assertAuthorized(snapshot);
    for (const ref of refs) transaction.delete(ref);
  });
}

/** Commits one guarded update batch. */
async function commitGuardedUpdates(
  docs: firestore.QueryDocumentSnapshot[],
  update: (
    doc: firestore.QueryDocumentSnapshot,
  ) => firestore.UpdateData<firestore.DocumentData>,
  guard?: BatchWriteGuard,
): Promise<void> {
  if (!guard) {
    const batch = db.batch();
    for (const doc of docs) batch.update(doc.ref, update(doc));
    await batch.commit();
    return;
  }

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(guard.ref);
    guard.assertAuthorized(snapshot);
    for (const doc of docs) transaction.update(doc.ref, update(doc));
  });
}

/**
 * Deletes the documents of a query — page by page.
 *
 * [shouldDelete] decides for every document whether it is deleted. The
 * documents it refuses are read but not deleted (the page is still walked
 * through completely).
 *
 * Returns the number of deleted documents.
 */
export async function deleteWhere(
  buildQuery: QueryBuilder,
  shouldDelete?: (doc: firestore.QueryDocumentSnapshot) => boolean,
  guard?: BatchWriteGuard,
): Promise<number> {
  return deleteWhereAsync(
    buildQuery,
    async (doc) => (shouldDelete ? shouldDelete(doc) : true),
    guard,
  );
}

/**
 * The number of documents whose decision is made at the same time.
 *
 * The decision of `deleteWhereAsync` may need a read of another
 * collection — 300 parallel reads at once would be a burst that the
 * Firestore client has to queue anyway, and it would count against the
 * deadline of the function much faster than a few reads at a time.
 */
const DECISION_CONCURRENCY = 25;

/**
 * Deletes the documents of a query — page by page.
 *
 * The decision whether a document is deleted may be **asynchronous**: some
 * lock documents may only be deleted when the document they point at is
 * gone or over — that check needs a read of another collection.
 *
 * [shouldDelete] decides for every document whether it is deleted.
 *
 * Returns the number of deleted documents.
 */
export async function deleteWhereAsync(
  buildQuery: QueryBuilder,
  shouldDelete: (
    doc: firestore.QueryDocumentSnapshot,
  ) => Promise<boolean>,
  guard?: BatchWriteGuard,
): Promise<number> {
  let deleted = 0;
  let cursor: firestore.QueryDocumentSnapshot | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = buildQuery();
    const snapshot = await (cursor ? query.startAfter(cursor) : query)
      .limit(PAGE_SIZE)
      .get();
    if (snapshot.empty) break;

    const decisions: { ref: firestore.DocumentReference; delete: boolean }[] =
      [];

    for (
      let start = 0;
      start < snapshot.docs.length;
      start += DECISION_CONCURRENCY
    ) {
      const chunk = snapshot.docs.slice(start, start + DECISION_CONCURRENCY);
      const chunkDecisions = await Promise.all(
        chunk.map(async (doc) => ({
          ref: doc.ref,
          delete: await shouldDelete(doc),
        })),
      );
      decisions.push(...chunkDecisions);
    }

    const refs = decisions
      .filter((decision) => decision.delete)
      .map((decision) => decision.ref);

    for (let index = 0; index < refs.length; index += BATCH_SIZE) {
      await commitGuardedDeletes(
        refs.slice(index, index + BATCH_SIZE),
        guard,
      );
    }
    deleted += refs.length;

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }

  return deleted;
}

/**
 * Updates the documents of a query — page by page.
 *
 * The update is written to every document of the query, in batches of at
 * most 400 writes.
 *
 * Returns the number of updated documents.
 */
export async function updateWhere(
  buildQuery: QueryBuilder,
  update: (
    doc: firestore.QueryDocumentSnapshot,
  ) => firestore.UpdateData<firestore.DocumentData>,
  guard?: BatchWriteGuard,
): Promise<number> {
  let updated = 0;
  let cursor: firestore.QueryDocumentSnapshot | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = buildQuery();
    const snapshot = await (cursor ? query.startAfter(cursor) : query)
      .limit(PAGE_SIZE)
      .get();
    if (snapshot.empty) break;

    for (let index = 0; index < snapshot.docs.length; index += BATCH_SIZE) {
      await commitGuardedUpdates(
        snapshot.docs.slice(index, index + BATCH_SIZE),
        update,
        guard,
      );
    }
    updated += snapshot.size;

    cursor = snapshot.docs[snapshot.docs.length - 1];
    if (snapshot.size < PAGE_SIZE) break;
  }

  return updated;
}
