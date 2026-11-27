import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/profile/presentation/screens/edit_profile_screen.dart';
import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/firebase/functions/functions_service.dart';
import 'package:stayserve/firebase/messaging/messaging_service.dart';
import 'package:stayserve/models/user_model.dart';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/// An auth repository which remembers whether the session was ended.
class _ControllableAuthRepository implements AuthRepository {
  _ControllableAuthRepository(this.authStateChanges, {this.user});

  @override
  final Stream<User?> authStateChanges;

  /// The account which is signed in on this device.
  final User? user;

  /// The accounts whose session was ended.
  final List<String> signedOutUids = [];

  @override
  User? get currentUser => user;

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
  Future<void> signOut() async {
    final uid = user?.uid;
    if (uid != null) signedOutUids.add(uid);
  }

  @override
  Future<void> sendPasswordResetEmail(String email) async {}

  @override
  Future<void> updateProfile({
    String? displayName,
    String? photoURL,
    bool removePhotoURL = false,
  }) async {}

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

/// A functions service which records the calls and answers them from a map.
class _RecordingFunctionsService extends FunctionsService {
  _RecordingFunctionsService(this.responses) : super(_FakeFirebaseFunctions());

  final Map<String, Map<String, dynamic>> responses;

  /// Every callable call, in the order in which it happened.
  final List<({String name, Map<String, dynamic>? parameters})> calls = [];

  @override
  Future<Map<String, dynamic>> callFunctionData(
    String name, {
    Map<String, dynamic>? parameters,
  }) async {
    calls.add((name: name, parameters: parameters));
    return responses[name] ?? <String, dynamic>{};
  }
}

class _FakeFirebaseFunctions implements FirebaseFunctions {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Functions are not available in the test');
}

/// A user which remembers every change of the name and of the picture.
///
/// The mock of the Firebase Auth returns a placeholder address for a user
/// without a picture, so a test which checks the removal of a picture has
/// to look at the calls and not at the address.
class _RecordingUser implements User {
  _RecordingUser({required this.uid, this.email, this.photoURL});

  @override
  final String uid;

  @override
  final String? email;

  @override
  String? displayName;

  @override
  String? photoURL;

  final List<String?> photoUpdates = [];
  final List<String?> nameUpdates = [];

  @override
  Future<void> updatePhotoURL(String? value) async {
    photoUpdates.add(value);
    photoURL = value;
  }

  @override
  Future<void> updateDisplayName(String? value) async {
    nameUpdates.add(value);
    displayName = value;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// A Firebase Auth which hands out one prepared user.
class _AuthWithUser implements FirebaseAuth {
  _AuthWithUser(this.user);

  final User user;

  @override
  User? get currentUser => user;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

UserModel _profile(
  String uid, {
  bool isActive = true,
  UserRole role = UserRole.student,
}) {
  final now = DateTime.utc(2026, 1, 1);
  return UserModel(
    uid: uid,
    name: 'Test User',
    email: '$uid@example.com',
    role: role,
    isActive: isActive,
    createdAt: now,
    updatedAt: now,
  );
}

void main() {
  group('the session of a deleted account', () {
    test('a disabled profile ends the session', () async {
      final authEvents = StreamController<User?>.broadcast();
      final profile = StreamController<UserModel?>.broadcast();
      final user = MockUser(uid: 'user-1', email: 'user-1@example.com');
      final repository = _ControllableAuthRepository(
        authEvents.stream,
        user: user,
      );

      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
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

      final subscription = container.listen(
        authSessionProvider,
        (previous, next) {},
        fireImmediately: true,
      );
      addTearDown(subscription.close);

      authEvents.add(user);
      await pumpEventQueue();
      profile.add(_profile(user.uid));
      await pumpEventQueue();

      expect(repository.signedOutUids, isEmpty);

      // The server disables the account when the deletion starts (and when
      // an administrator bans it). The session has to end right away.
      profile.add(_profile(user.uid, isActive: false));
      await pumpEventQueue();

      expect(repository.signedOutUids, [user.uid]);
    });

    test('a profile which disappears ends the session', () async {
      final authEvents = StreamController<User?>.broadcast();
      final profile = StreamController<UserModel?>.broadcast();
      final user = MockUser(uid: 'user-2', email: 'user-2@example.com');
      final repository = _ControllableAuthRepository(
        authEvents.stream,
        user: user,
      );

      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
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

      final subscription = container.listen(
        authSessionProvider,
        (previous, next) {},
        fireImmediately: true,
      );
      addTearDown(subscription.close);

      authEvents.add(user);
      await pumpEventQueue();
      profile.add(_profile(user.uid));
      await pumpEventQueue();

      expect(repository.signedOutUids, isEmpty);

      // The profile document is gone: the account was deleted on the server.
      profile.add(null);
      await pumpEventQueue();

      expect(repository.signedOutUids, [user.uid]);
    });

    test('a brand-new account without a profile keeps its session', () async {
      final authEvents = StreamController<User?>.broadcast();
      final profile = StreamController<UserModel?>.broadcast();
      final user = MockUser(uid: 'user-3', email: 'user-3@example.com');
      final repository = _ControllableAuthRepository(
        authEvents.stream,
        user: user,
      );

      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
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

      final subscription = container.listen(
        authSessionProvider,
        (previous, next) {},
        fireImmediately: true,
      );
      addTearDown(subscription.close);

      authEvents.add(user);
      await pumpEventQueue();

      // The profile of a new account is created by the Auth trigger a moment
      // after the sign-in. The app must **not** sign the user out while it
      // is still on its way.
      profile.add(null);
      await pumpEventQueue();

      expect(repository.signedOutUids, isEmpty);
    });
  });

  group('the profile picture', () {
    test('the picked photo is uploaded by the server', () async {
      final functions = _RecordingFunctionsService({
        'uploadProfilePicture': {
          'success': true,
          'url': 'https://example.test/profile-images/user-1/picture',
        },
      });
      final auth = MockFirebaseAuth(
        signedIn: true,
        mockUser: MockUser(uid: 'user-1', email: 'user-1@example.com'),
      );
      final repository = AuthRepository(auth, _FakeFirestore(), functions);

      final bytes = Uint8List.fromList([1, 2, 3, 4, 5]);
      final url = await repository.uploadProfilePicture(bytes);

      expect(url, 'https://example.test/profile-images/user-1/picture');
      expect(functions.calls, hasLength(1));
      expect(functions.calls.single.name, 'uploadProfilePicture');
      final parameters = functions.calls.single.parameters!;
      expect(parameters['data'], base64Encode(bytes));
      expect(parameters['uploadId'], isA<String>());
      expect(parameters['uploadId'] as String, isNotEmpty);
    });

    test('an empty photo is refused before the server is called', () async {
      final functions = _RecordingFunctionsService({});
      final auth = MockFirebaseAuth(
        signedIn: true,
        mockUser: MockUser(uid: 'user-1', email: 'user-1@example.com'),
      );
      final repository = AuthRepository(auth, _FakeFirestore(), functions);

      await expectLater(
        repository.uploadProfilePicture(Uint8List(0)),
        throwsA(isA<StateError>()),
      );
      expect(functions.calls, isEmpty);
    });

    test('a signed-out account cannot upload a picture', () async {
      final functions = _RecordingFunctionsService({});
      final auth = MockFirebaseAuth(signedIn: false);
      final repository = AuthRepository(auth, _FakeFirestore(), functions);

      await expectLater(
        repository.uploadProfilePicture(Uint8List.fromList([1])),
        throwsA(isA<StateError>()),
      );
      expect(functions.calls, isEmpty);
    });

    test('the picture is removed by the server', () async {
      final functions = _RecordingFunctionsService({
        'removeProfilePicture': {'success': true},
      });
      final auth = MockFirebaseAuth(
        signedIn: true,
        mockUser: MockUser(uid: 'user-1', email: 'user-1@example.com'),
      );
      final repository = AuthRepository(auth, _FakeFirestore(), functions);

      await repository.removeProfilePicture();

      expect(functions.calls, hasLength(1));
      expect(functions.calls.single.name, 'removeProfilePicture');
    });

    test(
      'the picture of the Auth record is removed with a null address',
      () async {
        // An empty address is not a valid URL and the Auth service refuses it
        // with `auth/invalid-photo-url`. Only a null address deletes the
        // picture.
        final functions = _RecordingFunctionsService({
          'removeProfilePicture': {'success': true},
        });
        final user = _RecordingUser(
          uid: 'user-1',
          email: 'user-1@example.com',
          photoURL: 'https://firebasestorage.googleapis.com/v0/b/demo/o/p.jpg',
        );
        final auth = _AuthWithUser(user);
        final repository = AuthRepository(auth, _FakeFirestore(), functions);

        await repository.updateProfile(removePhotoURL: true);

        expect(user.photoUpdates, hasLength(1));
        expect(user.photoUpdates.single, isNull);
        // The name of the account must not be touched by the removal.
        expect(user.nameUpdates, isEmpty);
      },
    );

    test(
      'the picture of the Auth record is written with its address',
      () async {
        final functions = _RecordingFunctionsService({});
        final user = _RecordingUser(uid: 'user-1', email: 'user-1@example.com');
        final auth = _AuthWithUser(user);
        final repository = AuthRepository(auth, _FakeFirestore(), functions);

        await repository.updateProfile(
          photoURL: 'https://firebasestorage.googleapis.com/v0/b/demo/o/p.jpg',
        );

        expect(
          user.photoURL,
          'https://firebasestorage.googleapis.com/v0/b/demo/o/p.jpg',
        );
        expect(user.nameUpdates, isEmpty);
      },
    );
  });

  group('the profile screen', () {
    testWidgets('the picture is picked from the gallery', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'user-1', email: 'user-1@example.com'),
            ),
            authSessionProvider.overrideWith(
              (ref) => Stream.value(
                AuthSession(
                  user: MockUser(uid: 'user-1', email: 'user-1@example.com'),
                  profile: _profile('user-1'),
                ),
              ),
            ),
          ],
          child: const MaterialApp(home: EditProfileScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // The gallery picker replaces the old URL text box: a picture which
      // was pasted by hand could not be stored in the trusted bucket.
      expect(find.text('Choose from gallery'), findsOneWidget);
      expect(find.text('Profile image URL (optional)'), findsNothing);
    });

    testWidgets('an existing picture can be replaced and removed', (
      tester,
    ) async {
      final profile = _profile('user-1').copyWith(
        profileImage: 'https://example.test/profile-images/user-1/picture',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'user-1', email: 'user-1@example.com'),
            ),
            authSessionProvider.overrideWith(
              (ref) => Stream.value(
                AuthSession(
                  user: MockUser(uid: 'user-1', email: 'user-1@example.com'),
                  profile: profile,
                ),
              ),
            ),
          ],
          child: const MaterialApp(home: EditProfileScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Change picture'), findsOneWidget);
      expect(find.byIcon(Icons.delete_outline), findsOneWidget);
    });
  });
}
