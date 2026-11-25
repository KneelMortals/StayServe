import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/routing/app_router.dart';
import 'package:stayserve/core/utils/validators.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/firebase/functions/functions_service.dart';
import 'package:stayserve/firebase/messaging/messaging_service.dart';
import 'package:stayserve/firebase/otp/otp_service.dart';
import 'package:stayserve/models/user_model.dart';

import 'support/auth_identity_fakes.dart';

class _FakeFirebaseMessaging implements FirebaseMessaging {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Firebase Messaging is not used by this test');
}

class _RecordingFirestore implements FirebaseFirestore {
  _RecordingFirestore(this.document);

  final _RecordingDocumentReference document;

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) {
    return _RecordingCollectionReference(document);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Unexpected Firestore call: $invocation');
}

// ignore: subtype_of_sealed_class
class _RecordingCollectionReference
    implements CollectionReference<Map<String, dynamic>> {
  _RecordingCollectionReference(this.document);

  final _RecordingDocumentReference document;

  @override
  DocumentReference<Map<String, dynamic>> doc([String? path]) => document;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Unexpected collection call: $invocation');
}

// ignore: subtype_of_sealed_class, must_be_immutable
class _RecordingDocumentReference
    implements DocumentReference<Map<String, dynamic>> {
  bool updateCalled = false;
  bool setCalled = false;
  int updateCalls = 0;
  Map<Object, Object?>? updateData;
  Object? updateError;
  final List<Object> updateErrors = <Object>[];

  @override
  Future<void> update(Map<Object, Object?> data) async {
    updateCalled = true;
    updateCalls++;
    updateData = Map<Object, Object?>.from(data);
    final error = updateErrors.isNotEmpty
        ? updateErrors.removeAt(0)
        : updateError;
    if (error != null) throw error;
  }

  @override
  Future<void> set(Map<String, dynamic> data, [SetOptions? options]) async {
    setCalled = true;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Unexpected document call: $invocation');
}

class _SessionAuthRepository implements AuthRepository {
  _SessionAuthRepository({this.firstRefreshGate, this.events});

  final StreamController<User?> authEvents =
      StreamController<User?>.broadcast();
  final Completer<void> refreshStarted = Completer<void>();

  User? activeUser;
  Completer<void>? firstRefreshGate;
  final List<String>? events;
  Object? syncError;
  int refreshCalls = 0;
  int syncCalls = 0;

  @override
  Stream<User?> get authStateChanges => authEvents.stream;

  @override
  User? get currentUser => activeUser;

  void emit(User? user) {
    activeUser = user;
    authEvents.add(user);
  }

  @override
  Future<void> refreshIdToken() async {
    refreshCalls++;
    if (!refreshStarted.isCompleted) refreshStarted.complete();
    if (refreshCalls == 1 && firstRefreshGate != null) {
      await firstRefreshGate!.future;
    }
  }

  @override
  Future<Map<String, dynamic>> syncAuthProfile() async {
    syncCalls++;
    events?.add('syncAuthProfile');
    final error = syncError;
    if (error != null) throw error;
    return <String, dynamic>{'success': true};
  }

  @override
  Future<void> signOut() async {
    activeUser = null;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _RecordingRegistrar extends PushNotificationRegistrar {
  _RecordingRegistrar({this.events}) : super(_ControlledMessagingService());

  final List<String>? events;
  final List<String> registeredUids = <String>[];
  final List<String> unregisteredUids = <String>[];

  @override
  Future<void> register(String uid) async {
    registeredUids.add(uid);
    events?.add('register:$uid');
  }

  @override
  Future<void> unregister(String uid) async {
    unregisteredUids.add(uid);
  }
}

class _ControlledMessagingService extends MessagingService {
  _ControlledMessagingService({this.onRemoved})
    : super(
        messaging: _FakeFirebaseMessaging(),
        firestore: _RecordingFirestore(_RecordingDocumentReference()),
      );

  final void Function(String uid)? onRemoved;
  final Completer<String?> token = Completer<String?>();
  final StreamController<String> refreshes =
      StreamController<String>.broadcast();
  final List<String> savedUids = <String>[];
  final List<String> removedUids = <String>[];
  final Map<String, String?> storedTokens = <String, String?>{};
  final List<Object> removalErrors = <Object>[];

  @override
  Future<void> requestPermission() async {}

  @override
  Future<String?> getToken() => token.future;

  @override
  Future<String?> readToken(String uid) async => storedTokens[uid];

  @override
  Future<bool> trySaveTokenToUser(String uid, String token) async {
    savedUids.add(uid);
    storedTokens[uid] = token;
    return true;
  }

  @override
  Future<void> removeTokenFromUser(String uid) async {
    removedUids.add(uid);
    if (removalErrors.isNotEmpty) {
      throw removalErrors.removeAt(0);
    }
    storedTokens.remove(uid);
    onRemoved?.call(uid);
  }

  @override
  Stream<String> get onTokenRefresh => refreshes.stream;
}

// ignore: must_be_immutable
class _RecordingUser extends MockUser {
  _RecordingUser({required super.uid, required super.displayName});

  int displayNameUpdateCalls = 0;

  @override
  Future<void> updateDisplayName(String? value) {
    displayNameUpdateCalls++;
    return super.updateDisplayName(value);
  }
}

// ignore: must_be_immutable
class _ReloadingUser extends MockUser {
  _ReloadingUser(this.auth, this.replacement, {required super.uid});

  final MockFirebaseAuth auth;
  final MockUser replacement;

  @override
  Future<void> reload() async {
    // Native Firebase installs a new current User instance after reload.
    // The mock exposes the same behaviour through its `mockUser` setter.
    auth.mockUser = replacement;
  }
}

class _BlockingAuthRepository extends RecordingAuthRepository {
  _BlockingAuthRepository({super.currentUser});

  final Completer<void> started = Completer<void>();
  final Completer<void> release = Completer<void>();

  @override
  Future<Map<String, dynamic>> syncAuthProfile() async {
    calls.add('syncAuthProfile');
    if (!started.isCompleted) started.complete();
    await release.future;
    return <String, dynamic>{'success': true};
  }
}

class _OrderingAuthRepository extends RecordingAuthRepository {
  _OrderingAuthRepository({required super.currentUser, required this.events});

  final List<String> events;

  @override
  Future<void> signOut() async {
    events.add('authSignOut');
    await super.signOut();
  }
}

class _LostRegistrationResponseService extends OtpService {
  _LostRegistrationResponseService()
    : super(FunctionsService(IdentityFakeFirebaseFunctions()));

  int completionCalls = 0;

  @override
  Future<RegistrationResult> completeRegistration({
    required String name,
    required String role,
    required String challenge,
    String? phone,
    String? phoneChallenge,
    String? pincode,
  }) async {
    completionCalls++;
    if (completionCalls == 1) {
      throw Exception('the registration response was lost');
    }
    return const RegistrationResult(role: 'owner', phoneVerified: true);
  }
}

class _FailingRegistrationService extends OtpService {
  _FailingRegistrationService()
    : super(FunctionsService(IdentityFakeFirebaseFunctions()));

  int completionCalls = 0;

  @override
  Future<RegistrationResult> completeRegistration({
    required String name,
    required String role,
    required String challenge,
    String? phone,
    String? phoneChallenge,
    String? pincode,
  }) async {
    completionCalls++;
    throw Exception('the registration was refused');
  }
}

void main() {
  group('auth-session ownership', () {
    test('sign-out during token refresh prevents FCM registration', () async {
      final refreshGate = Completer<void>();
      final repository = _SessionAuthRepository(firstRefreshGate: refreshGate);
      final registrar = _RecordingRegistrar();
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          pushNotificationRegistrarProvider.overrideWithValue(registrar),
          userProfileStreamProvider.overrideWithValue(
            (_) => const Stream<UserModel?>.empty(),
          ),
        ],
      );
      final subscription = container.listen(authSessionProvider, (_, __) {});
      addTearDown(() async {
        subscription.close();
        container.dispose();
        registrar.dispose();
        await repository.authEvents.close();
      });

      repository.emit(MockUser(uid: 'user-a'));
      await repository.refreshStarted.future;

      repository.emit(null);
      await pumpEventQueue();
      refreshGate.complete();
      await pumpEventQueue();

      expect(registrar.registeredUids, isEmpty);
      expect(repository.syncCalls, 0);
    });

    test('account A cannot register after account B becomes current', () async {
      final refreshGate = Completer<void>();
      final repository = _SessionAuthRepository(firstRefreshGate: refreshGate);
      final registrar = _RecordingRegistrar();
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          pushNotificationRegistrarProvider.overrideWithValue(registrar),
          userProfileStreamProvider.overrideWithValue(
            (_) => const Stream<UserModel?>.empty(),
          ),
        ],
      );
      final subscription = container.listen(authSessionProvider, (_, __) {});
      addTearDown(() async {
        subscription.close();
        container.dispose();
        registrar.dispose();
        await repository.authEvents.close();
      });

      repository.emit(MockUser(uid: 'user-a'));
      await repository.refreshStarted.future;

      repository.emit(MockUser(uid: 'user-b'));
      await pumpEventQueue();
      refreshGate.complete();
      await pumpEventQueue();

      expect(registrar.registeredUids, ['user-b']);
      expect(registrar.unregisteredUids, contains('user-a'));
      expect(repository.syncCalls, 1);
    });

    test('a profile-sync failure does not block FCM registration', () async {
      final events = <String>[];
      final repository = _SessionAuthRepository(events: events)
        ..syncError = Exception('the profile sync failed');
      final registrar = _RecordingRegistrar(events: events);
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          pushNotificationRegistrarProvider.overrideWithValue(registrar),
          userProfileStreamProvider.overrideWithValue(
            (_) => const Stream<UserModel?>.empty(),
          ),
        ],
      );
      final subscription = container.listen(authSessionProvider, (_, __) {});
      addTearDown(() async {
        subscription.close();
        container.dispose();
        registrar.dispose();
        await repository.authEvents.close();
      });

      repository.emit(MockUser(uid: 'user-a'));
      await pumpEventQueue();

      expect(repository.syncCalls, 1);
      expect(registrar.registeredUids, ['user-a']);
      expect(events, ['syncAuthProfile', 'register:user-a']);
      expect(container.read(authSessionProvider).hasError, isFalse);
    });
  });

  group('FCM profile lifecycle', () {
    test('stores the token with update and never creates a profile', () async {
      final document = _RecordingDocumentReference();
      final service = MessagingService(
        messaging: _FakeFirebaseMessaging(),
        firestore: _RecordingFirestore(document),
      );

      await service.saveTokenToUser('user-1', 'device-token');

      expect(document.updateCalled, isTrue);
      expect(document.setCalled, isFalse);
      expect(document.updateData?['fcmToken'], 'device-token');
    });

    test(
      'a missing profile is a retryable race, not a client creation',
      () async {
        final document = _RecordingDocumentReference()
          ..updateError = FirebaseException(
            plugin: 'cloud_firestore',
            code: 'not-found',
          );
        final service = MessagingService(
          messaging: _FakeFirebaseMessaging(),
          firestore: _RecordingFirestore(document),
        );

        expect(
          await service.trySaveTokenToUser('user-1', 'device-token'),
          isFalse,
        );
        expect(document.updateCalled, isTrue);
        expect(document.setCalled, isFalse);
      },
    );

    test('a sign-out invalidates a pending token registration', () async {
      final messaging = _ControlledMessagingService();
      final registrar = PushNotificationRegistrar(messaging);
      addTearDown(registrar.dispose);
      addTearDown(messaging.refreshes.close);

      final registration = registrar.register('user-1');
      await Future<void>.delayed(Duration.zero);

      await registrar.unregister('user-1');
      messaging.token.complete('device-token');
      await registration;

      expect(messaging.savedUids, isEmpty);
      expect(messaging.removedUids, ['user-1']);
    });

    test(
      'sign-out removes the device token before ending the Auth session',
      () async {
        final events = <String>[];
        final messaging = _ControlledMessagingService(
          onRemoved: (uid) => events.add('fcmRemoval:$uid'),
        );
        final registrar = PushNotificationRegistrar(messaging);
        addTearDown(registrar.dispose);
        addTearDown(messaging.refreshes.close);

        final repository = _OrderingAuthRepository(
          currentUser: MockUser(uid: 'user-1'),
          events: events,
        );
        final container = ProviderContainer(
          overrides: [
            authRepositoryProvider.overrideWithValue(repository),
            pushNotificationRegistrarProvider.overrideWithValue(registrar),
          ],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await container.read(authControllerProvider.notifier).signOut();

        expect(events, ['fcmRemoval:user-1', 'authSignOut']);
        expect(repository.currentUser, isNull);
      },
    );

    test(
      'a transient removal failure is retried before sign-out and account replacement',
      () async {
        final events = <String>[];
        final messaging = _ControlledMessagingService(
          onRemoved: (uid) => events.add('fcmRemoval:$uid'),
        );
        final registrar = PushNotificationRegistrar(
          messaging,
          cleanupRetryDelays: const <Duration>[Duration.zero],
          delay: (_) async {},
        );
        addTearDown(registrar.dispose);
        addTearDown(messaging.refreshes.close);

        messaging.token.complete('device-token');
        await registrar.register('user-1');
        expect(messaging.storedTokens['user-1'], 'device-token');
        messaging.removalErrors.add(Exception('temporary Firestore failure'));

        final repository = _OrderingAuthRepository(
          currentUser: MockUser(uid: 'user-1'),
          events: events,
        );
        final container = ProviderContainer(
          overrides: [
            authRepositoryProvider.overrideWithValue(repository),
            pushNotificationRegistrarProvider.overrideWithValue(registrar),
          ],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await container.read(authControllerProvider.notifier).signOut();

        expect(messaging.removedUids, ['user-1', 'user-1']);
        expect(events, ['fcmRemoval:user-1', 'authSignOut']);
        expect(messaging.storedTokens.containsKey('user-1'), isFalse);

        await registrar.register('user-2');
        expect(messaging.storedTokens.containsKey('user-1'), isFalse);
        expect(messaging.storedTokens['user-2'], 'device-token');
      },
    );

    test('a final removal failure blocks Firebase Auth sign-out', () async {
      final events = <String>[];
      final messaging = _ControlledMessagingService(
        onRemoved: (uid) => events.add('fcmRemoval:$uid'),
      );
      final registrar = PushNotificationRegistrar(
        messaging,
        cleanupRetryDelays: const <Duration>[Duration.zero],
        delay: (_) async {},
      );
      addTearDown(registrar.dispose);
      addTearDown(messaging.refreshes.close);
      messaging.removalErrors.addAll(<Object>[
        Exception('first failure'),
        Exception('final failure'),
      ]);

      final repository = _OrderingAuthRepository(
        currentUser: MockUser(uid: 'user-1'),
        events: events,
      );
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          pushNotificationRegistrarProvider.overrideWithValue(registrar),
        ],
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);

      await container.read(authControllerProvider.notifier).signOut();

      expect(messaging.removedUids, ['user-1', 'user-1']);
      expect(events, isEmpty);
      expect(repository.currentUser, isNotNull);
      expect(
        container.read(authControllerProvider).error,
        isA<FcmTokenCleanupException>()
            .having((error) => error.uid, 'uid', 'user-1')
            .having((error) => error.attempts, 'attempts', 2),
      );
    });

    test('a final removal failure blocks a new-account registration', () async {
      final events = <String>[];
      final messaging = _ControlledMessagingService(
        onRemoved: (uid) => events.add('fcmRemoval:$uid'),
      );
      final registrar = PushNotificationRegistrar(
        messaging,
        cleanupRetryDelays: const <Duration>[Duration.zero],
        delay: (_) async {},
      );
      addTearDown(registrar.dispose);
      addTearDown(messaging.refreshes.close);

      messaging.token.complete('device-token');
      await registrar.register('user-1');
      messaging.removalErrors.addAll(<Object>[
        Exception('first failure'),
        Exception('final failure'),
      ]);

      final repository = _OrderingAuthRepository(
        currentUser: MockUser(uid: 'user-1'),
        events: events,
      );
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          pushNotificationRegistrarProvider.overrideWithValue(registrar),
        ],
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);

      final registration = await container
          .read(authControllerProvider.notifier)
          .signUp(
            email: 'student@example.test',
            password: 'password123',
            name: 'Student',
            role: UserRole.student,
            challenge: 'proof',
          );

      expect(registration, isNull);
      expect(repository.calls, isNot(contains('signUpEmail')));
      expect(repository.currentUser?.uid, 'user-1');
      expect(
        container.read(authControllerProvider).error,
        isA<FcmTokenCleanupException>(),
      );
    });

    test('a missing profile is a successful token cleanup', () async {
      final messaging = _ControlledMessagingService()
        ..removalErrors.add(
          FirebaseException(plugin: 'cloud_firestore', code: 'not-found'),
        );
      final registrar = PushNotificationRegistrar(
        messaging,
        cleanupRetryDelays: const <Duration>[Duration.zero],
        delay: (_) async {},
      );
      addTearDown(registrar.dispose);
      addTearDown(messaging.refreshes.close);

      await registrar.unregister('user-1');

      expect(messaging.removedUids, ['user-1']);
    });
  });

  group('profile identity lifecycle', () {
    test('removing a photo does not clear the Auth display name', () async {
      final user = _RecordingUser(uid: 'user-1', displayName: 'Asha');
      final auth = MockFirebaseAuth(signedIn: true, mockUser: user);
      final repository = AuthRepository(
        auth,
        IdentityFakeFirestore(),
        FunctionsService(IdentityFakeFirebaseFunctions()),
      );

      await repository.updateProfile(photoURL: '');

      expect(user.displayNameUpdateCalls, 0);
      expect(user.displayName, 'Asha');
      expect(user.photoURL, isEmpty);
    });

    test('Auth reload reads the instance replaced by Firebase', () async {
      final replacement = MockUser(
        uid: 'user-1',
        phoneNumber: '+919876543210',
        providerData: [
          TestProviderInfo(
            'google.com',
            uid: 'google-live',
            email: 'live@example.test',
          ),
        ],
      );
      final auth = MockFirebaseAuth();
      auth.mockUser = _ReloadingUser(auth, replacement, uid: 'user-1');
      await auth.signInWithCredential(null);
      final repository = AuthRepository(
        auth,
        IdentityFakeFirestore(),
        FunctionsService(IdentityFakeFirebaseFunctions()),
      );

      final liveUser = await repository.reloadCurrentUser();
      final identities = await repository.linkedGoogleProviderIdentities(
        refresh: true,
      );

      expect(liveUser, same(replacement));
      expect(liveUser?.phoneNumber, '+919876543210');
      expect(identities.map((identity) => identity.uid), ['google-live']);
    });

    test('a signed-out role-selection route goes to login', () {
      final redirect = resolveAuthRedirect(
        sessionAsync: const AsyncData<AuthSession?>(null),
        directUser: null,
        location: '/role-selection',
        signingOut: false,
      );

      expect(redirect, '/login');
    });

    test('email logs keep the address recognisable but not complete', () {
      final masked = AppHelpers.maskEmail('student@example.com');

      expect(masked, isNot('student@example.com'));
      expect(masked, startsWith('s'));
      expect(masked, endsWith('@example.com'));
      expect(AppHelpers.maskEmail('a@example.com'), '*@example.com');
      expect(AppHelpers.maskEmail('not-an-email'), '***');
    });
  });

  group('registration rollback boundary', () {
    test('a committed registration is reconciled and never deleted', () async {
      final repository = RecordingAuthRepository()
        ..rollbackResult = <String, dynamic>{
          'success': true,
          'rolledBack': false,
          'registrationCompleted': true,
        };
      final otp = _LostRegistrationResponseService();
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          otpServiceProvider.overrideWithValue(otp),
        ],
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);

      final registration = await container
          .read(authControllerProvider.notifier)
          .signUp(
            email: 'student@example.test',
            password: 'password123',
            name: 'Student',
            role: UserRole.student,
            challenge: 'proof',
          );

      expect(registration?.role, 'owner');
      expect(registration?.phoneVerified, isTrue);
      expect(otp.completionCalls, 2);
      expect(repository.rollbackUids, ['signup-user']);
      expect(repository.deleteAccountCalls, 0);
    });

    test(
      'an unknown rollback state fails closed without a direct delete',
      () async {
        final repository = RecordingAuthRepository()
          ..rollbackError = Exception('the rollback response was lost');
        final otp = _FailingRegistrationService();
        final container = ProviderContainer(
          overrides: [
            authRepositoryProvider.overrideWithValue(repository),
            otpServiceProvider.overrideWithValue(otp),
          ],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        final registration = await container
            .read(authControllerProvider.notifier)
            .signUp(
              email: 'student@example.test',
              password: 'password123',
              name: 'Student',
              role: UserRole.student,
              challenge: 'proof',
            );

        expect(registration, isNull);
        expect(container.read(authControllerProvider).hasError, isTrue);
        expect(repository.rollbackUids, ['signup-user']);
        expect(repository.deleteAccountCalls, 0);
      },
    );

    test('a display-name failure also rolls the new account back', () async {
      final repository = RecordingAuthRepository()
        ..updateProfileError = Exception('the display name was refused');
      final otp = _FailingRegistrationService();
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          otpServiceProvider.overrideWithValue(otp),
        ],
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);

      final registration = await container
          .read(authControllerProvider.notifier)
          .signUp(
            email: 'student@example.test',
            password: 'password123',
            name: 'Student',
            role: UserRole.student,
            challenge: 'proof',
          );

      expect(registration, isNull);
      expect(otp.completionCalls, 0);
      expect(repository.rollbackUids, ['signup-user']);
      expect(repository.deleteAccountCalls, 0);
    });
  });

  group('concurrent profile mutations', () {
    test('a failure belongs only to its own operation', () async {
      final repository = _BlockingAuthRepository(
        currentUser: MockUser(uid: 'user-1'),
      )..linkVerifiedEmailError = Exception('the link was refused');
      final container = ProviderContainer(
        overrides: [authRepositoryProvider.overrideWithValue(repository)],
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);

      final successful = container
          .read(authControllerProvider.notifier)
          .syncAuthProfile();
      await repository.started.future;

      final failed = container
          .read(authControllerProvider.notifier)
          .linkVerifiedEmail(email: 'later@example.test', challenge: 'proof');

      expect(container.read(profileMutationBusyProvider), isTrue);
      await expectLater(
        failed,
        throwsA(
          isA<ProfileOperationException>().having(
            (error) => error.mutationOperation,
            'mutationOperation',
            ProfileMutationOperation.linkVerifiedEmail,
          ),
        ),
      );
      expect(container.read(authControllerProvider).hasError, isFalse);

      repository.release.complete();
      await successful;
      expect(container.read(profileMutationBusyProvider), isFalse);
    });
  });
}
