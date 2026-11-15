# Private room-location migration

## Why this migration is required

StayServe currently stores the exact street address and exact coordinates in
each public `rooms/{roomId}` document:

```text
rooms/{roomId}.location.address
rooms/{roomId}.location.latitude
rooms/{roomId}.location.longitude
```

The student search reads these public room documents. The app's visit-details
check therefore protects **when a student may ask the server for the visit
details**, but it does not stop a modified Firestore client from reading the
exact address directly from the public collection.

The UI check is not a security boundary. Until the data is split, any signed-
in account that can read a public listing can also read its exact address.

## Target data model

Keep only information that is safe to show in search results in the public
room document:

- title, description, rent and deposit;
- room/furnishing/gender/amenity data;
- images and capacity;
- coarse locality (`city`, `state`, and a deliberately coarse locality or
  geohash cell);
- an intentionally blurred public coordinate, if map distance is needed.

Move the private fields into a separate collection:

```text
roomPrivate/{roomId}
  ownerId
  address
  city
  state
  pincode
  latitude
  longitude
  updatedAt
```

`roomPrivate` must not be readable by an arbitrary signed-in account. Its read
rule should allow only:

1. the listing owner;
2. an admin with a live administrator profile; and
3. the student and owner of an accepted join request
   (`ownerConfirmed`, `studentConfirmed`, `adminReviewed`, or the legacy
   `admin_reviewed` spelling).

The exact-location read should continue to go through `getRoomVisitDetails`
after the split. That callable already validates the participant and accepted
request on the server.

## Safe rollout order

A half-completed split would either hide addresses from legitimate students or
leave them publicly readable. Use this order instead:

1. **Add the private collection and server helpers.**
   - Add an owner-only callable for writing the private location.
   - Add an admin migration callable/script that copies an existing public
     location into `roomPrivate/{roomId}`.
   - Keep the public location available while the migration runs.

2. **Migrate and verify every existing room.**
   - Copy the exact fields to `roomPrivate/{roomId}`.
   - Store the private `ownerId` from the public room document.
   - Verify that every public room has exactly one private counterpart and
     that the copied values match.
   - Do not delete or blur the public fields in this phase.

3. **Deploy the new app version.**
   - Room creation and editing write the exact location through the callable.
   - Public search uses only coarse location fields.
   - The room-detail screen gets exact details from `getRoomVisitDetails`
     only for an accepted request.
   - The owner edit screen reads its private location through the owner-only
     path.

4. **Deploy rules that enforce the split.**
   - Public room reads must not be able to return a document containing the
     exact address or exact coordinates.
   - Public room writes must reject those fields.
   - `roomPrivate` gets participant-aware read rules and owner/server-only
     writes.

5. **Remove the public exact fields in a final migration pass.**
   - Replace the street address with a coarse locality/area label.
   - Round or grid the public coordinates.
   - Re-run the count/checksum verification.
   - Confirm that the visit-details callable still returns the exact address
     to accepted participants.

6. **Deploy tightened Firestore rules and indexes.**
   - Deploy the rules only after the data pass has completed.
   - Re-run the Firestore rules emulator suite and the joined/visit flow.

## Important implementation constraints

- A `rooms` query cannot read a field that does not exist in the public
  document. The public model and the exact-location model must be separate
  types; do not keep an optional exact `Location` on the public room model
  and rely on rules to hide it.
- The private document id should be the same room id, so the lookup is
  deterministic and cannot create a second private copy for one listing.
- The private-location write must verify `ownerId == auth.uid` and must not
  trust an owner id sent by the client.
- The migration must be idempotent. A retry must copy the same values and
  must not overwrite a later owner edit with an older public value.
- Admin access must use the live profile role and active state; a stale
  custom claim alone is not sufficient.

## Current project status

This migration has **not** been applied to the repository yet because doing
only the model or only the rules half would either expose the data or break
existing rooms. The current exact-address exposure therefore remains a
security item that must be completed before treating room-location privacy as
fixed.
