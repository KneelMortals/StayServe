# Firebase App Check rollout

StayServe now has the client and server pieces required for Firebase App
Check, but enforcement is deliberately staged. Enabling it before the mobile
apps are registered with the Firebase project would reject every callable
request.

## Current behaviour

- Android and iOS builds call `FirebaseAppCheck.instance.activate()` before
  the first Firestore, Storage or callable request.
- Debug builds use the App Check **debug** provider.
- Release Android builds use **Play Integrity**.
- Release iOS builds use **App Attest**, with DeviceCheck as a fallback.
- Web App Check is inactive until a Web Firebase app and a reCAPTCHA v3 site
  key exist.
- Every callable uses one shared server-side switch:
  `APP_CHECK_ENFORCE=true`.
- The switch defaults to `false`, so the emulator and existing clients remain
  usable during the rollout.
- An App Check activation failure is logged but does not prevent the app from
  opening. The server switch is the final enforcement boundary.

## 1. Register the apps

In Firebase Console → App Check → Apps, register:

1. the Android app
   `1:96035616668:android:cfc3cf3dab21aa9488fa59`;
2. the iOS app
   `1:96035616668:ios:e77e14184c868cd688fa59`.

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
2. enable App Check enforcement for Cloud Storage;
3. test registration, login, listing reads, photo upload/download and every
   callable from real Android and iOS builds;
4. keep the web deployment disabled until a Web Firebase app and reCAPTCHA
   key are configured.

Do not enable a Firebase service in enforcement mode while a supported client
version can still call it without an App Check token.

## Web configuration

The project currently has no Web Firebase app. When one is registered, add
its `FirebaseOptions` to `lib/firebase/firebase_config.dart` and build with:

```bash
flutter build web \
  --dart-define=FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY=your-site-key
```

Without that key the Flutter client intentionally skips web App Check rather
than failing startup.

## Rollback

Set `APP_CHECK_ENFORCE=false` and redeploy the functions. This disables only
the callable gate. Firestore and Storage enforcement must be disabled in
Firebase Console separately.
