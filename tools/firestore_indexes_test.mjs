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
