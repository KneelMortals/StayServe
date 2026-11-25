import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/auth/presentation/screens/otp_verification_screen.dart';
import 'package:stayserve/features/notifications/presentation/providers/pending_notification_route.dart';
import 'package:stayserve/features/profile/presentation/screens/edit_profile_screen.dart';
import 'package:stayserve/firebase/functions/functions_service.dart';
import 'package:stayserve/firebase/otp/otp_service.dart';
import 'package:stayserve/models/messaging_model.dart';
import 'package:stayserve/models/user_model.dart';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/// An OTP service that always says the code is wrong.
class _WrongOtpService extends OtpService {
  _WrongOtpService() : super(_FakeFunctionsService());

  @override
  Future<OtpSendResult> sendOtp({
    required OtpChannel channel,
    required String identifier,
  }) async {
    return const OtpSendResult(
      success: true,
      delivered: true,
      expiresInSeconds: 300,
      resendAfterSeconds: 30,
    );
  }

  @override
  Future<OtpVerifyResult> verifyOtp({
    required OtpChannel channel,
    required String identifier,
    required String otp,
  }) async {
    return const OtpVerifyResult(verified: false);
  }
}

/// An OTP service whose request fails.
class _FailingOtpService extends OtpService {
  _FailingOtpService() : super(_FakeFunctionsService());

  @override
  Future<OtpSendResult> sendOtp({
    required OtpChannel channel,
    required String identifier,
  }) async {
    throw Exception('network down');
  }
}

class _FakeFirebaseFunctions implements FirebaseFunctions {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Functions are not available in the test');
}

class _FakeFunctionsService extends FunctionsService {
  _FakeFunctionsService() : super(_FakeFirebaseFunctions());
}

/// An auth controller whose profile update always fails.
class _FailingProfileController extends AuthController {
  @override
  Future<void> build() async {}

  @override
  Future<void> updateProfile({
    String? name,
    String? phone,
    String? profileImage,
    bool removeProfileImage = false,
  }) async {
    throw Exception('the write was refused');
  }
}

/// An auth controller that remembers the update.
class _WorkingProfileController extends AuthController {
  String? savedName;

  @override
  Future<void> build() async {}

  @override
  Future<void> updateProfile({
    String? name,
    String? phone,
    String? profileImage,
    bool removeProfileImage = false,
  }) async {
    savedName = name;
  }
}

UserModel _profile() {
  return UserModel(
    uid: 'student-1',
    name: 'Asha',
    email: 'asha@example.com',
    role: UserRole.student,
    registrationCompleted: true,
    phoneVerified: true,
    createdAt: DateTime(2026, 1, 1),
    updatedAt: DateTime(2026, 1, 1),
  );
}

void main() {
  group('the verification code', () {
    testWidgets('the error stays visible when the code was wrong', (
      tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [otpServiceProvider.overrideWithValue(_WrongOtpService())],
          child: const MaterialApp(
            home: OtpVerificationScreen(
              channel: OtpChannel.email,
              identifier: 'asha@example.com',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The code is typed — the screen verifies it on its own.
      await tester.enterText(find.byType(TextField), '123456');
      await tester.pumpAndSettle();

      // The message has to be there: the listener of the field used to
      // wipe it the moment the field was cleared.
      expect(
        find.text('That code is not correct. Please try again.'),
        findsOneWidget,
      );

      // The field is empty again — the user can type a new code.
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller?.text, isEmpty);
    });

    testWidgets('a failed request does not claim that a code was sent', (
      tester,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            otpServiceProvider.overrideWithValue(_FailingOtpService()),
          ],
          child: const MaterialApp(
            home: OtpVerificationScreen(
              channel: OtpChannel.email,
              identifier: 'asha@example.com',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('We sent a 6-digit code'), findsNothing);
      expect(find.textContaining('We could not send a code'), findsOneWidget);
      expect(
        find.text('Could not send the code. Please try again.'),
        findsOneWidget,
      );
    });
  });

  group('the profile', () {
    /// A router with the profile screen **on top** of another page — the
    /// screen pops itself when the update worked.
    GoRouter buildRouter() {
      return GoRouter(
        initialLocation: '/home',
        routes: [
          GoRoute(
            path: '/home',
            builder: (context, state) =>
                const Scaffold(body: Center(child: Text('HOME'))),
          ),
          GoRoute(
            path: '/student/profile/edit',
            builder: (context, state) => const EditProfileScreen(),
          ),
        ],
      );
    }

    testWidgets('a failed update is not reported as a success', (tester) async {
      final controller = _FailingProfileController();
      final router = buildRouter();
      addTearDown(router.dispose);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authControllerProvider.overrideWith(() => controller),
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'student-1', email: 'asha@example.com'),
            ),
            authSessionProvider.overrideWith(
              (ref) => Stream.value(
                AuthSession(
                  user: MockUser(uid: 'student-1', email: 'asha@example.com'),
                  profile: _profile(),
                ),
              ),
            ),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      // The screen is **pushed** — it pops itself when the update worked.
      router.push('/student/profile/edit');
      await tester.pumpAndSettle();

      final saveButton = find.text('Save changes');
      await tester.ensureVisible(saveButton);
      await tester.pumpAndSettle();
      await tester.tap(saveButton);
      await tester.pumpAndSettle();

      // The screen must **not** say that the profile was updated.
      expect(find.text('Profile updated'), findsNothing);
      expect(find.textContaining('the write was refused'), findsOneWidget);
      // And it must not close itself either.
      expect(find.text('HOME'), findsNothing);
    });

    testWidgets('a successful update says so', (tester) async {
      final controller = _WorkingProfileController();
      final router = buildRouter();
      addTearDown(router.dispose);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authControllerProvider.overrideWith(() => controller),
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'student-1', email: 'asha@example.com'),
            ),
            authSessionProvider.overrideWith(
              (ref) => Stream.value(
                AuthSession(
                  user: MockUser(uid: 'student-1', email: 'asha@example.com'),
                  profile: _profile(),
                ),
              ),
            ),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      // The screen is **pushed** — it pops itself when the update worked.
      router.push('/student/profile/edit');
      await tester.pumpAndSettle();

      final saveButton = find.text('Save changes');
      await tester.ensureVisible(saveButton);
      await tester.pumpAndSettle();
      await tester.tap(saveButton);
      await tester.pumpAndSettle();

      expect(controller.savedName, 'Asha');
      expect(find.text('Profile updated'), findsOneWidget);
      // The screen closed itself.
      expect(find.text('HOME'), findsOneWidget);
    });
  });

  group('the route of a push notification', () {
    testWidgets('the route is remembered while the splash screen is running', (
      tester,
    ) async {
      final router = GoRouter(
        initialLocation: '/splash',
        routes: [
          GoRoute(
            path: '/splash',
            builder: (context, state) =>
                const Scaffold(body: Center(child: Text('SPLASH'))),
          ),
          GoRoute(
            path: '/owner/requests',
            builder: (context, state) =>
                const Scaffold(body: Center(child: Text('OWNER REQUESTS'))),
          ),
        ],
      );
      addTearDown(router.dispose);

      final container = ProviderContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      expect(router.routerDelegate.currentConfiguration.uri.path, '/splash');

      // The route of the notification is written down — the splash screen
      // picks it up instead of opening the home screen.
      container.read(pendingNotificationRouteProvider.notifier).state =
          '/owner/requests';
      await tester.pump();

      expect(
        container.read(pendingNotificationRouteProvider),
        '/owner/requests',
      );
    });
  });

  group('the conversation model', () {
    test('equal conversations have the same hash code', () {
      ConversationModel build(Map<String, int> unread) {
        return ConversationModel(
          conversationId: 'c1',
          participants: const ['a', 'b'],
          lastMessage: 'hello',
          lastMessageAt: DateTime(2026, 1, 1),
          unreadCount: unread,
          roomId: 'r1',
          createdAt: DateTime(2026, 1, 1),
          updatedAt: DateTime(2026, 1, 1),
        );
      }

      // The same map, but the keys were inserted in a different order.
      final one = build({'a': 1, 'b': 2});
      final two = build({'b': 2, 'a': 1});

      expect(one, two);
      expect(one.hashCode, two.hashCode);

      // And they behave the same in a set.
      expect({one, two}.length, 1);
    });
  });
}
