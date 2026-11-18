import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/firebase/auth/auth_service.dart';

/// Records the persistence mode requested from Firebase Auth.
class _RecordingFirebaseAuth implements FirebaseAuth {
  Persistence? requestedPersistence;

  @override
  Future<void> setPersistence(Persistence persistence) async {
    requestedPersistence = persistence;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('Firebase Auth persistence', () {
    test('the web build explicitly keeps the session on this device', () async {
      final auth = _RecordingFirebaseAuth();

      await configureAuthPersistence(auth, isWeb: true);

      expect(auth.requestedPersistence, Persistence.LOCAL);
    });

    test('native builds keep their default device persistence', () async {
      final auth = _RecordingFirebaseAuth();

      await configureAuthPersistence(auth, isWeb: false);

      // `setPersistence` is not supported by the native FlutterFire SDK.
      // Native Firebase Auth already persists the user locally, so it must
      // not be called there.
      expect(auth.requestedPersistence, isNull);
    });
  });
}
