import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Android delivery configuration', () {
    test('delegates ABI splitting to Flutter and equalizes version codes', () {
      final buildFile = File('android/app/build.gradle.kts').readAsStringSync();

      expect(buildFile, isNot(contains('abiFilters.clear')));
      expect(buildFile, isNot(contains('isUniversalApk')));
      expect(
        RegExp(r'\bsplits\s*\{').hasMatch(buildFile),
        isFalse,
        reason: 'Flutter --split-per-abi must own the ABI split configuration.',
      );
      expect(buildFile, contains('versionCode = baseVersionCode'));
      expect(buildFile, contains('output.versionCode.set(baseVersionCode)'));
    });

    test('supports a protected release signing identity', () {
      final buildFile = File('android/app/build.gradle.kts').readAsStringSync();

      expect(buildFile, contains('STAY_SERVE_RELEASE_STORE_FILE'));
      expect(buildFile, contains('STAY_SERVE_RELEASE_STORE_PASSWORD'));
      expect(buildFile, contains('STAY_SERVE_RELEASE_KEY_ALIAS'));
      expect(buildFile, contains('STAY_SERVE_RELEASE_KEY_PASSWORD'));
      expect(buildFile, contains('signingConfigs.findByName("release")'));
    });

    test('rejects a partial release signing configuration', () {
      final buildFile = File('android/app/build.gradle.kts').readAsStringSync();

      expect(
        buildFile,
        contains(
          'configuredReleaseSigningNames.isNotEmpty() && !hasReleaseSigning',
        ),
      );
      expect(buildFile, contains('throw GradleException('));
      expect(buildFile, contains('Missing or blank:'));
      expect(buildFile, contains('debug signing fallback.'));
    });

    test('uses a repository-relative split APK in the build verifier', () {
      final verifier = File('tools/verify_build.mjs').readAsStringSync();

      expect(verifier, isNot(contains('/Users/')));
      expect(verifier, contains('fileURLToPath(import.meta.url)'));
      expect(verifier, contains('app-arm64-v8a-release.apk'));
      expect(verifier, contains('resolve(process.cwd(), process.argv[2])'));
    });

    test('uses matching Android Firebase package configuration', () {
      final buildFile = File('android/app/build.gradle.kts').readAsStringSync();
      final googleServices =
          jsonDecode(
                File('android/app/google-services.json').readAsStringSync(),
              )
              as Map<String, dynamic>;

      final applicationId = RegExp(
        r'applicationId\s*=\s*"([^"]+)"',
      ).firstMatch(buildFile)?.group(1);
      expect(applicationId, isNotNull);

      final clients = (googleServices['client'] as List<dynamic>)
          .cast<Map<String, dynamic>>();
      final matchingClients = clients.where((client) {
        final clientInfo = Map<String, dynamic>.from(
          client['client_info'] as Map<dynamic, dynamic>,
        );
        final androidClientInfo = Map<String, dynamic>.from(
          clientInfo['android_client_info'] as Map<dynamic, dynamic>,
        );
        return androidClientInfo['package_name'] == applicationId;
      }).toList();
      expect(matchingClients, isNotEmpty);

      final client = matchingClients.first;
      final oauthClients = (client['oauth_client'] as List<dynamic>)
          .cast<Map<String, dynamic>>();
      final matchingAndroidOauthClients = oauthClients.where((oauthClient) {
        if (oauthClient['client_type'] != 1) return false;
        final androidInfo = Map<String, dynamic>.from(
          oauthClient['android_info'] as Map<dynamic, dynamic>,
        );
        return androidInfo['package_name'] == applicationId;
      }).toList();
      expect(matchingAndroidOauthClients, isNotEmpty);
    });

    test('CI builds split APKs and runs both size checks', () {
      final workflow = File('.github/workflows/ci.yml').readAsStringSync();

      expect(workflow, contains('flutter build apk --release --split-per-abi'));
      expect(
        workflow,
        contains('dart run tools/check_android_bundle_size.dart'),
      );
      expect(workflow, contains('every distributable'));
    });
  });
}
