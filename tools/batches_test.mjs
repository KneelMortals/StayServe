// Tests for the batched helpers of the maintenance jobs.
//
// `deleteWhere`, `deleteWhereAsync` and `updateWhere` walk through a
// collection **page by page** and write at most 400 documents per batch.
// The old code put every matching document into a single batch — a
// collection with more than 500 old documents made the whole job fail.
//
// These tests run against the **Firestore emulator**.
//
//   node tools/batches_test.mjs <port> <projectId>

import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const require = createRequire(import.meta.url);

const PORT = process.argv[2] || '8181';
const PROJECT = process.argv[3] || 'demo-stayserve-batches';

// The emulator needs a credentials file — it never uses it, but the admin
// SDK insists on one when there is no metadata server and it checks that
// the key really is a key, so a real (throw-away) RSA key is generated.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const fakeCredentials = mkdtempSync(join(tmpdir(), 'stayserve-batch-'));
writeFileSync(
  join(fakeCredentials, 'sa.json'),
  JSON.stringify({
    type: 'service_account',
    project_id: PROJECT,
    private_key_id: 'fake',
    private_key: privateKey,
    client_email: `fake@${PROJECT}.iam.gserviceaccount.com`,
    client_id: '1234567890',
    token_uri: 'https://oauth2.googleapis.com/token',
  }),
);

process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORT}`;
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_APPLICATION_CREDENTIALS = join(fakeCredentials, 'sa.json');
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT });

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(
      `  FAIL  ${label}  expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// The compiled helpers — they create the default Firebase app themselves.
const { deleteWhere, deleteWhereAsync, updateWhere, PAGE_SIZE, BATCH_SIZE } =
  require(join(ROOT, 'functions', 'lib', 'batches.js'));

// Firebase Admin 14 exposes the services through modular entry points.
// The compiled batch helper initializes the default app when it is loaded
// above, so Firestore can now be opened without the removed
// `admin.firestore()` namespace helper.
const firestore = require(join(
  ROOT,
  'functions',
  'node_modules',
  'firebase-admin',
  'lib',
  'firestore',
  'index.js',
));
const db = firestore.getFirestore();

async function clear() {
  const collections = await db.listCollections();
  for (const collection of collections) {
    // The emulator has no "drop collection" — the documents are removed one
    // page at a time.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const snapshot = await collection.limit(300).get();
      if (snapshot.empty) break;
      const batch = db.batch();
      for (const doc of snapshot.docs) batch.delete(doc.ref);
      await batch.commit();
      if (snapshot.size < 300) break;
    }
  }
}

/**
 * Writes [count] documents into [name].
 *
 * The prefix keeps the document ids of two seeds apart — the same id would
 * be **overwritten** by the second seed.
 */
async function seed(name, count, extra = {}, prefix = 'doc') {
  const batch = db.batch();
  for (let index = 0; index < count; index++) {
    batch.set(
      db.collection(name).doc(`${prefix}-${String(index).padStart(4, '0')}`),
      {
        index,
        order: index,
        ...extra,
      },
    );
  }
  await batch.commit();
}

// ---------------------------------------------------------------------------
section('the sizes of the pages and the batches');

check('a page holds at most 300 documents', PAGE_SIZE, 300);
check('a batch holds at most 400 writes', BATCH_SIZE, 400);

// ---------------------------------------------------------------------------
await clear();

section('deleteWhere deletes every matching document');

await seed('things', 25, { keep: true });
await seed('things', 5, { keep: false });

const deleted = await deleteWhere(() =>
  db.collection('things').where('keep', '==', false).orderBy('order'),
);
check('the five documents are deleted', deleted, 5);
check(
  'twenty documents are left',
  (await db.collection('things').count().get()).data().count,
  20,
);

// ---------------------------------------------------------------------------
await clear();

section('deleteWhere refuses the documents it is told to refuse');

await seed('mixed', 10, { group: 'a' }, 'a');
await seed('mixed', 10, { group: 'b' }, 'b');

const kept = await deleteWhere(
  () => db.collection('mixed').where('group', '==', 'a').orderBy('order'),
  // The callback says which documents may be **deleted**.
  (doc) => doc.get('index') >= 3,
);
check('the seven documents that may go are deleted', kept, 7);
check(
  'the three refused documents of group a are left',
  (await db.collection('mixed').where('group', '==', 'a').count().get()).data()
    .count,
  3,
);
check(
  'group b is untouched',
  (await db.collection('mixed').where('group', '==', 'b').count().get()).data()
    .count,
  10,
);

// ---------------------------------------------------------------------------
await clear();

section('deleteWhereAsync decides with an asynchronous check');

await seed('async', 12, { group: 'a' }, 'a');
await seed('async', 8, { group: 'b' }, 'b');

const asyncDeleted = await deleteWhereAsync(
  () => db.collection('async').where('group', '==', 'a').orderBy('order'),
  async (doc) => {
    // Pretend the check needs a read of another collection.
    await new Promise((resolve) => setTimeout(resolve, 1));
    return doc.get('index') % 2 === 0;
  },
);
check('only the even documents are deleted', asyncDeleted, 6);
check(
  'the odd documents are left',
  (await db.collection('async').where('group', '==', 'a').count().get()).data()
    .count,
  6,
);
check(
  'group b is untouched',
  (await db.collection('async').where('group', '==', 'b').count().get()).data()
    .count,
  8,
);

// ---------------------------------------------------------------------------
await clear();

section('updateWhere updates every matching document');

await seed('rows', 12, { flag: 'old' }, 'old');
await seed('rows', 4, { flag: 'new' }, 'new');

const updated = await updateWhere(
  () => db.collection('rows').where('flag', '==', 'old').orderBy('order'),
  () => ({ flag: 'new' }),
);
check('the twelve documents are updated', updated, 12);
check(
  'they all carry the new flag',
  (await db.collection('rows').where('flag', '==', 'new').count().get()).data()
    .count,
  16,
);

// ---------------------------------------------------------------------------
await clear();

section('a page that is bigger than one page');

await seed('many', 750, { group: 'a' }, 'a');
await seed('many', 3, { group: 'b' }, 'b');

const manyDeleted = await deleteWhere(() =>
  db.collection('many').where('group', '==', 'a').orderBy('order'),
);
check('all 750 documents are deleted', manyDeleted, 750);
check(
  'the three other documents are left',
  (await db.collection('many').count().get()).data().count,
  3,
);

// ---------------------------------------------------------------------------
await clear();

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (failures.length) {
  console.log('Failed:');
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(fail === 0 ? 0 : 1);
