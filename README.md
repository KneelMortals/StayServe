# StayServe

A Flutter + Firebase app that connects **students** looking for a room with
**room owners** who have one. Students search listings, contact owners over
chat, request a booking and pay through UPI. Owners manage their listings,
accept requests and settle the platform fee. Admins verify submitted payments,
manage users and decide where the app is available.

---

## Stack

| Part | Technology |
|------|------------|
| App | Flutter 3.44 (Dart 3.12), Riverpod, go_router |
| Backend | Firebase Auth, Cloud Firestore, Cloud Storage, Cloud Functions (Node 22, `us-central1`) |
| Payments | UPI intent built **server side** — the client never chooses the payee or the amount |
| Project | `myfirstapp-fa30f52b` |

---

## Getting started

```bash
flutter pub get
flutter run                       # debug on a connected device
flutter build apk --release      # build/app/outputs/flutter-apk/app-release.apk
```

The root package contains the Firebase CLI used by the local emulator and
security-rules suites. The Cloud Functions are a separate package:

```bash
npm ci                           # Firebase CLI and rules-test tooling
cd functions
npm ci
npm run build                    # tsc — also runs automatically on deploy
```

---

## Roles

| Role | What it can do |
|------|----------------|
| `student` | search and save rooms, contact owners, request and confirm a booking, submit the platform fee when they are the payer |
| `owner` | list rooms, accept/reject requests, see invoices, submit the platform fee when they are the payer |
| `admin` | verify or reject submitted payments, manage users and rooms, configure the platform fee and the launch areas |

A user picks `student` or `owner` during sign-up. **`admin` can never be
self-assigned** — the sign-up function only accepts the other two, the
`setUserRole` callable only answers to an existing admin, and the Firestore
rules deny **every** client write to the `role` field: the role is
server-owned.

### Promoting somebody to admin

The first admin has to be granted out of band. A helper script does it:

```bash
firebase login                   # only `firebase login` is needed — no service-account key

node tools/make_admin.mjs --list                     # who is an admin right now?
node tools/make_admin.mjs --email you@example.com    # promote
node tools/make_admin.mjs --email you@example.com --role student   # demote
```

It writes both halves of the role — the custom claim
`{"role":"admin","admin":true}` in Firebase Auth **and** `users/{uid}.role`
in Firestore — because the claim decides what the rules allow and the profile
field decides what the app shows. The live profile is the source of truth for
every server-side check, so a demoted admin loses the access immediately even
if the old token still carries the claim.

> The promoted user has to **sign out and sign in again**; the ID token that
> is already in the app still carries the old claims.

Full details, including the security notes, are in
[`DEPLOYMENT.md`](DEPLOYMENT.md#8-promoting-a-user-to-admin).

---

## The money flow

The platform takes its cut **once**, on the **first payment** of a booking.
After that the rent is settled directly between the student and the owner.

```
student requests room    → joinRequests.status = pending
owner accepts            → joinRequests.status = ownerConfirmed
student confirms         → joinRequests.status = studentConfirmed
payer submits the fee    → payments.status      = submitted
admin verifies the UTR   → payments.status      = verified
                          joinRequests.status  = adminReviewed
                          invoice created and room occupancy incremented
```

`adminReviewed` is the **joined-room** state. A submitted payment is not a
tenancy: it does not create an invoice, change occupancy or make the room
appear in the student's joined rooms. Only the server's `verifyPayment`
approval performs that activation, atomically. Rejecting a submitted payment
returns the request to its payable state.

* One UPI only — the platform's. The owner does **not** upload a UPI id.
* `settings/platform.feePayer` decides **who** pays the platform fee:
  `owner` (default) or `student`. Switch it in **Admin → Settings**.
* The fee becomes payable only after the student has confirmed the owner's
  acceptance. The configured payer can then submit it from their own app.
* `PLATFORM_UPI_VPA`, `PLATFORM_UPI_NAME` and `PLATFORM_FEE_PERCENTAGE` live
  in `functions/.env`; the same UPI is mirrored in
  `lib/core/constants/app_constants.dart` so the client can verify it.

### Server-owned booking state

The booking lifecycle is not a client-side transaction. Firestore rules and
Cloud Functions protect the fields that establish money, occupancy and
membership:

* clients cannot create or activate join requests, payments or invoices;
* `rooms.currentOccupancy` is changed only by server-side booking activation
  and rollback;
* owners change listing availability through
  `setRoomListingAvailability`, which verifies the live owner role and the
  listing ownership;
* admins change the status of any listing through
  `adminSetRoomListingStatus` (live admin role);
* a listing is removed through `deleteRoomListing` — the server refuses a
  room with an active booking or a payment waiting for verification, cancels
  the open requests and keeps their history;
* notifications are created by the backend, while a client may only mark its
  own notification as read; deleting one goes through `deleteNotification`;
* administrative access is checked against the **live** Firestore profile,
  not only a custom claim that may still be present in an old ID token.

New registrations carry a server-owned `registrationCompleted` marker. Before
a rules/functions rollout, legacy profiles are backfilled with:

```bash
node tools/backfill_registration.mjs          # dry run
node tools/backfill_registration.mjs --apply  # write the marker
```

For this project the backfill has already been applied (one legacy admin
profile; a fresh dry run reports `Already complete: 1, Legacy candidates: 0`).

---

## Repository layout

| Path | What is in it |
|------|---------------|
| `lib/core/` | router, theme, shared widgets, constants |
| `lib/features/` | one folder per feature (auth, students, owners, admin, payments, messaging, …) |
| `lib/firebase/` | the Firebase plumbing — Auth, Firestore, Storage, Functions, messaging |
| `lib/models/` | the hand-written data models (no build_runner) |
| `functions/src/` | the Cloud Functions |
| `tools/` | maintenance scripts (admin promotion, rules tests, end-to-end checks) |
| `firestore.rules`, `storage.rules` | the deployed security rules |

---

## Testing

```bash
flutter analyze lib test      # expect: No issues found!
flutter test                  # the Dart/widget regression suite (340 tests)
flutter test --platform chrome test/web_firebase_config_test.dart # browser Firebase selection
npm run test:functions        # backend unit/security and room checks
npm run test:callables        # backend callable state-machine suite (461)
tools/test_firestore_rules.sh # Firestore rules, against the emulator (170)
tools/test_storage_rules.sh   # Storage rules, against both emulators (30)
tools/test_private_location_cli.sh # private-location operator CLI regression
node tools/production_rules_check.mjs # deployed Firestore rules (46)
node tools/production_core_flow_smoke.mjs # isolated production core flow (25)
```

`npm test` runs the three backend/rules suites together. The functions are
compiled automatically before the Node checks read their helpers. The same
analysis, tests and release builds run in `.github/workflows/ci.yml` for
pushes and pull requests.

---

## Deployment

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full guide: environment
variables, the OTP providers, the deployment commands and the troubleshooting
notes.

Use this rollout order so existing accounts are not locked out by the stricter
registration checks. If Firebase CLI is installed only by the root `npm ci`,
replace `firebase` with `npx firebase` in the commands below:

```bash
firebase login
firebase use myfirstapp-fa30f52b

node tools/backfill_registration.mjs --apply   # legacy profiles get the marker
firebase deploy --only functions
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only storage

flutter build apk --release
```

The exact room address is stored in the server-owned
`roomPrivate/{roomId}` collection. Public `rooms/{roomId}` documents retain
only city/state and the rounded `geoCell`; an accepted student receives the
exact address through `getRoomVisitDetails`. The staged production rollout
for this project is complete and the durable finalization latch prevents the
legacy exact-public-write window from reopening. The full procedure and
recovery rules remain in
[`docs/PRIVATE_LOCATION_MIGRATION.md`](docs/PRIVATE_LOCATION_MIGRATION.md).

> **Rotate the mailbox token.** A live bearer token for the OTP mailbox was
> committed to the repository in `.mail_inbox.json`. The file has been deleted
> and is now git-ignored, but the token itself is still valid in the mail
> provider — revoke/rotate it there before the next deployment.
