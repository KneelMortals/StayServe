import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/utils/validators.dart';
import 'package:stayserve/core/routing/app_router.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/auth/presentation/screens/phone_verification_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/role_selection_screen.dart';
import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/firebase/otp/otp_service.dart';
import 'package:stayserve/models/user_model.dart';

import 'support/auth_identity_fakes.dart';

PhoneAuthCredential _phoneCredential() {
  return PhoneAuthProvider.credential(
    verificationId: 'verification-id',
    smsCode: '123456',
  );
}

UserModel _profile({
  UserRole role = UserRole.student,
  bool registrationCompleted = true,
  bool phoneVerified = true,
  bool isActive = true,
  List<String> authProviders = const ['password'],
  String email = 'student@example.test',
}) {
  final now = DateTime.utc(2026, 1, 1);
  return UserModel(
    uid: 'user-1',
    name: 'Test User',
    email: email,
    phone: phoneVerified ? '+919876543210' : null,
    role: role,
    emailVerified: true,
    phoneVerified: phoneVerified,
    registrationCompleted: registrationCompleted,
    roleClaimed: registrationCompleted,
    authProviders: authProviders,
    isActive: isActive,
    createdAt: now,
    updatedAt: now,
  );
}

Future<String> _resolvedLocation({
  required String location,
  User? user,
  UserModel? profile,
  AuthProfileTransition? transition,
}) async {
  final container = ProviderContainer(
    overrides: [
      authSessionProvider.overrideWith(
        (ref) => Stream<AuthSession?>.value(
          user == null ? null : AuthSession(user: user, profile: profile),
        ),
      ),
      currentUserProvider.overrideWithValue(user),
    ],
  );
  addTearDown(container.dispose);

  await container.read(authSessionProvider.future);
  final redirect = resolveAuthRedirect(
    sessionAsync: container.read(authSessionProvider),
    directUser: user,
    location: Uri.parse(location).path,
    signingOut: false,
    transition: transition,
  );
  return redirect ?? location;
}

void main() {
  test('authentication logs mask the full email address', () {
    const email = 'student.full.name@example.test';
    final masked = AppHelpers.maskEmail(email);

    expect(masked, isNot(email));
    expect(masked, isNot(contains('student.full.name')));
    expect(masked, startsWith('s'));
    expect(masked, endsWith('@example.test'));
  });

  group('Firebase phone-number normalization', () {
    test('accepts Indian and explicitly international E.164 numbers', () {
      expect(normalizeFirebasePhoneNumber('9876543210'), '+919876543210');
      expect(
        normalizeFirebasePhoneNumber('+91 (98765) 432-10'),
        '+919876543210',
      );
      expect(normalizeFirebasePhoneNumber('0091 98765 43210'), '+919876543210');
      expect(normalizeFirebasePhoneNumber('919876543210'), '+919876543210');
      expect(normalizeFirebasePhoneNumber('+14155552671'), '+14155552671');
    });

    test('rejects malformed, ambiguous, and invalid mobile numbers', () {
      expect(normalizeFirebasePhoneNumber(''), isNull);
      expect(normalizeFirebasePhoneNumber('12345'), isNull);
      expect(normalizeFirebasePhoneNumber('1234567890123456'), isNull);
      expect(normalizeFirebasePhoneNumber('+019876543210'), isNull);
      expect(normalizeFirebasePhoneNumber('09876543210'), isNull);
      expect(normalizeFirebasePhoneNumber('1234567890'), isNull);
      expect(normalizeFirebasePhoneNumber('+911234567890'), isNull);
      expect(normalizeFirebasePhoneNumber('441234567890'), isNull);
    });
  });

  group('profile snapshot transitions', () {
    test(
      'a completed phone link does not bounce back to verification',
      () async {
        final user = MockUser(uid: 'user-1');
        final staleProfile = _profile(phoneVerified: false);

        expect(
          await _resolvedLocation(
            location: '/verify-phone',
            user: user,
            profile: staleProfile,
            transition: AuthProfileTransition(
              uid: user.uid,
              phoneVerified: true,
            ),
          ),
          '/student/home',
        );
      },
    );

    test(
      'a phone link without a server transition still fails closed',
      () async {
        final user = MockUser(uid: 'user-1');
        final staleProfile = _profile(phoneVerified: false);

        expect(
          await _resolvedLocation(
            location: '/verify-phone',
            user: user,
            profile: staleProfile,
          ),
          '/verify-phone',
        );
      },
    );

    test(
      'a completed role registration does not bounce to role selection',
      () async {
        final user = MockUser(uid: 'user-1');
        final staleProfile = _profile(
          role: UserRole.owner,
          registrationCompleted: false,
        );

        expect(
          await _resolvedLocation(
            location: '/owner/dashboard',
            user: user,
            profile: staleProfile,
            transition: AuthProfileTransition(
              uid: user.uid,
              registrationCompleted: true,
              role: UserRole.owner,
            ),
          ),
          '/owner/dashboard',
        );
        expect(
          await _resolvedLocation(
            location: '/owner/dashboard',
            user: user,
            profile: staleProfile,
          ),
          '/role-selection',
        );
      },
    );

    test(
      'a server-confirmed missing phone overrides a stale verified snapshot',
      () async {
        final user = MockUser(uid: 'user-1');
        final staleProfile = _profile(phoneVerified: true);

        expect(
          await _resolvedLocation(
            location: '/student/home',
            user: user,
            profile: staleProfile,
            transition: AuthProfileTransition(
              uid: user.uid,
              registrationCompleted: true,
              phoneVerified: false,
            ),
          ),
          '/verify-phone',
        );
      },
    );
  });

  testWidgets(
    'a phone-only role registration keeps the verified-phone transition',
    (tester) async {
      tester.view.physicalSize = const Size(1200, 1800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final repository = RecordingAuthRepository(
        currentUser: MockUser(uid: 'phone-user', phoneNumber: '+919876543210'),
      );
      final functions = RecordingFunctionsService(
        payloads: <String, dynamic>{
          'completeRegistration': <String, dynamic>{
            'success': true,
            'role': 'student',
            'phoneVerified': true,
          },
        },
      );
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          otpServiceProvider.overrideWithValue(OtpService(functions)),
        ],
      );
      addTearDown(container.dispose);

      final router = GoRouter(
        initialLocation: '/role-selection',
        routes: [
          GoRoute(
            path: '/role-selection',
            builder: (context, state) => const RoleSelectionScreen(),
          ),
          GoRoute(
            path: '/verify-phone',
            builder: (context, state) =>
                const Scaffold(body: Center(child: Text('Verify phone'))),
          ),
          GoRoute(
            path: '/student/home',
            builder: (context, state) =>
                const Scaffold(body: Center(child: Text('Student home'))),
          ),
        ],
      );
      addTearDown(router.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Student'));
      await tester.pump();
      await tester.tap(find.text('Continue'));
      await tester.pumpAndSettle();

      expect(
        container.read(authProfileTransitionProvider),
        const AuthProfileTransition(
          uid: 'phone-user',
          registrationCompleted: true,
          phoneVerified: true,
          role: UserRole.student,
        ),
      );
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/student/home',
      );
    },
  );

  group('AuthController identity operations', () {
    test(
      'email registration keeps the server-confirmed role and phone state',
      () async {
        final repository = RecordingAuthRepository();
        final functions = RecordingFunctionsService(
          payloads: <String, dynamic>{
            'completeRegistration': <String, dynamic>{
              'success': true,
              'role': 'owner',
              'phoneVerified': false,
            },
          },
        );
        final container = ProviderContainer(
          overrides: [
            authRepositoryProvider.overrideWithValue(repository),
            otpServiceProvider.overrideWithValue(OtpService(functions)),
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
        expect(registration?.phoneVerified, isFalse);
        expect(
          container.read(authProfileTransitionProvider),
          const AuthProfileTransition(
            uid: 'signup-user',
            registrationCompleted: true,
            phoneVerified: false,
            role: UserRole.owner,
          ),
        );
        expect(repository.calls, contains('signUpEmail'));
        expect(repository.calls, contains('refreshToken'));
      },
    );

    test('a failed registration uses the server rollback boundary', () async {
      final repository = RecordingAuthRepository();
      final functions = RecordingFunctionsService(
        errors: <String, Object>{
          'completeRegistration': Exception('registration was refused'),
        },
      );
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          otpServiceProvider.overrideWithValue(OtpService(functions)),
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
      expect(
        repository.calls,
        containsAllInOrder([
          'signUpEmail',
          'updateAuthProfile',
          'rollbackIncompleteRegistration',
          'signOut',
        ]),
      );
    });

    test(
      'a phone link is followed by exactly one profile synchronization',
      () async {
        final repository = RecordingAuthRepository(
          currentUser: MockUser(uid: 'user-1', phoneNumber: '+919876543210'),
        );
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await container
            .read(authControllerProvider.notifier)
            .linkPhoneCredential(
              _phoneCredential(),
              phoneNumber: '+919876543210',
            );

        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(repository.calls, ['linkPhone', 'syncAuthProfile']);
        expect(
          container.read(authProfileTransitionProvider),
          const AuthProfileTransition(uid: 'user-1', phoneVerified: true),
        );
      },
    );

    test(
      'a retry after a lost phone-link response still synchronizes the profile',
      () async {
        final repository =
            RecordingAuthRepository(
                currentUser: MockUser(
                  uid: 'user-1',
                  phoneNumber: '+919876543210',
                ),
              )
              ..linkPhoneError = FirebaseAuthException(
                code: 'provider-already-linked',
              );
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await container
            .read(authControllerProvider.notifier)
            .linkPhoneCredential(
              _phoneCredential(),
              phoneNumber: '+919876543210',
            );

        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(repository.calls, ['linkPhone', 'syncAuthProfile']);
      },
    );

    test(
      'a conflicting phone link does not synchronize another number',
      () async {
        final repository =
            RecordingAuthRepository(
                currentUser: MockUser(
                  uid: 'user-1',
                  phoneNumber: '+919876543210',
                ),
              )
              ..linkPhoneError = FirebaseAuthException(
                code: 'provider-already-linked',
              );
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await expectLater(
          () => container
              .read(authControllerProvider.notifier)
              .linkPhoneCredential(
                _phoneCredential(),
                phoneNumber: '+919876543211',
              ),
          throwsA(
            isA<ProfileOperationException>().having(
              (error) => error.mutationOperation,
              'mutationOperation',
              ProfileMutationOperation.linkPhone,
            ),
          ),
        );

        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(repository.calls, ['linkPhone']);
      },
    );

    test(
      'a Google link retry synchronizes only for the exact linked identity',
      () async {
        final repository =
            RecordingAuthRepository(
                currentUser: MockUser(
                  uid: 'user-1',
                  providerData: [
                    TestProviderInfo(
                      'google.com',
                      uid: 'google-a',
                      email: 'linked@example.test',
                    ),
                  ],
                ),
              )
              ..linkGoogleError = FirebaseAuthException(
                code: 'provider-already-linked',
                email: 'linked@example.test',
              );
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await container
            .read(authControllerProvider.notifier)
            .linkGoogleProvider();

        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(repository.calls, ['linkGoogle', 'syncAuthProfile']);
      },
    );

    test(
      'a native Google link which lost its response is recovered from Auth state',
      () async {
        final repository =
            RecordingAuthRepository(currentUser: MockUser(uid: 'user-1'))
              ..linkGoogleError = FirebaseAuthException(
                code: 'provider-already-linked',
              )
              ..googleProviderEmailsAfterFailedLink = {'linked@example.test'};
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await container
            .read(authControllerProvider.notifier)
            .linkGoogleProvider();

        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(repository.googleProviderReloads, 2);
        expect(repository.calls, ['linkGoogle', 'syncAuthProfile']);
      },
    );

    test(
      'an ambiguous pre-existing Google provider is not reported as success',
      () async {
        final repository =
            RecordingAuthRepository(
                currentUser: MockUser(
                  uid: 'user-1',
                  providerData: [
                    TestProviderInfo(
                      'google.com',
                      uid: 'google-a',
                      email: 'linked@example.test',
                    ),
                  ],
                ),
              )
              ..linkGoogleError = FirebaseAuthException(
                code: 'provider-already-linked',
              );
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await expectLater(
          () => container
              .read(authControllerProvider.notifier)
              .linkGoogleProvider(),
          throwsA(
            isA<ProfileOperationException>().having(
              (error) => error.mutationOperation,
              'mutationOperation',
              ProfileMutationOperation.linkGoogle,
            ),
          ),
        );

        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(repository.calls, ['linkGoogle']);
      },
    );

    test(
      'a failed link of a different Google identity is not reported as success',
      () async {
        final repository =
            RecordingAuthRepository(
                currentUser: MockUser(
                  uid: 'user-1',
                  providerData: [
                    TestProviderInfo(
                      'google.com',
                      uid: 'google-a',
                      email: 'linked@example.test',
                    ),
                  ],
                ),
              )
              ..linkGoogleError = FirebaseAuthException(
                code: 'provider-already-linked',
                email: 'other@example.test',
              );
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await expectLater(
          () => container
              .read(authControllerProvider.notifier)
              .linkGoogleProvider(),
          throwsA(
            isA<ProfileOperationException>().having(
              (error) => error.mutationOperation,
              'mutationOperation',
              ProfileMutationOperation.linkGoogle,
            ),
          ),
        );

        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(repository.calls, ['linkGoogle']);
      },
    );

    test(
      'a Google identity owned by another account is not synchronized',
      () async {
        final repository =
            RecordingAuthRepository(
                currentUser: MockUser(
                  uid: 'user-1',
                  providerData: [
                    TestProviderInfo(
                      'google.com',
                      uid: 'google-a',
                      email: 'linked@example.test',
                    ),
                  ],
                ),
              )
              ..linkGoogleError = FirebaseAuthException(
                code: 'credential-already-in-use',
                email: 'other@example.test',
              );
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await expectLater(
          () => container
              .read(authControllerProvider.notifier)
              .linkGoogleProvider(),
          throwsA(
            isA<ProfileOperationException>().having(
              (error) => error.mutationOperation,
              'mutationOperation',
              ProfileMutationOperation.linkGoogle,
            ),
          ),
        );

        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(repository.calls, ['linkGoogle']);
      },
    );

    test('verified-email linking is one server operation, not two', () async {
      final repository = RecordingAuthRepository(
        currentUser: MockUser(uid: 'user-1'),
      );
      final container = ProviderContainer(
        overrides: [authRepositoryProvider.overrideWithValue(repository)],
      );
      addTearDown(container.dispose);
      await container.read(authControllerProvider.future);

      await container
          .read(authControllerProvider.notifier)
          .linkVerifiedEmail(email: 'later@example.test', challenge: 'proof');

      expect(container.read(authControllerProvider).hasError, isFalse);
      expect(repository.calls, ['linkVerifiedEmail']);
    });

    test(
      'a failed verified-email link remains an authentication error',
      () async {
        final repository = RecordingAuthRepository(
          currentUser: MockUser(uid: 'user-1'),
        )..linkVerifiedEmailError = Exception('the server refused the link');
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await expectLater(
          () => container
              .read(authControllerProvider.notifier)
              .linkVerifiedEmail(
                email: 'later@example.test',
                challenge: 'proof',
              ),
          throwsA(
            isA<ProfileOperationException>().having(
              (error) => error.mutationOperation,
              'mutationOperation',
              ProfileMutationOperation.linkVerifiedEmail,
            ),
          ),
        );

        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(repository.calls, ['linkVerifiedEmail']);
      },
    );

    test(
      'concurrent profile operations keep separate success and failure results',
      () async {
        final started = Completer<void>();
        final release = Completer<void>();
        final repository =
            RecordingAuthRepository(currentUser: MockUser(uid: 'user-1'))
              ..linkVerifiedEmailAction = () async {
                started.complete();
                await release.future;
                throw Exception('the email link failed');
              };
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        final failedLink = container
            .read(authControllerProvider.notifier)
            .linkVerifiedEmail(email: 'later@example.test', challenge: 'proof');
        final failure = expectLater(
          failedLink,
          throwsA(
            isA<ProfileOperationException>().having(
              (error) => error.mutationOperation,
              'mutationOperation',
              ProfileMutationOperation.linkVerifiedEmail,
            ),
          ),
        );
        await started.future;

        await container.read(authControllerProvider.notifier).syncAuthProfile();
        expect(container.read(profileMutationBusyProvider), isTrue);
        expect(container.read(authControllerProvider).hasError, isFalse);

        release.complete();
        await failure;
        expect(container.read(profileMutationBusyProvider), isFalse);
        expect(container.read(authControllerProvider).hasError, isFalse);
        expect(repository.calls, ['linkVerifiedEmail', 'syncAuthProfile']);
      },
    );

    test(
      'a disabled phone account is signed out after authentication',
      () async {
        final repository = RecordingAuthRepository(
          currentUser: MockUser(uid: 'user-1', phoneNumber: '+919876543210'),
          profile: _profile(isActive: false),
        );
        final container = ProviderContainer(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
        );
        addTearDown(container.dispose);
        await container.read(authControllerProvider.future);

        await container
            .read(authControllerProvider.notifier)
            .signInWithPhoneCredential(_phoneCredential());

        expect(container.read(authControllerProvider).hasError, isTrue);
        expect(repository.calls, contains('signOut'));
      },
    );
  });

  test(
    'removing a profile photo does not clear the Auth display name',
    () async {
      final mockUser = MockUser(uid: 'user-1', displayName: 'Original Name');
      final firebaseAuth = MockFirebaseAuth(mockUser: mockUser, signedIn: true);
      final repository = AuthRepository(
        firebaseAuth,
        IdentityFakeFirestore(),
        RecordingFunctionsService(),
      );

      await repository.updateProfile(photoURL: '');

      expect(mockUser.displayName, 'Original Name');
      expect(mockUser.photoURL, '');
    },
  );

  group('profile identity model', () {
    test('parses server-owned verification and provider fields', () {
      final profile = UserModel.fromJson({
        'uid': 'user-1',
        'name': 'Test User',
        'email': 'verified@example.test',
        'phone': '+919876543210',
        'role': 'owner',
        'emailVerified': true,
        'phoneVerified': true,
        'registrationCompleted': true,
        'roleClaimed': true,
        'authProviders': ['google.com', 'phone'],
        'isActive': true,
        'createdAt': DateTime.utc(2026, 1, 1),
        'updatedAt': DateTime.utc(2026, 1, 1),
      });

      expect(profile.emailVerified, isTrue);
      expect(profile.phoneVerified, isTrue);
      expect(profile.registrationCompleted, isTrue);
      expect(profile.roleClaimed, isTrue);
      expect(profile.authProviders, ['google.com', 'phone']);
      expect(profile.canUseServices, isTrue);
    });

    test('fails closed when the registration marker is missing', () {
      final profile = UserModel.fromJson({
        'uid': 'user-1',
        'name': 'Test User',
        'email': 'legacy@example.test',
        'role': 'student',
        'phoneVerified': true,
        'createdAt': DateTime.utc(2026, 1, 1),
        'updatedAt': DateTime.utc(2026, 1, 1),
      });

      expect(profile.registrationCompleted, isFalse);
      expect(profile.canUseServices, isFalse);
    });

    test(
      'exempts only a live, registered administrator from the phone gate',
      () {
        expect(
          _profile(role: UserRole.admin, phoneVerified: false).canUseServices,
          isTrue,
        );
        expect(
          _profile(role: UserRole.student, phoneVerified: false).canUseServices,
          isFalse,
        );
        expect(
          _profile(
            role: UserRole.owner,
            phoneVerified: false,
            registrationCompleted: false,
          ).canUseServices,
          isFalse,
        );
        expect(
          _profile(
            role: UserRole.admin,
            phoneVerified: false,
            isActive: false,
          ).canUseServices,
          isFalse,
        );
      },
    );
  });

  group('authentication router gates', () {
    test(
      'a signed-in user without a profile is sent to role selection',
      () async {
        final user = MockUser(uid: 'user-1');
        expect(
          await _resolvedLocation(location: '/student/home', user: user),
          '/role-selection',
        );
      },
    );

    test('an incomplete registration is sent to role selection', () async {
      final user = MockUser(uid: 'user-1');
      expect(
        await _resolvedLocation(
          location: '/student/home',
          user: user,
          profile: _profile(registrationCompleted: false),
        ),
        '/role-selection',
      );
    });

    test(
      'role selection does not redirect an incomplete profile to itself',
      () async {
        final user = MockUser(uid: 'user-1');
        expect(
          await _resolvedLocation(
            location: '/role-selection',
            user: user,
            profile: _profile(registrationCompleted: false),
          ),
          '/role-selection',
        );
      },
    );

    test(
      'an unverified student and owner are sent to phone verification',
      () async {
        final student = MockUser(uid: 'student-1');
        expect(
          await _resolvedLocation(
            location: '/student/home',
            user: student,
            profile: _profile(phoneVerified: false),
          ),
          '/verify-phone',
        );

        final owner = MockUser(uid: 'owner-1');
        expect(
          await _resolvedLocation(
            location: '/owner/dashboard',
            user: owner,
            profile: _profile(role: UserRole.owner, phoneVerified: false),
          ),
          '/verify-phone',
        );
      },
    );

    test('an auth route cannot bypass the phone service gate', () async {
      final user = MockUser(uid: 'student-1');
      expect(
        await _resolvedLocation(
          location: '/register',
          user: user,
          profile: _profile(phoneVerified: false),
        ),
        '/verify-phone',
      );
      expect(
        await _resolvedLocation(
          location: '/role-selection',
          user: user,
          profile: _profile(phoneVerified: false),
        ),
        '/verify-phone',
      );
    });

    test('verified students and owners reach their own dashboard', () async {
      final student = MockUser(uid: 'student-1');
      expect(
        await _resolvedLocation(
          location: '/student/home',
          user: student,
          profile: _profile(),
        ),
        '/student/home',
      );

      final owner = MockUser(uid: 'owner-1');
      expect(
        await _resolvedLocation(
          location: '/owner/dashboard',
          user: owner,
          profile: _profile(role: UserRole.owner),
        ),
        '/owner/dashboard',
      );
    });

    test('an administrator does not need a verified phone', () async {
      final admin = MockUser(uid: 'admin-1');
      expect(
        await _resolvedLocation(
          location: '/admin/dashboard',
          user: admin,
          profile: _profile(role: UserRole.admin, phoneVerified: false),
        ),
        '/admin/dashboard',
      );
      expect(
        await _resolvedLocation(
          location: '/verify-phone',
          user: admin,
          profile: _profile(role: UserRole.admin, phoneVerified: false),
        ),
        '/admin/dashboard',
      );
    });

    test('a signed-in user may stay on the one-time-code route', () async {
      final user = MockUser(uid: 'user-1');
      final location = await _resolvedLocation(
        location: '/verify-otp?channel=email&identifier=student%40example.test',
        user: user,
        profile: _profile(),
      );
      expect(location, contains('/verify-otp'));
      expect(location, contains('channel=email'));
      expect(location, contains('identifier=student%40example.test'));
    });

    test('a signed-out user cannot open phone verification', () async {
      expect(await _resolvedLocation(location: '/verify-phone'), '/login');
    });

    test('a signed-out user cannot open role selection', () async {
      expect(await _resolvedLocation(location: '/role-selection'), '/login');
    });
  });

  group('phone verification screen', () {
    testWidgets('normalizes the number and verifies the Firebase credential', (
      tester,
    ) async {
      final repository = RecordingAuthRepository(
        currentUser: MockUser(uid: 'phone-user', phoneNumber: '+919876543210'),
      );
      final router = GoRouter(
        initialLocation: '/phone-auth',
        routes: [
          GoRoute(
            path: '/phone-auth',
            builder: (context, state) => const PhoneVerificationScreen(
              mode: PhoneVerificationMode.signIn,
            ),
          ),
          GoRoute(
            path: '/role-selection',
            builder: (context, state) =>
                const Scaffold(body: Center(child: Text('Role selection'))),
          ),
        ],
      );
      addTearDown(router.dispose);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      final phoneField = tester
          .widgetList<TextField>(find.byType(TextField))
          .firstWhere((field) => field.decoration?.labelText == 'Phone number');
      await tester.enterText(find.byWidget(phoneField), '9876543210');
      await tester.tap(find.text('Send SMS Code'));
      await tester.pumpAndSettle();

      expect(repository.startedPhoneNumber, '+919876543210');

      final codeField = tester
          .widgetList<TextField>(find.byType(TextField))
          .firstWhere((field) => field.decoration?.labelText == null);
      await tester.enterText(find.byWidget(codeField), '123456');
      await tester.tap(find.text('Verify Number'));
      await tester.pumpAndSettle();

      expect(repository.credentialVerificationId, 'verification-id');
      expect(repository.credentialSmsCode, '123456');
      expect(repository.calls, contains('signInWithPhone'));
      expect(find.text('Role selection'), findsOneWidget);
    });

    testWidgets('does not call Firebase for an invalid phone number', (
      tester,
    ) async {
      final repository = RecordingAuthRepository();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [authRepositoryProvider.overrideWithValue(repository)],
          child: const MaterialApp(
            home: PhoneVerificationScreen(mode: PhoneVerificationMode.signIn),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final phoneField = tester
          .widgetList<TextField>(find.byType(TextField))
          .firstWhere((field) => field.decoration?.labelText == 'Phone number');
      await tester.enterText(find.byWidget(phoneField), '12345');
      await tester.tap(find.text('Send SMS Code'));
      await tester.pumpAndSettle();

      expect(
        find.text('Use an international number, for example +919876543210'),
        findsOneWidget,
      );
      expect(repository.startedPhoneNumber, isNull);
      expect(repository.calls, isNot(contains('startPhoneVerification')));
    });
  });
}
