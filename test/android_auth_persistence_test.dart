import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Android Firebase Auth session persistence', () {
    test('uses the Firebase Auth version without the broken Keystore store', () {
      final buildFile = File('android/app/build.gradle.kts').readAsStringSync();

      expect(
        buildFile,
        contains(
          'resolutionStrategy.force("com.google.firebase:firebase-auth:23.1.0")',
        ),
      );
    });

    test('does not restore an unreadable Firebase Auth backup', () {
      final manifest = File(
        'android/app/src/main/AndroidManifest.xml',
      ).readAsStringSync();

      expect(
        RegExp(r'android:allowBackup\s*=\s*"false"').hasMatch(manifest),
        isTrue,
      );
    });

    test('keeps the native Google OAuth Custom Tab task affinity valid', () {
      final manifest = File(
        'android/app/src/main/AndroidManifest.xml',
      ).readAsStringSync();

      // Firebase Auth's native provider flow returns through a Chrome Custom
      // Tab. Flutter's old empty affinity makes that return fail with
      // `web-context-already-presented` on Android.
      expect(
        RegExp(r'android:taskAffinity\s*=\s*""').hasMatch(manifest),
        isFalse,
      );
    });
  });
}
