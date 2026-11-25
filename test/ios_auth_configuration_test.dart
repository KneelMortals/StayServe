import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('iOS Firebase Auth configuration', () {
    test('registers the Google OAuth callback URL scheme', () {
      final googleServices = File(
        'ios/Runner/GoogleService-Info.plist',
      ).readAsStringSync();
      final infoPlist = File('ios/Runner/Info.plist').readAsStringSync();

      final reversedClientIdMatch = RegExp(
        r'<key>REVERSED_CLIENT_ID</key>\s*<string>([^<]+)</string>',
      ).firstMatch(googleServices);
      expect(reversedClientIdMatch, isNotNull);

      final reversedClientId = reversedClientIdMatch!.group(1)!;
      expect(reversedClientId, isNotEmpty);
      expect(
        infoPlist.contains('<key>CFBundleURLTypes</key>'),
        isTrue,
        reason: 'Firebase native Google sign-in needs a callback URL scheme.',
      );
      expect(
        infoPlist.contains('<string>$reversedClientId</string>'),
        isTrue,
        reason: 'The callback URL scheme must match REVERSED_CLIENT_ID.',
      );
    });
  });

  group('iOS push notification configuration', () {
    test('requests the APNs environment through Runner entitlements', () {
      final entitlements = File(
        'ios/Runner/Runner.entitlements',
      ).readAsStringSync();

      expect(
        RegExp(
          r'<key>aps-environment</key>\s*'
          r'<string>\$\(APS_ENVIRONMENT\)</string>',
        ).hasMatch(entitlements),
        isTrue,
      );
    });

    test(
      'enables remote notifications without an unused background fetch mode',
      () {
        final infoPlist = File('ios/Runner/Info.plist').readAsStringSync();
        final backgroundModes = RegExp(
          r'<key>UIBackgroundModes</key>\s*<array>(.*?)</array>',
          dotAll: true,
        ).firstMatch(infoPlist);

        expect(backgroundModes, isNotNull);
        expect(
          backgroundModes!.group(1),
          contains('<string>remote-notification</string>'),
        );
        expect(
          backgroundModes.group(1),
          isNot(contains('<string>fetch</string>')),
        );
      },
    );

    test('configures the entitlements for every Runner configuration', () {
      final project = File(
        'ios/Runner.xcodeproj/project.pbxproj',
      ).readAsStringSync();

      expect(
        RegExp(
          r'CODE_SIGN_ENTITLEMENTS\s*=\s*Runner/Runner\.entitlements;',
        ).allMatches(project),
        hasLength(3),
      );
      expect(
        RegExp(r'APS_ENVIRONMENT\s*=\s*development;').allMatches(project),
        hasLength(1),
      );
      expect(
        RegExp(r'APS_ENVIRONMENT\s*=\s*production;').allMatches(project),
        hasLength(2),
      );
    });

    test('enables Push Notifications and Background Modes capabilities', () {
      final project = File(
        'ios/Runner.xcodeproj/project.pbxproj',
      ).readAsStringSync();

      expect(
        RegExp(
          r'com\.apple\.Push\s*=\s*\{\s*enabled\s*=\s*1;\s*\};',
        ).hasMatch(project),
        isTrue,
      );
      expect(
        RegExp(
          r'com\.apple\.BackgroundModes\s*=\s*\{\s*enabled\s*=\s*1;\s*\};',
        ).hasMatch(project),
        isTrue,
      );
    });
  });
}
