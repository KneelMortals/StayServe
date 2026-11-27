import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const indexConfiguration = JSON.parse(
  fs.readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8'),
);

test('personal-block cleanup uses a collection-group single-field index', () => {
  const blockedUserIndexes = indexConfiguration.indexes.filter(
    (index) => index.collectionGroup === 'blockedUsers',
  );
  assert.deepEqual(
    blockedUserIndexes,
    [],
    'Firestore rejects this unnecessary composite index; use single-field index controls.',
  );

  const blockedUserOverride = indexConfiguration.fieldOverrides.find(
    (override) =>
      override.collectionGroup === 'blockedUsers' &&
      override.fieldPath === 'blockedUserId',
  );
  assert.ok(
    blockedUserOverride,
    'The blockedUserId collection-group index must be explicitly enabled.',
  );
  assert.ok(
    blockedUserOverride.indexes.some(
      (index) =>
        index.queryScope === 'COLLECTION_GROUP' &&
        index.order === 'ASCENDING',
    ),
    'The blockedUserId equality query needs an ascending collection-group index.',
  );
});

test('the owner-scoped room collections have their owner index', () => {
  // The owner list reads the published listings and the unfinished drafts
  // with an equality filter on `ownerId` and an order by `createdAt`. That
  // combination needs a composite index in **both** collections: a
  // single-field index only serves an equality filter and an order by the
  // same field.
  for (const collection of ['rooms', 'roomDrafts']) {
    const ownerIndex = indexConfiguration.indexes.find(
      (index) =>
        index.collectionGroup === collection &&
        index.queryScope === 'COLLECTION' &&
        index.fields.length === 2 &&
        index.fields[0].fieldPath === 'ownerId' &&
        index.fields[0].order === 'ASCENDING' &&
        index.fields[1].fieldPath === 'createdAt' &&
        index.fields[1].order === 'DESCENDING',
    );
    assert.ok(
      ownerIndex,
      `The ${collection} collection needs an ownerId + createdAt composite index.`,
    );
  }
});
