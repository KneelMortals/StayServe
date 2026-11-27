import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/firebase/app_check/app_check_service.dart';

void main() {
  group('the reCAPTCHA key of the web build', () {
    test('a build without a key has no provider', () {
      // The test build carries no key, so App Check stays switched off.
      expect(AppCheckService.webRecaptchaKey(), isNull);
    });

    test('a key is never empty', () {
      final key = AppCheckService.webRecaptchaKey();
      if (key != null) {
        expect(key.trim(), isNotEmpty);
      }
    });

    test('the Enterprise key is preferred over the classic key', () {
      // The keys are compile-time constants. The test build defines none of
      // them, so the helper has to answer with `null` — and it must never
      // fall back to an empty key.
      final enterprise = AppCheckService.recaptchaEnterpriseSiteKey.trim();
      final classic = AppCheckService.recaptchaSiteKey.trim();

      if (enterprise.isNotEmpty) {
        expect(AppCheckService.webRecaptchaKey(), enterprise);
        expect(AppCheckService.usesEnterpriseRecaptcha, isTrue);
      } else if (classic.isNotEmpty) {
        expect(AppCheckService.webRecaptchaKey(), classic);
        expect(AppCheckService.usesEnterpriseRecaptcha, isFalse);
      } else {
        expect(AppCheckService.webRecaptchaKey(), isNull);
        expect(AppCheckService.usesEnterpriseRecaptcha, isFalse);
      }
    });

    test('the keys of the build are read from the environment', () {
      expect(
        AppCheckService.recaptchaSiteKey,
        const String.fromEnvironment('FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY'),
      );
      expect(
        AppCheckService.recaptchaEnterpriseSiteKey,
        const String.fromEnvironment(
          'FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY',
        ),
      );
    });
  });
}
