import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:flutter/foundation.dart';

import '../../../core/utils/app_logger.dart';

/// Activates Firebase App Check before the app starts using Firebase data.
class AppCheckService {
  const AppCheckService._();

  /// The reCAPTCHA v3 key used by the web build.
  ///
  /// The web Firebase app is registered, but the reCAPTCHA site key remains
  /// optional while browser App Check is not enabled. Pass it at build time
  /// when the provider is configured:
  ///
  /// ```sh
  /// flutter build web \
  ///   --dart-define=FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY=...
  /// ```
  static const String recaptchaSiteKey = String.fromEnvironment(
    'FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY',
  );

  /// The reCAPTCHA **Enterprise** key used by the web build.
  ///
  /// The Enterprise key belongs to the same project as the app and it can be
  /// limited to the domains of the app, so it is the one which is used when
  /// it is given:
  ///
  /// ```sh
  /// flutter build web \
  ///   --dart-define=FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY=...
  /// ```
  static const String recaptchaEnterpriseSiteKey = String.fromEnvironment(
    'FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY',
  );

  /// The reCAPTCHA key of the web build.
  ///
  /// The Enterprise key is preferred: it belongs to the project of the app
  /// and it can be limited to the domains of the app. The classic v3 key is
  /// the fallback for a build which only has that one. `null` is returned
  /// when the build carries no key at all.
  static String? webRecaptchaKey() {
    final enterpriseKey = recaptchaEnterpriseSiteKey.trim();
    if (enterpriseKey.isNotEmpty) return enterpriseKey;
    final classicKey = recaptchaSiteKey.trim();
    if (classicKey.isNotEmpty) return classicKey;
    return null;
  }

  /// Whether the web build uses the reCAPTCHA Enterprise key.
  static bool get usesEnterpriseRecaptcha =>
      recaptchaEnterpriseSiteKey.trim().isNotEmpty;

  /// Activates the best App Check provider for the current build.
  ///
  /// Debug builds use the debug provider so their token can be registered in
  /// the Firebase console. Release builds use Play Integrity on Android and
  /// App Attest (with DeviceCheck fallback) on iOS.
  ///
  /// App Check is an additional security layer, not an authentication
  /// requirement. A provider failure is therefore logged but does not stop
  /// the app from opening. The backend keeps its own enforcement switch so
  /// the rollout can be enabled only after the providers are registered.
  static Future<bool> activate() async {
    try {
      if (kIsWeb) {
        final key = webRecaptchaKey();
        if (key == null) {
          AppLogger.info(
            'App Check was not activated for web: no reCAPTCHA site key was '
            'provided.',
          );
          return false;
        }

        await FirebaseAppCheck.instance.activate(
          webProvider: usesEnterpriseRecaptcha
              ? ReCaptchaEnterpriseProvider(key)
              : ReCaptchaV3Provider(key),
        );
      } else {
        final platform = defaultTargetPlatform;
        if (platform != TargetPlatform.android &&
            platform != TargetPlatform.iOS) {
          AppLogger.info(
            'App Check was not activated on $platform: StayServe currently '
            'supports Android and iOS.',
          );
          return false;
        }

        await FirebaseAppCheck.instance.activate(
          androidProvider: kDebugMode
              ? AndroidProvider.debug
              : AndroidProvider.playIntegrity,
          appleProvider: kDebugMode
              ? AppleProvider.debug
              : AppleProvider.appAttestWithDeviceCheckFallback,
        );
      }

      await FirebaseAppCheck.instance.setTokenAutoRefreshEnabled(true);
      AppLogger.info('Firebase App Check was activated.');
      return true;
    } catch (error, stackTrace) {
      AppLogger.warning(
        'Firebase App Check could not be activated. The app will continue, '
        'but server-side App Check enforcement must stay disabled until the '
        'provider is configured.',
        error: error,
        stackTrace: stackTrace,
      );
      return false;
    }
  }
}
