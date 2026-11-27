# Firebase App Check rollout

StayServe now has the client and server pieces required for Firebase App
Check, but enforcement is deliberately staged. Enabling it before the mobile
apps are registered with the Firebase project would reject every callable
request.

## Current behaviour

- Android and iOS builds call `FirebaseAppCheck.instance.activate()` before
  the first Firestore or callable request.
- Debug builds use the App Check **debug** provider.
- Release Android builds use **Play Integrity**.
- Release iOS builds use **App Attest**, with DeviceCheck as a fallback.
- Web App Check uses the **reCAPTCHA Enterprise** key of the project. The key
  is registered for the Web app and the released web build carries it through
  `FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY`.
- A web build without any key intentionally skips App Check rather than
  failing startup, so the fallback stays available for local builds.
- Every callable uses one shared server-side switch:
  `APP_CHECK_ENFORCE=true`.
- The switch defaults to `false`, so the emulator and existing clients remain
  usable during the rollout.
- An App Check activation failure is logged but does not prevent the app from
  opening. The server switch is the final enforcement boundary.

## Readiness blockers

Do **not** set `APP_CHECK_ENFORCE=true` until all of these are resolved and
proved with real builds:

1. The web client carries the reCAPTCHA Enterprise key only in a build which
   was made with
   `--dart-define=FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY=…`.
   A build without that define intentionally sends no App Check token. Because
   callable enforcement is global, enabling it would also reject Web OTP and
   registration calls of such a build.
2. The checked-in iOS project does not yet contain the App Attest/DeviceCheck
   entitlement and Xcode capability. Add and validate them before testing an
   iOS release token.
3. Every Android debug, upload and Play App Signing SHA-256 fingerprint must
   be registered. The checked-in OAuth SHA-1 is not evidence of App Check
   readiness.
4. The installed-client version distribution must be known. Use the existing
   Remote Config `min_app_version` / `force_update` gate to retire a client
   which cannot satisfy the new callable/storage contract.
5. Every live callable probe must send a valid token. The checked-in probes
   read `STAYSERVE_APP_CHECK_TOKEN`; set `STAYSERVE_REQUIRE_APP_CHECK=1` so
   they fail before creating disposable production data when it is missing.
6. A missing and invalid token must be observed to receive HTTP 401 from a
   deployed callable. The local callable tests invoke handlers directly and do
   not prove the HTTP-level App Check gate.

## 1. Register the apps

In Firebase Console → App Check → Apps, register:

1. the Android app
   `1:96035616668:android:cfc3cf3dab21aa9488fa59`;
2. the iOS app
   `1:96035616668:ios:e77e14184c868cd688fa59`;
3. the Web app
   `1:96035616668:web:21b41ac4b3224e4d88fa59`.

For Android, add the SHA-256 certificate fingerprints used by every build
variant (debug and release). For iOS, enable the App Attest/DeviceCheck
capability for the app id and register the Apple team and bundle id.

Do not enable enforcement for Firestore or Storage yet. First roll out the
callable enforcement and observe it.

## 2. Register debug tokens

Debug builds use the debug provider. The native SDK prints the debug secret
in the device log. Register that secret under App Check → Manage debug
tokens.

The shared iOS debug scheme already passes `-FIRDebugEnabled`, so the secret
appears in the Xcode console. Android prints it in logcat.

A debug token is tied to one development machine/app installation. Register
a new token whenever the local debug environment changes.

## 3. Verify without breaking production

Keep this value in `functions/.env`:

```dotenv
APP_CHECK_ENFORCE=false
```

Deploy the client and functions, then verify:

- Android debug and release builds can obtain a token;
- iOS debug and release builds can obtain a token;
- an OTP, booking, payment, chat and admin action all work;
- the Functions logs show no App Check verification failures.

The local emulator and callable regression suite intentionally run with
enforcement disabled.

## 4. Enable callable enforcement

Only after every supported build has a valid token, set:

```dotenv
APP_CHECK_ENFORCE=true
```

and deploy the functions:

```bash
firebase deploy --only functions
```

All callable functions now use `enforceAppCheck: true`. A request with a
missing or invalid App Check token receives HTTP 401 before the callable
handler runs.

Monitor function errors and client reports immediately after deployment. If
old clients are still in use, either publish an updated client or temporarily
set the switch back to `false` and redeploy.

## 5. Enforce Firestore and Storage

Callable enforcement and Firebase service enforcement are separate settings.
After the updated mobile app has reached the required adoption level:

1. enable App Check enforcement for Firestore in Firebase Console;
2. test registration, login, listing reads, the server-mediated room-photo
   callables and every other callable from real Android and iOS builds;
3. keep browser App Check disabled until the reCAPTCHA v3 provider and site
   key are configured. Publishing the web client does not by itself enable
   App Check enforcement.

Do not enable a Firebase service in enforcement mode while a supported client
version can still call it without an App Check token.

The current Flutter app does not link the Firebase Storage client SDK. Room
photos are written by the Admin SDK from the server-mediated upload callable
and rendered from a server-issued download-token URL with a normal HTTP image
request. Cloud Storage service-level App Check therefore does not protect
that display path, and it is not required for the current app's upload
protocol. Before enabling it, inventory any remaining Storage SDK consumers
and validate the download-token and URL policy separately rather than
mistaking an App Check toggle for a complete room-photo access boundary.

## Web configuration

The Web Firebase app is registered as
`1:96035616668:web:21b41ac4b3224e4d88fa59`, and its `FirebaseOptions` live in
`lib/firebase/firebase_config.dart`.

The project has a **reCAPTCHA Enterprise** key for the web build. Its key
`6LdABDUuAAAAALANiAAsOKmI8DwqXO0G-LHu-4sB` is registered as the
`recaptchaEnterpriseConfig` of the Web app with a minimum risk score of `0.5`.
The key is restricted to the domains of the app:

```text
myfirstapp-fa30f52b.web.app
myfirstapp-fa30f52b.firebaseapp.com
localhost
stayserve.co.in
www.stayserve.co.in
```

Build the web client with that key:

```bash
flutter build web \
  --dart-define=FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY=6LdABDUuAAAAALANiAAsOKmI8DwqXO0G-LHu-4sB
```

The classic reCAPTCHA v3 key is still accepted as a fallback for a build which
only carries `FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY`. The Enterprise key is
preferred because it belongs to the project and can be limited to the domains
of the app.

The key of the **App Check** provider and the key of the **Identity Platform
phone provider** are two different things. The Identity Platform provisions
its own keys for the phone provider when the reCAPTCHA Enterprise bot
protection is enabled in the Firebase console; that integration is currently
off and must not be enabled through the REST API, because the API stores the
entry without the key. See the phone-provider section of
[`DEPLOYMENT.md`](../DEPLOYMENT.md).

Without any key the Flutter client intentionally skips web App Check rather
than failing startup. Callable enforcement must also remain disabled until
browser tokens have been validated.

## Rollback

Set `APP_CHECK_ENFORCE=false` and redeploy the functions. This disables only
the callable gate. Firestore and Storage enforcement must be disabled in
Firebase Console separately.
