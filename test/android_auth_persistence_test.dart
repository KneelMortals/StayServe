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
  });
}
