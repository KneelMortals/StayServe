# StayServe — Deployment & Configuration Guide

This document covers what has to be deployed and configured for the repaired
app to work end to end: the Firebase Cloud Functions (including the new OTP
functions), the Firestore rules, and the environment variables that drive OTP
delivery.

---

## 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Flutter | 3.50.0 (Dart 3.14.0) | `flutter --version` |
| Node.js | 22 | Required by `functions/` (`"runtime": "nodejs22"` in `firebase.json`) |
| Firebase CLI | 15.36.0 | Root `npm ci` installs the pinned local copy |

Firebase project: **`myfirstapp-fa30f52b`**
Android app id: `1:96035616668:android:cfc3cf3dab21aa9488fa59`

The commands below are shown as `firebase`. If Firebase CLI is installed only by
the root `npm ci`, run them as `npx firebase ...` from the repository root.

---

## 2. Firebase configuration lives in the repo

`lib/firebase/firebase_config.dart` contains separate Android, iOS and Web
Firebase options.

The project has separate Android, iOS and Web Firebase apps. The Web app is
`1:96035616668:web:21b41ac4b3224e4d88fa59`; its options are selected by
`kIsWeb` in `lib/firebase/firebase_config.dart`. Browser App Check remains
disabled until a reCAPTCHA v3 site key is configured, but authentication and
the normal Firebase services are ready for the published Hosting site.

---

## 3. Cloud Functions

### 3.1 Install dependencies

```bash
cd functions
npm ci --engine-strict
```

The OTP implementation deliberately adds **zero new npm dependencies** — it
uses the global `fetch` available in Node 18+, so only `firebase-admin` and
`firebase-functions` are required.

> **Why `functions/package.json` contains overrides:** `firebase-admin`
> 14.5.1 accepts `@firebase/database-compat` 2.1.4 or newer, but release
> 2.1.8 raised that package's Node requirement to 24.12. Firebase Functions
> currently supports Node 22, not Node 24. The lock therefore keeps
> `@firebase/database-compat` 2.1.7 and `@firebase/database` 1.1.5, the
> newest pair that still supports Node 20/22. Do not remove those overrides
> without checking the transitive `engines` field under Node 22.

### 3.2 Type-check

```bash
cd functions
npx tsc --noEmit
```

### 3.3 OTP environment variables

The `sendOtp` cloud function picks a delivery provider based on which
environment variables are present. **Set at least one email provider** —
otherwise the OTP is written to the Cloud Function logs instead of being
delivered (useful for local testing, not for production).

> **Phone (SMS) verification is currently switched off**, because SMS costs
> money. A single flag controls the whole feature:
>
> | `REQUIRE_PHONE_OTP` | Behaviour |
> |---|---|
> | `false` (default, current) | `sendOtp` / `verifyOtp` **refuse** the `mobile` channel, so no SMS can leave the backend and nothing can be spent on one. `completeRegistration` requires only a verified **email address** and stores the phone number as optional contact information. |
> | `true` | The phone number becomes mandatory again and has to be OTP-verified. Requires an SMS provider to be configured as well. |
>
> Switching it back on is: set `REQUIRE_PHONE_OTP=true`, configure an SMS
> provider, redeploy, and re-enable the phone step in the app
> (`register_screen.dart` and `role_selection_screen.dart`).

#### Email — pick one

| Variable | Required | Description |
|----------|----------|-------------|
| `BREVO_API_KEY` | yes (for Brevo) | Brevo API key — **the provider in production** |
| `BREVO_FROM_EMAIL` | optional | Overrides `OTP_FROM_EMAIL` for Brevo |
| `SENDGRID_API_KEY` | yes (for SendGrid) | SendGrid API key with "Mail Send" permission |
| `RESEND_API_KEY` | yes (for Resend) | Resend API key |
| `OTP_FROM_EMAIL` | recommended | Verified sender address, e.g. `no-reply@stayserve.app` |
| `OTP_FROM_NAME` | optional | Sender display name (defaults to `StayServe`) |

> **Provider order is SendGrid → Resend → Brevo.** The first one whose key is
> present wins, so if you switch providers you must **delete the old key**
> from `functions/.env` — a leftover `RESEND_API_KEY` silently keeps taking
> precedence over Brevo.
>
> **Brevo is the cheapest option that works without a domain**: you only
> verify a sender *email address* (Brevo mails you a confirmation link) and
> you can then send to anyone. Resend and SendGrid both need a verified
> domain, and Resend's `onboarding@resend.dev` sender only delivers to the
> address registered on the Resend account — useless for real users.

#### Mobile / SMS — pick one

| Provider | Variables |
|----------|-----------|
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` |
| Fast2SMS | `FAST2SMS_API_KEY` (optional `FAST2SMS_SENDER_ID`, default `TXTLNS`) |
| MSG91 | `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` |

| Variable | Required | Description |
|----------|----------|-------------|
| `DEFAULT_COUNTRY_CODE` | optional | Country code added to a bare 10-digit mobile number (default `91`) |

> SendGrid/Resend need a **verified domain or sender**. Twilio needs a
> **trial-capable or purchased number**. Fast2SMS and MSG91 are the easiest
> fit for Indian 10-digit numbers.
>
> **Country codes matter.** A user typing `9876543210` is stored and sent as
> `+919876543210`. Without `DEFAULT_COUNTRY_CODE` the SMS provider would
> receive an unrouteable 10-digit number and the message would never arrive.

### 3.4 Set the variables

Copy `functions/.env.example` to `functions/.env` and fill it in:

```bash
cd functions
cp .env.example .env
```

```bash
# functions/.env
BREVO_API_KEY=xkeysib-xxxxxxxxxxxxxxxx
OTP_FROM_EMAIL=you@gmail.com
OTP_FROM_NAME=StayServe
DEFAULT_COUNTRY_CODE=91
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_FROM_NUMBER=+15551234567
PLATFORM_UPI_VPA=shauryaprataprai461-2@oksbi
PLATFORM_UPI_NAME=StayServe
PLATFORM_FEE_PERCENTAGE=30
```

> `functions/.env` is git-ignored. `functions/.env.example` documents every
> variable and is safe to commit.
>
> `functions:config:set` still works for older runtimes, but `.env` is the
> supported way on the Functions v2 runtime.

### 3.5 Payment environment variables

The payment functions build the UPI intent **server side**, so the payee and
the amount cannot be tampered with by a modified client. Configure them with:

| Variable | Default | Description |
|----------|---------|-------------|
| `PLATFORM_UPI_VPA` | `shauryaprataprai461-2@oksbi` | The UPI address that receives **every** payment collected through the app |
| `PLATFORM_UPI_NAME` | `StayServe` | Payee name shown inside the UPI app |
| `PLATFORM_FEE_PERCENTAGE` | `30` | Percentage of the monthly rent charged as the platform fee |

```bash
# functions/.env
PLATFORM_UPI_VPA=shauryaprataprai461-2@oksbi
PLATFORM_UPI_NAME=StayServe
PLATFORM_FEE_PERCENTAGE=30
```

> **Keep `PLATFORM_UPI_VPA` in sync with `AppConstants.platformUpiVpa`** in
> `lib/core/constants/app_constants.dart`. The client asserts that the VPA
> returned by the server matches its own constant and aborts the payment if it
> does not — a misconfigured server therefore fails loudly instead of
> silently redirecting the money.

### 3.6 Deploy

Use this order — the stricter rules require the registration marker, so the
legacy profiles have to be backfilled **before** the rules are deployed:

```bash
cd ~/Desktop/StayServe
firebase login
firebase use myfirstapp-fa30f52b

node tools/backfill_registration.mjs --apply    # dry run first, without --apply
node tools/backfill_rooms.mjs --apply           # dry run first, without --apply
firebase deploy --only functions
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only storage
```

Or only the OTP + payment surface, while iterating:

```bash
firebase deploy --only \
  functions:sendOtp,functions:verifyOtp,functions:registerUserRole,functions:completeRegistration,\
  functions:createUpiPayment,functions:submitPayment,functions:verifyPayment
```

> The `predeploy` hook in `firebase.json` runs `npm --prefix functions run
> build`, so the TypeScript is compiled automatically. The new composite
> indexes for the `payments` collection are **required** — without them the
> admin payments list and the student payments list fail with
> "The query requires an index". Deploy them with
> `firebase deploy --only firestore:indexes`.

### 3.7 Firebase App Check (staged rollout)

The Android and iOS clients activate App Check automatically. Callable
enforcement is controlled by one environment variable and is **off by
default** so an unregistered provider cannot take the API offline:

```dotenv
# functions/.env
APP_CHECK_ENFORCE=false
```

Register the Android/iOS apps, release providers and debug tokens first. Set
the value to `true` and redeploy the functions only after every supported
client has a valid token. Firestore and Storage enforcement are separate
Firebase Console settings and must only be enabled after the callable rollout
has succeeded.

The complete rollout and rollback checklist is in
[`docs/APP_CHECK_ROLLOUT.md`](docs/APP_CHECK_ROLLOUT.md).

---

## 4. What the OTP functions do

| Function | Callable | Purpose |
|----------|----------|---------|
| `sendOtp` | yes | Issues a 6-digit code for an email or mobile number |
| `verifyOtp` | yes | Validates a code and marks the contact verified |
| `completeRegistration` | yes | Completes sign-up: re-checks **both** OTPs server side and writes the profile |
| `registerUserRole` | yes | Lets a signed-in user claim `student` / `owner` after email verification |

Security properties:

* Codes are stored **SHA-256 hashed with a per-code random salt** — the
  plaintext never touches Firestore.
* **5 minute** expiry.
* **30 second** cooldown between sends, **5 sends per hour** per contact.
* **5 verification attempts**, then the code is invalidated.
* Comparison uses `crypto.timingSafeEqual` (constant time).
* The `otpCodes` collection is locked down in `firestore.rules`
  (`allow read, write: if false;`) — only the Cloud Functions can touch it.
* `registerUserRole` only allows `student` and `owner`; `admin` still has to
  be granted by an existing admin through the `setUserRole` callable.
* `completeRegistration` **requires a verified mobile number**. The phone
  number on the profile is the one the server checked, so a modified client
  cannot register with an unverified number. The app also invalidates the
  verification whenever the email or phone field is edited.

### 4.1 What the payment functions do

| Function | Callable | Purpose |
|----------|----------|---------|
| `createUpiPayment` | yes | Builds the UPI intent — **the server decides the payee and the amount** |
| `submitPayment` | yes | Records the UTR the student paid with, in the `submitted` state |
| `verifyPayment` | yes | **Admin only.** The single place where `advancePaid` becomes `true` |

The full money and booking flow is:

```
student requests room      → joinRequests.status = pending
owner accepts              → joinRequests.status = ownerConfirmed
student confirms           → joinRequests.status = studentConfirmed
payer submits the fee      → payments.status      = submitted
admin verifies the UTR     → payments.status      = verified
                             joinRequests.status  = adminReviewed
                             joinRequests.advancePaid = true (when money is due)
                             commission invoice created
                             room currentOccupancy incremented
```

`adminReviewed` is the joined-room state. **Payment submission alone does not
activate a booking.** It records a reference for an admin to verify; it does
not create an invoice, change occupancy or make the room appear in the
student's joined rooms. `verifyPayment(approve=true)` is the single normal
activation transition and performs the request, payment, invoice and occupancy
changes atomically. Rejecting a submitted payment restores the payable state;
only a legacy booking that was already active releases occupancy when it is
rejected.

Security properties:

* The **amount** is recomputed by the server from `monthlyRentAtJoin` — the
  client cannot choose what it pays.
* The **payee** comes from `PLATFORM_UPI_VPA` — the client cannot redirect
  the money to another account.
* `submitPayment` never marks a payment as paid; it only records the
  reference in the `submitted` state. A transaction reference may only be used
  once.
* `verifyPayment` checks the caller's **live** Firestore administrator
  profile (`role == admin`, `isActive == true` and a completed registration).
  A stale `admin` custom claim alone is not sufficient.
* `firestore.rules` blocks clients from writing the payment fields on
  `joinRequests` (`advancePaid`, `advanceAmount`, `advancePaymentReference`,
  `advancePaymentMethod`, `advanceUpiTransactionId`, `advancePaidAt`,
  `advancePaymentStatus`) and makes the `payments` collection
  write-only for the Cloud Functions.
* `adminReviewRequest` cannot activate a booking. It is only an idempotent
  acknowledgement for an already active booking or a rejection path for a
  request that was never paid.


### 4.2 Testing without a delivery provider

With no provider configured, the code is logged instead of being sent:

```
[OTP] No delivery provider configured for email. Code for user@example.com is 123456 (expires in 5 min).
```

Read it with:

```bash
firebase functions:log --only sendOtp
```

> The `firebase functions:log` output contains ANSI/spinner noise, so a
> `grep -oE '[0-9]{6}'` can pick up digits from the timestamp or the phone
> number instead of the code. Prefer a targeted match:
>
> ```bash
> firebase functions:log --only sendOtp -n 5 \
>   | sed -nE 's/.*Code for \+?[0-9]+ is ([0-9]{6}).*/\1/p' | tail -1
> ```
>
> Note that the number in the log is the **normalised** one
> (`9876543210` → `+919876543210`), and that Cloud Logging ingestion lags by
> a few seconds — read the log only *after* the entry has appeared.

In this mode `sendOtp` answers with `delivered: false`. The app reacts to
that: instead of claiming "we sent you a code" it shows a warning banner
("We could not deliver the email/SMS") with a retry button, so a user is
never left waiting for a message that was never sent.

---

## 5. Firestore rules

`firestore.rules` is deployed with:

```bash
firebase deploy --only firestore:rules
```

Key collections: `users`, `rooms`, `joinRequests`, `payments`,
`commissionInvoices`, `notifications`, `conversations` (+ `messages`
subcollection), `settings`, `publicSettings`, `roomReviews`, `otpCodes`,
`otpSendQuota`, `paymentReferences`, `joinRequestLocks`, `system`.

### 5.1 What is server-owned

The rules deny every client write that could forge money, occupancy or
membership. The corresponding work happens in a Cloud Function that checks the
**live** profile of the caller:

| Collection / field | Client may | Server owns |
|---|---|---|
| `users/{uid}` | read own profile, write `name`, `phone`, `profileImage`, `fcmToken`, `savedRooms`, `pincode`, `updatedAt` | `role`, `isActive`, `registrationCompleted`, the whole document **delete** |
| `rooms/{roomId}` | create a listing (with the **initial** `status: available` / `currentOccupancy: 0`, or with both fields left out), edit the listing fields | any other `status` / `currentOccupancy` value, the document **delete** |
| `joinRequests/{id}` | read own/own-room requests | **everything** — create, update and delete |
| `payments/{id}` | read own/own-room payments | **everything** — write |
| `commissionInvoices/{id}` | live admin may set `status` + bookkeeping | create, delete, amount, rent, parties |
| `notifications/{id}` | read own, set the read bookkeeping | create, content, routing, **delete** |
| `conversations/{id}` | two-party conversations, own messages | the participant list, the conversation id, the creation time |

The callables that replace those client writes:

| Callable | Who may call it | What it does |
|---|---|---|
| `setRoomListingAvailability` | live owner of the listing | changes `rooms.status` only |
| `adminSetRoomListingStatus` | live admin | changes `rooms.status` of any listing |
| `deleteRoomListing` | live owner (own listing) or live admin | cancels the open requests, keeps their history, removes the listing; refuses an active booking or a pending payment |
| `deleteNotification` | the owner of the notification | removes one notification |
| `verifyPayment` | live admin | activates the booking (request, payment, invoice, occupancy) atomically |
| `unbanUser` / `banUser` / `revokeUserTokens` | live admin | account state and token revocation |

Every one of them re-reads the profile of the caller, so a demoted or banned
administrator loses the access immediately — a stale custom claim is never
enough.

### 5.1.1 The listing fields a student searches by

The student search compares the listing status with an **equality**
(`status == available`). A Firestore equality query never matches a document
that does not have the field, so a listing without a status would be
invisible to every student — even though it is a valid listing.

Three things keep that from happening:

1. the create payload states the initial values (`status: available`,
   `currentOccupancy: 0`); the rules accept **only** those two values, so a
   client can neither publish a listing as occupied nor pretend that it
   already has tenants;
2. the `onRoomCreated` trigger gives a listing the same defaults when a
   client left them out (an older app version);
3. the app filters the status **in Dart**, so a listing whose status is
   missing is still offered (a missing status means "available").

Listings that were written before this rule existed are repaired with:

```bash
node tools/backfill_rooms.mjs          # dry run
node tools/backfill_rooms.mjs --apply  # write status/currentOccupancy
```

The script is idempotent, only fills in **missing** fields and uses the
document's `updateTime` as a precondition. A listing that is already
`inactive` or `occupied` keeps its status.

> **Status of this project:** the backfill has been applied — both listings
> now carry `status: available` and `currentOccupancy: 0`. A fresh dry run
> reports `Already complete: 2, Legacy candidates: 0`.

The end-to-end proof (a throw-away owner uploads a listing, a throw-away
student searches for it) runs against the deployed project:

```bash
node tools/verify_room_visibility.mjs
```

### 5.1.2 The registration marker

A profile is only a *live* account when it has
`registrationCompleted: true` **and** `isActive: true`. New accounts are
created by the `onUserCreate` trigger with `registrationCompleted: false` and
become usable when `completeRegistration` writes the marker.

Legacy profiles (created before the marker existed) are backfilled with:

```bash
node tools/backfill_registration.mjs          # dry run
node tools/backfill_registration.mjs --apply  # write the marker
```

The script is idempotent and uses the document's `updateTime` as a
precondition. A profile that explicitly says `registrationCompleted: false` is
a new, unfinished registration and is never backfilled; an explicit
`isActive: false` is never re-enabled.

> **Status of this project:** the backfill has been applied — the one legacy
> profile (`vALy1rgiCGPWNOrKqyPKBOyctQz2`, the admin) now carries
> `registrationCompleted: true`. A fresh dry run reports
> `Already complete: 1, Legacy candidates: 0`, so re-running it is a no-op.

For a staged rollout the rules also understand an optional migration switch
that only the Admin SDK can write:

```
system/registration
  legacyMode: true
  legacyCutoff: <timestamp>
```

While `legacyMode` is true, a profile that was created **before** the cutoff
and has neither marker may still be used. Set `legacyMode: false` when the
backfill is complete — from that point on a missing value is always denied.

### 5.2 Testing the rules locally

The rules are covered by automated test suites that run against the local
Firestore and Storage emulators:

```bash
cd ~/Desktop/StayServe
tools/test_firestore_rules.sh
tools/test_storage_rules.sh
```

The Firestore suite exercises 170 allow/deny assertions (the account state,
profile writes, room fields and image lists, server-owned booking/payment/
invoice collections, notification bookkeeping, two-party messaging, capacity
guards and the migration switch). The Storage suite starts Firestore and
Storage together and exercises 30 assertions covering owner isolation, live
role changes, admin isolation, image type/size validation, deletes and the
production two-document-access invariant. Both suites print a summary and exit
with a non-zero status if an assertion fails.

### 5.3 Testing the *deployed* rules

The emulator cannot reproduce every production behaviour (see gotcha 3
below), so the deployed rules are verified against the real project:

```bash
cd ~/Desktop/StayServe
node tools/production_rules_check.mjs
```

The script creates a **throw-away account**, turns it into a live owner
through the server-side channel (the Firebase CLI OAuth token, exactly like
the backfill script) and then exercises the allow/deny paths with the
account's own ID token — the same token the app uses. Everything it created
is removed again, including the account.

Run it after every rules deployment. It needs `firebase login` (no
service-account key) and it **writes to the production database**: the
throw-away account, its profile, one notification and two complete
public/private room listings are created and deleted again.

> **Current status:** the rules are deployed and the script reports
> **46 passed, 0 failed** against the real project (it creates the throw-away
> account, promotes it through the server-side channel, creates two complete
> public/private listings, exercises the critical allow/deny paths and removes
> every listing, profile, notification and completed cleanup-job artifact
> again — the database is verified clean afterwards).
>
> The listing assertions are:
>
> | Assertion | Rule |
> |---|---|
> | an owner may create their own room (without the server-owned fields) | the create may leave `status` / `currentOccupancy` out |
> | an owner may send the initial server-owned state on create | only `available` / `0` are accepted on the create |
> | an owner may NOT create a room that is already occupied | a client cannot publish a listing as occupied |
> | an owner may NOT change the listing status directly | `setRoomListingAvailability` owns it |
> | an owner may NOT change the occupancy counter directly | the booking state machine owns it |
> | an owner may NOT delete a room directly | `deleteRoomListing` owns it |

> **Three gotchas when editing `firestore.rules`:**
>
> 1. The rules language has **no `if` statements** — a function body may only
>    contain `let` declarations and a single `return` expression. Use `&&`,
>    `||` and the ternary operator instead.
> 2. `old` and `new` are **reserved words** — name your `let` variables
>    `fromStatus` / `toStatus` instead.
> 3. **Reading a missing key of a map raises an evaluation error.** Always
>    read an optional custom claim through `get()`:
>
>    ```r
>    // WRONG — errors for every account without the claim
>    request.auth.token.admin == true
>
>    // RIGHT
>    request.auth.token.get('admin', false) == true
>    ```
>
>    This one is dangerous because the **emulator hides it**: the emulator's
>    CEL turns `error || true` into `true`, so a rule that is broken in
>    production still passes every emulator test. The production engine
>    propagates the error, and the whole rule is denied. That is exactly
>    what happened with `isAdmin()`: because a freshly registered account
>    has no `admin` claim yet (the claim is attached asynchronously by the
>    `onUserCreate` trigger), **every** rule that mentioned `isAdmin()` was
>    denied for regular users — including the join-request update and the
>    payment list. The test suite now lints `firestore.rules` for direct
>    accesses to optional claims, because the emulator alone cannot detect
>    this class of bug.
>
> The emulator reports the first two mistakes as
> `Error compiling rules: L<line>:<column> Unexpected 'if'`, which is easy to
> miss because it only surfaces when the first request hits the emulator.

### 5.4 Production core-flow smoke test

The deployed-rules check proves individual allow/deny paths. The separate
core-flow script proves that those paths still work together in production:

```bash
cd ~/Desktop/StayServe
node tools/production_core_flow_smoke.mjs
```

It creates one disposable live owner, one disposable live student, one room
photo, one public/private listing, one booking request, one verified
conversation and one message. It then exercises owner create/edit, the private
location callable, student-only booking, owner approval, student confirmation,
the accepted-student visit details, messaging, listing deletion and both
account-deletion triggers. The script deletes the listing through
`deleteRoomListing`, deletes both Auth accounts, removes the completed
account-deletion job tombstones and verifies that no disposable profile,
request, lock, conversation, notification, private location, cleanup job or
Storage object remains.

> **Current status:** the script reports **25 passed, 0 failed** against
> `myfirstapp-fa30f52b`. It needs `firebase login` and deliberately writes
> disposable production data while it runs; every artifact is removed before
> the command exits.

### 5.5 Storage rules

`storage.rules` is deployed with:

```bash
firebase deploy --only storage
```

The rules read the **live** Firestore profile of the caller — a custom claim
alone is not enough, because a demoted admin keeps the old claim until the
token expires:

* `rooms/{ownerId}/{roomId}/{fileName}` may be read by every live, registered
  account and written only by the live owner of that folder (non-empty image
  objects up to 5 MiB);
* `admin/{fileName}` may be written by a live administrator;
* every other client write is denied. In particular, an administrator cannot
  overwrite or delete an owner's room image through the Storage API.

A room-photo write reads exactly two distinct Firestore documents: the
caller's live profile and the durable `roomDeletionTombstones/{roomId}`
reservation. Firebase permits at most two distinct Firestore documents in one
Storage Rules evaluation, so the rule must not also read the public room
document. The listing-deletion transaction commits the tombstone together
with the room's `deletionInProgress` marker; the tombstone therefore closes
the upload path both during deletion and after the room document is gone.

The rules are **fail-closed**: a profile without `registrationCompleted: true`
or with `isActive: false` has no access at all. Backfill the legacy profiles
(section 5.1.2) before the first deployment of these rules.

### 5.6 Storage bucket CORS for the web client

Storage rules and bucket CORS are separate Firebase configurations.
`firebase deploy --only storage` updates the rules but **does not update the
bucket's CORS metadata**. The Flutter web client needs CORS response headers
to decode room photos; mobile clients work without them.

The checked-in policy is `storage.cors.json`. It permits read-only `GET` and
`HEAD` requests from the published Hosting domains and the local Flutter-web
development origins on port 8080. Run local web development with
`flutter run -d chrome --web-port=8080`. Verify the live bucket without
changing it:

```bash
npm run storage:cors:check
```

After explicitly approving the production bucket change, apply the policy:

```bash
npm run storage:cors:apply
```

The apply command uses the bucket metageneration as a precondition, so it
fails instead of overwriting a concurrent bucket-metadata update. It changes
only CORS metadata; it does not modify Storage rules, room images, or Firestore
data.

---

## 6. Building the app

```bash
cd ~/Desktop/StayServe
flutter pub get
flutter analyze lib     # expect: No issues found!
dart analyze lib test  # expect: No issues found!
flutter build apk --debug
```

Output: `build/app/outputs/flutter-apk/app-debug.apk`

Build and publish the web client separately:

```bash
flutter build web --release
npm run web:seo:check
firebase deploy --only hosting --project myfirstapp-fa30f52b
```

The web build selects the registered Web Firebase app automatically. The
canonical-domain, robots, sitemap, Search Console, and custom-domain cutover
procedure is documented in
[`docs/DOMAIN_AND_SEARCH_READINESS.md`](docs/DOMAIN_AND_SEARCH_READINESS.md).
Do not deploy Hosting until the approved custom-domain and canonical-origin
cutover is complete. Do not pass a reCAPTCHA site key until browser App Check
has been registered and validated; without one, the client intentionally skips
browser App Check.

There is **no `build_runner` step**. The models are hand-written, so code
generation is not part of the build.

The Cloud Functions are type-checked separately:

```bash
cd functions && npx tsc --noEmit   # expect: no output
```

---

## 7. Troubleshooting

### 7.1 `Failed file name validation for file .../android12splash 3.png`

The Flutter tool occasionally leaves **duplicate files with a `" N"` suffix**
(e.g. `android12splash 3.png`, `Generated 2.xcconfig`,
`cloud_firestore-5.6.12 10`) behind when a previous run was interrupted. The
duplicates in `ios/Flutter/ephemeral` are symlink farms created by the Swift
Package Manager integration; the ones under `build/` are stale copies that AGP
then merges into the resource set, which makes `ParseLibraryResourcesTask`
fail because Android resource names cannot contain spaces.

Fix:

```bash
cd ~/Desktop/StayServe
rm -rf build
rm -rf ios/Flutter/ephemeral macos/Flutter/ephemeral
rm -rf .dart_tool/hooks_runner
flutter pub get
flutter build apk --debug
```

Check for leftovers at any time:

```bash
find . \( -type f -o -type l \) -name "* [0-9]*" | grep -v _backup_stray_generated
```

The 46 Dart files that were originally affected are preserved in
`_backup_stray_generated/` (git-ignored) rather than deleted, so they can be
inspected or restored if needed.

### 7.2 `flutter analyze` appears to hang

`flutter analyze` without a path scans the whole project tree, including the
multi-gigabyte `build/` directory, and can take a very long time on a cold
cache. Use the scoped form instead:

```bash
flutter analyze lib      # ~4 seconds
```

`dart analyze .` produces the same diagnostics for the whole project.

---

## 8. Promoting a user to admin

The app can **never** hand out the first admin role on its own:

| Where | What it allows |
|---|---|
| `registerUserRole` (sign-up) | only `student` and `owner` — a user can never claim `admin` for themselves |
| `setUserRole` (callable) | only an account that is *already* an admin may call it |
| `firestore.rules` | **no** client may write the `role` field of a profile — the role is server-owned |

So the first admin has to be granted **out of band**. `tools/make_admin.mjs`
does that:

```bash
cd ~/Desktop/StayServe

# list every account with its current role
node tools/make_admin.mjs --list

# promote somebody to admin
node tools/make_admin.mjs --email you@example.com

# promote somebody to admin by uid
node tools/make_admin.mjs --uid vALy1rgiCGPWNOrKqyPKBOyctQz2

# take the admin role away again
node tools/make_admin.mjs --email you@example.com --role student
```

The script writes **both** halves of the role:

1. the custom claim `{"role":"admin","admin":true}` in Firebase Auth, and
2. `users/{uid}.role = "admin"` in Cloud Firestore.

Both are needed: the **claim** decides what the Firestore rules allow, the
**profile field** decides what the app shows. The script also creates the
profile document if the user does not have one yet.

**Authentication:** the script reuses the OAuth token of the Firebase CLI, so
the machine only needs `firebase login` — no service-account key:

```bash
npm i -g firebase-tools
firebase login
```

The CLI token expires after about an hour; the script refreshes it
automatically by running a harmless `firebase projects:list` first.

> **After promoting somebody, that user has to sign out and sign in again.**
> The ID token that is already in the app still carries the old claims. The
> app refreshes the token (`getIdToken(true)`) on every session start, so a
> fresh sign-in always picks up the new role.
>
> The Identity Toolkit REST API does not expose a "revoke the refresh tokens"
> method (that only exists in the Admin SDK, which would need a
> service-account key), so the script cannot force it — sign out and in again.
>
> **Only promote an account whose password you control.** An admin can approve
> bookings, verify payments and read every profile in the project.

Check the result with:

```bash
node tools/make_admin.mjs --list
```

The current admin of this project is **`shauryapratapraiom@gmail.com`**
(uid `vALy1rgiCGPWNOrKqyPKBOyctQz2`).

---

## 9. Remaining known issues

1. **Phone (SMS) verification is switched off** (`REQUIRE_PHONE_OTP=false`).
   The email address is the only verified identity, and the phone number is
   optional contact information. This is deliberate: SMS costs roughly
   INR 0.25–7 per message and the feature is not paid for yet. Turning it
   back on is documented in section 3.3.
2. **Browser App Check is not enabled yet.** The Web Firebase app is
   registered and the Hosting build uses its own configuration, but a
   reCAPTCHA v3 site key is still required before browser App Check can be
   activated. The shared callable-enforcement switch remains `false` until
   every supported client has a valid token.
3. **The UPI VPA is duplicated in two places** — the `PLATFORM_UPI_VPA`
   environment variable of the Cloud Function and
   `AppConstants.platformUpiVpa` in the app. The client asserts that both
   match, so a mismatch fails loudly instead of redirecting money, but the
   value still has to be updated in both places.
4. **UPI payment confirmation is admin-mediated.** The app records the
   transaction reference the user typed in and an admin confirms it; there is
   no payment-gateway webhook to confirm the money actually arrived
   automatically. A gateway webhook (e.g. Razorpay/Cashfree) would remove
   the manual step.
5. **OTP delivery is not end-to-end encrypted** — the code is hashed at rest
   in Firestore, but it travels over the provider's own channel (email/SMS).
   Consider adding a second factor for admin accounts.
6. **The root dev dependency still carries 13 moderate `npm audit`
   advisories.** They all come through `firebase-tools` and affect the local
   CLI/emulator toolchain, not the deployed Functions. The Functions runtime
   itself has **0** production advisories. The audit's suggested fix is an
   unsafe downgrade of `firebase-tools`, so it is intentionally not applied.
7. **Some end-to-end paths still depend on external services.** The local
   suite contains 311 Dart/widget tests, 461 backend callable
   state-machine/security checks, 170 Firestore-rules assertions and 30
   Storage-rules assertions. The private-location operator CLI has its own
   regression suite. Against production, the deployed-rules check reports 46
   passing assertions and the isolated core-flow smoke test reports 25; both
   remove their disposable artifacts before exiting. The OTP sign-up flow is
   additionally covered end to end by `tools/signup_e2e.mjs` (real mail → code
   → verify → profile written).
8. **The custom claims are attached asynchronously.** `completeRegistration`
   and the revision-aware role-claim jobs publish the `role` / `admin` claims
   after the authoritative Firestore profile changes, so the token issued at
   sign-up may not carry them immediately. The app refreshes the token after
   registration, on session start and after a role change, but a third-party
   client that talks to the project directly would have to do the same.
9. **Old clients need a minimum-version or force-update transition.** The
    production location rollout is finalized: exact addresses live only in
    `roomPrivate/{roomId}`, public listings retain city/state and the rounded
    `geoCell`, and the durable privacy latch prevents the legacy exact-write
    window from reopening. An old client can therefore no longer save an exact
    public location or create a conversation directly. Distribution should
    require a current client version before old builds are retired.
10. **A live mailbox bearer token was committed in `.mail_inbox.json`.** The
    file has been deleted and is git-ignored, but the token is still valid at
    the mail provider: **rotate/revoke it there.** Anyone who read the old
    repository can read the OTP inbox until it is revoked.
11. **The stricter rules and legacy backfills are live.** All five production
    profiles are active and registration-complete. The two pre-existing
    listings received the server-owned `status` / `currentOccupancy` values,
    and both now have exactly one matching private location. A newly created
    legacy-shaped profile would still need the documented backfill or the
    temporary legacy window, but there is no remaining production profile in
    that state.
12. **The new Firestore rules and all 43 Cloud Functions are deployed.** The
    deployed Firestore and Storage rules match the tested local files, every
    function is `ACTIVE` on Node.js 22, and the complete private-location
    verification reports `publicExactRemaining = 0`. The `onRoomCreated`
    trigger must remain deployed: it assigns the server-owned listing
    defaults and the immutable listing generation.

---

## 10. Demo rooms

The app was reported to show random demo rooms after login. Both possible
sources were checked and are clean:

* **Firestore** — the `rooms` collection holds only the **real** listings of
  the real users (verified through the Firestore REST API with a throw-away
  account that was deleted afterwards), and every other candidate collection
  name is denied by the catch-all rule.
* **The code** — there is no mock/demo room data anywhere under `lib/`. The
  hardcoded mock lists were removed in the first repair round.

If demo rooms are still visible, the running app is an **old build** — install
the freshly built APK (`build/app/outputs/flutter-apk/app-debug.apk`). The
rooms that were shown came from the old hardcoded lists, not from the
database.

> The listings that are really in the database are visible in the student
> search. A listing that was written without the server-owned `status` was
> invisible there — the backfill (`tools/backfill_rooms.mjs`) has repaired the
> two existing listings, and `tools/verify_room_visibility.mjs` proves the
> whole path end to end against the deployed project.
