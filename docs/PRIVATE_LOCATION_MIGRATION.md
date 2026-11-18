# Private room-location migration

## Why this migration is required

StayServe used to store the exact street address and exact coordinates in
each public `rooms/{roomId}` document:

```text
rooms/{roomId}.location.address
rooms/{roomId}.location.pincode
rooms/{roomId}.location.latitude
rooms/{roomId}.location.longitude
```

The student search reads public room documents. A visit-details check could
therefore control **when the app requested** an address, but it could not stop
a modified Firestore client from reading the exact address directly from the
public collection.

The implementation in this repository separates the public listing from the
exact visit location. Applying the split to a Firebase project is an operator
action: the rollout below was completed for `myfirstapp-fa30f52b`, and any
other environment must follow the same staged order before treating location
privacy as fixed.

## Implemented target model

### Public listing

The public `rooms/{roomId}` document keeps only data which is safe to show in
search results:

- title, description, rent and deposit;
- room/furnishing/gender/amenity data;
- images and capacity;
- coarse locality (`location.city` and `location.state`);
- a rounded `geoCell` such as `12.97,77.59` for an approximate distance hint.

The Flutter `RoomModel` and its `Location` type contain no exact address,
pincode or exact coordinate. A legacy coordinate is rounded before it enters
the public model, so even an old document cannot leak its exact position to a
student through the app model. The client and server use the same two-decimal,
away-from-zero tie rule so a half-cent boundary always maps to the same
public `geoCell`.

### Private exact location

The exact visit location lives in a separate document whose id is always the
room id:

```text
roomPrivate/{roomId}
  roomId
  ownerId
  address
  city
  state
  pincode
  latitude
  longitude
  locationRevision
  createdAt
  updatedAt
```

The Flutter `RoomPrivateLocation` model is separate from `RoomModel`.
`OwnedRoomModel` joins the two only in the owner-facing view so the owner can
still edit the real visit address.

### Security boundaries

- `setRoomPrivateLocation` is the only owner write path. It verifies the live
  owner role and the room ownership in a Firestore transaction and never
  trusts an owner id sent by the client.
- The private write and the public compatibility write happen in the same
  transaction.
- `getRoomVisitDetails` reads `roomPrivate/{roomId}` first. It releases the
  exact address only to a live student with an owner-accepted booking.
- Direct Firestore reads of `roomPrivate` are limited to the live owner of the
  corresponding public listing and a live administrator. Clients cannot write
  the collection. Collection listing is administrator-only; the owner client
  reads one deterministic document at a time. A missing private document is a
  normal migration state, so the listing owner can read that path and use the
  temporary legacy fallback; a corrupt private `ownerId` never grants a
  different account access.
- The Firestore document id is the canonical room id. The Flutter repositories
  always use `doc.id`, and the migration repairs a missing or stale public
  `roomId` plus missing or stale private identity metadata without changing
  an owner-authored exact value.
- Deleting a listing deletes its private location. Erasing an owner account
  removes each owner's private locations both by their deterministic room id
  and by their stored owner id, so corrupt ownership metadata cannot orphan
  an exact address.
- Public exact-location writes are rejected after the compatibility switch is
  closed. The switch accepts only the literal values `true` and `false`.
- Finalization writes a durable `system/locationPrivacy.finalized` latch. A
  finalized database cannot reopen the legacy exact-write window.

## The three rollout controls

The migration has three server-owned controls.

### 1. `ROOM_LOCATION_STAGE`

This Functions environment variable controls what a new owner location write
does:

- `dual` (default): store the exact location privately and keep the legacy
  public fields synchronized for old app versions;
- `private`: store the exact location privately and remove the exact public
  fields immediately.

Set it in `functions/.env` or the deployment environment. Do not change it in
the app; the Flutter client does not decide whether exact data may be public.
Only `dual` and `private` are accepted. A typo or any other value fails
closed with a configuration error instead of silently selecting a stage.

### 2. `system/locationPrivacy.allowClientExactLocationWrites`

This Firestore document controls whether an **old client** may still write
the exact location into the public room document:

- `false` or missing: exact public writes are rejected;
- `true`: exact public writes are accepted for the compatibility window.

The document is under the server-only `system` collection. Clients cannot
read or change it. The current app never needs this exception: it writes
coarse public data and sends the exact location to
`setRoomPrivateLocation`.

### 3. `system/locationPrivacy.finalized`

This durable server-owned latch is written by the finalizer after the complete
verification preflight succeeds. It has two purposes:

- a room-location write always behaves privately once the latch exists, even
  if the process environment still says `dual`;
- the Firestore rules ignore a request to reopen
  `allowClientExactLocationWrites` after finalization.

The latch is deliberately one-way. Rolling back to the public exact-address
format is not part of the recovery procedure.

## Operator CLI

The repository includes a local Admin SDK CLI:

```bash
npm --prefix functions run build

# Read-only migration preview.
node tools/private_location_migration.mjs migrate

# Apply the idempotent private-location copy.
node tools/private_location_migration.mjs migrate --apply

# Audit one page, or the complete database.
node tools/private_location_migration.mjs verify
node tools/private_location_migration.mjs verify --all

# Preview or apply the final public-field scrub.
ROOM_LOCATION_STAGE=private \
  node tools/private_location_migration.mjs finalize
ROOM_LOCATION_STAGE=private \
  node tools/private_location_migration.mjs finalize --apply

# Open or close the old-client compatibility window.
node tools/private_location_migration.mjs switch --enabled=true
node tools/private_location_migration.mjs switch --enabled=false
```

The CLI requires a trusted Admin SDK environment (Application Default
Credentials, a Firebase emulator, or equivalent). It prints room ids and
counters, never exact addresses. `verify` without `--all` audits exactly one
page; use `verify --all` for the database-wide readiness decision. The switch
command accepts only `--enabled=true` or `--enabled=false`; an omitted or
invalid value exits with an error.

The disposable-emulator end-to-end regression is:

```bash
tools/test_private_location_cli.sh
```

The same operations are also exposed as live-admin callables:

| Callable | Payload | Purpose |
| --- | --- | --- |
| `migrateRoomPrivateLocations` | `{cursor, limit, dryRun}` | Copy one legacy page |
| `verifyRoomPrivateLocations` | `{cursor, limit}` or `{all:true}` | Verify one page or every room |
| `finalizeRoomLocationPrivacy` | `{cursor, limit, dryRun}` | Scrub one verified page |

All three require a live administrator profile. Migration and finalization
are dry runs unless `dryRun:false` is explicitly supplied.

## Safe production rollout

Do not skip a phase. A half-completed split can either hide a legitimate
address or leave it publicly readable.

### Phase 0 — validate locally

```bash
npm --prefix functions run build
tools/test_backend_callables.sh
tools/test_private_location_cli.sh
tools/test_firestore_rules.sh
tools/test_storage_rules.sh
flutter analyze lib test
flutter test
```

Also exercise the accepted-student visit flow in the emulator and confirm
that the exact address comes from `roomPrivate/{roomId}`.

### Phase 1 — prepare the compatibility state

1. Export a backup of the production `rooms` collection and the relevant
   `users`/`joinRequests` data.
2. Confirm that the new app version has reached the owners who still use an
   old version. An old app can edit a listing, but it cannot write an exact
   public location after the compatibility switch is closed.
3. Keep the server in `ROOM_LOCATION_STAGE=dual`.
4. Open the old-client window if old app versions still need to publish or
   edit an address:

   ```bash
   node tools/private_location_migration.mjs switch --enabled=true
   ```

5. Deploy the dual-stage Functions and the compatible Firestore rules:

   ```bash
   firebase deploy --only functions,firestore:rules,firestore:indexes
   ```

### Phase 2 — copy every legacy location

Run a preview first:

```bash
node tools/private_location_migration.mjs migrate
```

Review `scanned`, `candidates`, `invalidLegacyLocation`,
`invalidPrivatePreserved`, `invalidOwner`, `repairedPublicRoomId` and
`hasMore`. Then apply:

```bash
node tools/private_location_migration.mjs migrate --apply
```

The copy is idempotent. An existing complete `roomPrivate/{roomId}` document
is never overwritten, so a retry cannot replace a newer owner edit with an
older public value. An incomplete legacy location is reported instead of
being copied into a permanently invalid private document. A private document
created by an older migration can be repaired by filling only its missing
fields; an owner-authored complete private value always wins.

The migration also repairs the canonical identity metadata: the public
`roomId` and private `roomId`/`ownerId` must match the Firestore document id
and the live listing owner. These metadata repairs do not overwrite an exact
address. Re-run the command until every page has been processed.

### Phase 3 — verify the complete database

```bash
node tools/private_location_migration.mjs verify --all
```

The result must have:

```text
readyToFinalize = true
missingPrivate = 0
ownerMismatch = 0
invalidRoomId = 0
invalidPublicRoomId = 0
invalidPrivate = 0
publicMismatch = 0
```

`publicExactRemaining` may still be greater than zero at this point. Those
are the exact public fields which the final scrub still has to remove.

If verification fails, use the returned room-id samples to repair the
affected record. Do not continue to finalization until the complete audit is
clean.

### Phase 4 — retire old public-location writes

After the new app is available to every active owner:

```bash
node tools/private_location_migration.mjs switch --enabled=false
```

Keep the server in `ROOM_LOCATION_STAGE=dual` for now. At this point new
owner edits still maintain the legacy public copy, while old clients can no
longer introduce or change exact public fields.

### Phase 5 — switch the Functions to private mode

Set:

```text
ROOM_LOCATION_STAGE=private
```

in the Functions environment and deploy:

```bash
firebase deploy --only functions
```

From this point, every new owner location write keeps only coarse public
data. Existing migrated rooms still keep their legacy public fields until
the finalization pass below.

### Phase 6 — preview and apply the final public-field scrub

The finalizer performs a complete database-wide preflight before it removes
even one field. It refuses to run while any room has a missing, malformed,
mismatched or wrongly-owned private counterpart. It also refuses to run while
`allowClientExactLocationWrites` is still `true`, because an old client could
write the exact value back after the scrub.

```bash
ROOM_LOCATION_STAGE=private \
  node tools/private_location_migration.mjs finalize

ROOM_LOCATION_STAGE=private \
  node tools/private_location_migration.mjs finalize --apply
```

The applied run closes `allowClientExactLocationWrites` and sets the durable
`finalized=true` latch in the same server-owned transaction before the first
scrubbed room is written. The operation is idempotent. A room which was
already private is reported as `alreadyPrivate` and is not changed again.

After this phase, `switch --enabled=true` must fail. Do not work around that
error: restoring the public exact-address format would reopen the privacy
issue.

### Phase 7 — verify that no exact public field remains

Run the complete audit again:

```bash
node tools/private_location_migration.mjs verify --all
```

The result must still have `readyToFinalize = true`, and now:

```text
publicExactRemaining = 0
```

Also export `rooms` and confirm that no public document contains:

- `location.address` or `location.pincode`;
- exact `location.latitude` or `location.longitude`;
- flat `address`, `pincode`, exact `latitude` or exact `longitude`.

The rounded `geoCell` and the public city/state are expected to remain.

### Phase 8 — deploy the tightened rules and indexes

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

Confirm that `system/locationPrivacy.allowClientExactLocationWrites` is
`false` and `system/locationPrivacy.finalized` is `true`. Run the rules suite
and test the owner edit, accepted-student visit and listing-deletion flows
once more against the deployed project.

## Rollback and recovery

### Before the final scrub

The migration can be rolled back safely:

1. Set `ROOM_LOCATION_STAGE=dual` and redeploy the Functions.
2. Re-open the old-client switch only if old app versions still need it and
   `system/locationPrivacy.finalized` is still `false`.
3. The private documents may remain; the new app and server continue to use
   them.
4. Re-run `verify --all`. The public/private values must still match.

### If migration or verification fails

- Re-run `migrate --apply`; it is idempotent.
- Repair the specific room-id samples reported by `verify --all`.
- If a private record is corrupt, restore that record from the backup rather
  than copying an unverified public value over it.
- Never use a script which unconditionally overwrites `roomPrivate`; that
  would replace a newer owner edit with an older public value.

### After the final scrub

Do not roll back to a public exact-address format automatically. The exact
data still exists in `roomPrivate/{roomId}`, so the correct recovery is to
repair the private document or the affected listing and keep the public
format coarse. Restoring exact public fields would reopen the privacy issue
and requires a separately reviewed, explicit administrator procedure.

## Completion checklist

- [x] Production backup exists and has been tested.
- [x] Dual-stage Functions deployed successfully.
- [x] Every legacy room has one private counterpart.
- [x] Complete verification reports `readyToFinalize = true`.
- [x] Old-client exact public writes are closed.
- [x] `ROOM_LOCATION_STAGE=private` is deployed.
- [x] Finalization dry run and applied run both succeed.
- [x] Complete verification reports `publicExactRemaining = 0`.
- [x] Tightened Firestore rules and indexes are deployed.
- [x] Owner edit, accepted-student visit and account/listing deletion flows
      pass in production.
- [x] The exact-address compatibility switch is `false`.
- [x] The durable location-privacy latch is `finalized=true`.

## Current production status

The staged production rollout completed on **18 November 2026 (UTC)** for
`myfirstapp-fa30f52b`:

- the private backup exists at
  `~/.local/share/stayserve-production-backups/private-location-rollout-2026-11-18T17-22-55-402Z`;
- the compatibility window was opened only for the migration and was then
  closed permanently;
- all 43 Functions are `ACTIVE` on Node.js 22 with
  `ROOM_LOCATION_STAGE=private`;
- the finalization latch is `finalized=true` and
  `allowClientExactLocationWrites=false`;
- the complete verification scans both production rooms, verifies both private
  counterparts and reports `publicExactRemaining = 0`;
- the tightened Firestore rules and 29 indexes are deployed, and the deployed
  Firestore and Storage rules match the tested local files;
- the isolated production core-flow smoke test passes 25 assertions covering
  owner create/edit, photo upload, private location, booking, accepted-student
  visit details, messaging, listing deletion and account deletion, with no
  disposable residue left behind.

The source diff remains local, unstaged and uncommitted. A minimum-version or
force-update transition is still required before old clients are retired; the
finalized switch must not be reopened to accommodate them.
