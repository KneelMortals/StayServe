import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/firebase/messaging/messaging_service.dart';
import 'package:stayserve/models/user_model.dart';

/// A controllable auth repository used by the session tests.
class _ControllableAuthRepository implements AuthRepository {
  _ControllableAuthRepository(this.authStateChanges);

  @override
  final Stream<User?> authStateChanges;

  @override
  User? get currentUser => null;

  @override
  Future<void> refreshIdToken() async {}

  @override
  Future<bool> refreshIdTokenAndCheckAccount() async => true;

  @override
  Future<UserCredential> signInWithEmailAndPassword({
    required String email,
    required String password,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<UserCredential> signUpWithEmailAndPassword({
    required String email,
    required String password,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<void> signOut() async {}

  @override
  Future<void> sendPasswordResetEmail(String email) async {}

  @override
  Future<void> updateProfile({String? displayName, String? photoURL}) async {}

  @override
  Future<void> createUserProfile(UserModel user) async {}

  @override
  Future<UserModel?> getUserProfile(String uid) async => null;

  @override
  Future<void> updateUserProfile(String uid, Map<String, dynamic> data) async {}

  @override
  Future<void> updateFCMToken(String uid, String token) async {}

  @override
  Future<void> deleteAccount() async {}

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeFirebaseMessaging implements FirebaseMessaging {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Firebase Messaging is not used by this test');
}

class _FakeFirestore implements FirebaseFirestore {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Firestore is not used by this test');
}

class _NoopRegistrar extends PushNotificationRegistrar {
  _NoopRegistrar()
    : super(
        MessagingService(
          messaging: _FakeFirebaseMessaging(),
          firestore: _FakeFirestore(),
        ),
      );

  @override
  Future<void> register(String uid) async {}

  @override
  Future<void> unregister(String uid) async {}
}

UserModel _profile(String uid, {UserRole role = UserRole.student}) {
  final now = DateTime.utc(2026, 1, 1);
  return UserModel(
    uid: uid,
    name: 'Test User',
    email: '$uid@example.com',
    role: role,
    createdAt: now,
    updatedAt: now,
  );
}

void main() {
  test(
    'logout followed by an immediate sign-in keeps the same session provider alive',
    () async {
      final authEvents = StreamController<User?>.broadcast();
      final firstProfile = StreamController<UserModel?>.broadcast();
      final secondProfile = StreamController<UserModel?>.broadcast();
      final profiles = <String, Stream<UserModel?>>{
        'first-user': firstProfile.stream,
        'second-user': secondProfile.stream,
      };

      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(
            _ControllableAuthRepository(authEvents.stream),
          ),
          userProfileStreamProvider.overrideWithValue(
            (uid) => profiles[uid] ?? const Stream<UserModel?>.empty(),
          ),
          // The token refresh and the FCM registration are not part of this
          // regression. They run behind the same callback in production.
          authSessionUserChangedProvider.overrideWithValue((_) async {}),
          pushNotificationRegistrarProvider.overrideWithValue(_NoopRegistrar()),
        ],
      );
      addTearDown(() async {
        container.dispose();
        await authEvents.close();
        await firstProfile.close();
        await secondProfile.close();
      });

      final observed = <AuthSession?>[];
      final subscription = container.listen(authSessionProvider, (
        previous,
        next,
      ) {
        if (next.hasValue) observed.add(next.value);
      }, fireImmediately: true);
      addTearDown(subscription.close);

      final firstUser = MockUser(
        uid: 'first-user',
        email: 'first-user@example.com',
      );

      authEvents.add(firstUser);
      await pumpEventQueue();
      firstProfile.add(_profile(firstUser.uid));
      await pumpEventQueue();

      expect(observed, hasLength(1));
      expect(observed.last?.user.uid, firstUser.uid);
      expect(observed.last?.profile?.uid, firstUser.uid);
      expect(firstProfile.hasListener, isTrue);

      // Signing out must be delivered even while the Firestore profile stream
      // is open. The old asyncExpand implementation waited for that stream to
      // finish and therefore never observed this event.
      authEvents.add(null);
      await pumpEventQueue();

      expect(observed, hasLength(2));
      expect(observed.last, isNull);
      expect(firstProfile.hasListener, isFalse);

      // The same provider instance must accept the next account immediately.
      // No provider is recreated and no container is replaced.
      final secondUser = MockUser(
        uid: 'second-user',
        email: 'second-user@example.com',
      );

      authEvents.add(secondUser);
      await pumpEventQueue();
      secondProfile.add(_profile(secondUser.uid, role: UserRole.owner));
      await pumpEventQueue();

      expect(observed, hasLength(3));
      expect(observed.last?.user.uid, secondUser.uid);
      expect(observed.last?.profile?.uid, secondUser.uid);
      expect(observed.last?.role, UserRole.owner);
      expect(secondProfile.hasListener, isTrue);
    },
  );

  test(
    'a profile read error does not stop logout and re-login events',
    () async {
      final authEvents = StreamController<User?>.broadcast();
      final profile = StreamController<UserModel?>.broadcast();
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(
            _ControllableAuthRepository(authEvents.stream),
          ),
          userProfileStreamProvider.overrideWithValue((_) => profile.stream),
          authSessionUserChangedProvider.overrideWithValue((_) async {}),
          pushNotificationRegistrarProvider.overrideWithValue(_NoopRegistrar()),
        ],
      );
      addTearDown(() async {
        container.dispose();
        await authEvents.close();
        await profile.close();
      });

      final observed = <AuthSession?>[];
      final subscription = container.listen(authSessionProvider, (
        previous,
        next,
      ) {
        if (next.hasValue) observed.add(next.value);
      }, fireImmediately: true);
      addTearDown(subscription.close);

      final user = MockUser(uid: 'user-1', email: 'user-1@example.com');
      authEvents.add(user);
      await pumpEventQueue();
      profile.add(_profile(user.uid));
      await pumpEventQueue();

      profile.addError(StateError('temporary profile read failure'));
      await pumpEventQueue();

      expect(container.read(authSessionProvider).hasError, isFalse);
      expect(observed.last?.user.uid, user.uid);

      authEvents.add(null);
      await pumpEventQueue();
      expect(observed.last, isNull);
    },
  );
}
