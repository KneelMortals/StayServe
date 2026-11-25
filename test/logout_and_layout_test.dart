// Tests for the **log out** of the app.
//
// The rule the app has to follow:
//
//   * the log out ends on the **login screen**,
//   * the router must not show its "Page Not Found" page on the way,
//   * the user must not be sent back to the dashboard of the role.
//
// ## The trap this test guards against
//
// The session of Firebase Auth is empty a moment **after** the sign-out
// has finished — there is a gap of a few milliseconds between the two.
//
// A `router.go('/login')` inside that gap was redirected straight back to
// the dashboard of the role: the router still saw the old session, and a
// signed-in user on an auth screen belongs on the dashboard. When the user
// was on the dashboard already, the router ran into a **redirect loop**
// and showed its error page instead of the login screen.

import 'dart:async';

import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/routing/app_router.dart';
import 'package:stayserve/core/widgets/common_widgets.dart';
import 'package:stayserve/features/admin/presentation/providers/admin_providers.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/notifications/presentation/providers/notification_providers.dart';
import 'package:stayserve/features/owners/presentation/screens/owner_profile_screen.dart';
import 'package:stayserve/features/students/presentation/screens/student_profile_screen.dart';
import 'package:stayserve/firebase/admin/admin_repository.dart';
import 'package:stayserve/models/user_model.dart';

/// The auth controller that really signs the user out — it empties the
/// session stream, exactly like the real one does.
///
/// That is the important part of the test: the router reacts to the empty
/// session by taking the page off the stack, and the `context` of the
/// button that was pressed is deactivated. The navigation after the sign-out
/// must not use that context any more.
class _SigningOutController extends AuthController {
  _SigningOutController(this.onSignOut);

  final void Function() onSignOut;

  @override
  Future<void> build() async {}

  @override
  Future<void> signOut() async {
    onSignOut();
  }
}

/// The auth controller whose session is empty a moment **after** the
/// sign-out has finished.
///
/// That is what really happens: the sign-out of Firebase Auth completes
/// before its state stream is empty. The gap is a few milliseconds — and
/// it was enough to send the user back to the dashboard of the role
/// instead of the login screen.
class _LateSigningOutController extends AuthController {
  _LateSigningOutController(this.onSignOut);

  final void Function() onSignOut;

  @override
  Future<void> build() async {}

  @override
  Future<void> signOut() async {
    Timer(const Duration(milliseconds: 20), onSignOut);
  }
}

UserModel _profile(String uid, UserRole role) {
  final now = DateTime(2026, 1, 1);
  return UserModel(
    uid: uid,
    name: 'Test $role',
    email: '$uid@example.com',
    role: role,
    registrationCompleted: true,
    phoneVerified: true,
    createdAt: now,
    updatedAt: now,
  );
}

AdminStats _stats() {
  return AdminStats(
    totalUsers: 1284,
    totalStudents: 1103,
    totalOwners: 181,
    totalRooms: 742,
    availableRooms: 615,
    joinedRooms: 127,
    pendingConfirmations: 18,
    pendingInvoices: 42,
    totalRevenue: 4865000,
  );
}

/// Pumps a fixed number of frames.
///
/// `pumpAndSettle` cannot be used everywhere: several screens show a
/// `CircularProgressIndicator`, which animates for ever.
Future<void> _pump(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

void main() {
  testWidgets('the admin logout lands on the login screen', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final user = MockUser(uid: 'admin-1', email: 'admin@example.com');
    final session = StreamController<AuthSession?>();
    addTearDown(session.close);

    final controller = _SigningOutController(() => session.add(null));

    final container = ProviderContainer(
      overrides: [
        authSessionProvider.overrideWith((ref) => session.stream),
        authControllerProvider.overrideWith(() => controller),
        currentUserProvider.overrideWithValue(user),
        adminStatsProvider.overrideWith((ref) => Stream.value(_stats())),
        unreadNotificationCountProvider.overrideWith((ref) => Stream.value(0)),
      ],
    );
    addTearDown(container.dispose);

    final router = container.read(routerProvider);
    router.go('/admin/dashboard');
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byTooltip('Log out'), findsOneWidget);

    await tester.tap(find.byTooltip('Log out'));
    await tester.pumpAndSettle();

    // The error page of the router must not show up — the user has to end
    // up on the login screen.
    expect(find.text('Page Not Found'), findsNothing);
    expect(router.routerDelegate.currentConfiguration.uri.path, '/login');
    expect(router.routerDelegate.currentConfiguration.matches, isNotEmpty);
  });

  testWidgets(
    'the admin logout lands on the login screen even when the session '
    'is empty a moment later',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(400, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final user = MockUser(uid: 'admin-1', email: 'admin@example.com');
      final profile = _profile(user.uid, UserRole.admin);
      final session = StreamController<AuthSession?>();
      addTearDown(session.close);

      // The session of the real app is there while the user works — and it
      // is empty a few milliseconds **after** the sign-out has finished. The
      // router must not send the user back to the dashboard in that gap:
      // that ended on the "Page Not Found" page.
      final controller = _LateSigningOutController(() => session.add(null));

      final container = ProviderContainer(
        overrides: [
          authSessionProvider.overrideWith((ref) => session.stream),
          authControllerProvider.overrideWith(() => controller),
          currentUserProvider.overrideWithValue(user),
          adminStatsProvider.overrideWith((ref) => Stream.value(_stats())),
          unreadNotificationCountProvider.overrideWith(
            (ref) => Stream.value(0),
          ),
        ],
      );
      addTearDown(container.dispose);

      final router = container.read(routerProvider);
      router.go('/admin/dashboard');
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(routerConfig: router),
        ),
      );

      // The session arrives — the user is signed in.
      session.add(AuthSession(user: user, profile: profile));
      await _pump(tester);

      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/admin/dashboard',
      );
      expect(find.byTooltip('Log out'), findsOneWidget);

      await tester.tap(find.byTooltip('Log out'));

      // The login screen has to show up **right away** — the user must not
      // be sent back to the dashboard of the role while the session is still
      // being emptied.
      await tester.pump();
      await tester.pump();

      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/login',
        reason: 'the logout has to lead to the login screen right away',
      );
      expect(find.text('Page Not Found'), findsNothing);

      // The sign-out and the navigation that follows it.
      for (var i = 0; i < 12; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }

      expect(find.text('Page Not Found'), findsNothing);
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/login',
        reason: 'the logout has to end on the login screen',
      );
      expect(router.routerDelegate.currentConfiguration.matches, isNotEmpty);
    },
  );

  testWidgets('the login screen fits on a narrow phone', (tester) async {
    // The "Don't have an account? / Sign Up" row overflowed by 114 pixels
    // on a 400 px wide phone — the sign up button was cut off.
    await tester.binding.setSurfaceSize(const Size(400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final session = StreamController<AuthSession?>();
    addTearDown(session.close);

    final container = ProviderContainer(
      overrides: [
        authSessionProvider.overrideWith((ref) => session.stream),
        currentUserProvider.overrideWithValue(null),
        unreadNotificationCountProvider.overrideWith((ref) => Stream.value(0)),
      ],
    );
    addTearDown(container.dispose);

    final router = container.read(routerProvider);
    router.go('/login');
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.text('Sign Up'), findsOneWidget);
  });

  // -------------------------------------------------------------------------
  // The log out of the **student** and of the **owner**.
  //
  // They use the same helper as the admin — but their screens are built
  // differently, so they are covered on their own.
  // -------------------------------------------------------------------------

  testWidgets('the student logout lands on the login screen', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final user = MockUser(uid: 'student-1', email: 'student@example.com');
    final profile = _profile(user.uid, UserRole.student);
    final session = StreamController<AuthSession?>();
    addTearDown(session.close);

    final controller = _LateSigningOutController(() => session.add(null));

    final container = ProviderContainer(
      overrides: [
        authSessionProvider.overrideWith((ref) => session.stream),
        authControllerProvider.overrideWith(() => controller),
        currentUserProvider.overrideWithValue(user),
        authStateProvider.overrideWith((ref) => Stream.value(user)),
        userProfileProvider.overrideWith((ref, uid) async => profile),
        unreadNotificationCountProvider.overrideWith((ref) => Stream.value(0)),
      ],
    );
    addTearDown(container.dispose);

    final router = container.read(routerProvider);
    router.go('/student/profile');
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    session.add(AuthSession(user: user, profile: profile));
    await _pump(tester);

    // The button is at the bottom of the profile — and a list only builds
    // the rows that are on the screen, so it has to be scrolled into view
    // first.
    final logoutButton = find.widgetWithText(AppButton, 'Logout');
    await tester.scrollUntilVisible(logoutButton, 300);
    await tester.pump();
    expect(logoutButton, findsOneWidget);

    await tester.tap(logoutButton);
    await _pump(tester);

    expect(find.text('Page Not Found'), findsNothing);
    expect(
      router.routerDelegate.currentConfiguration.uri.path,
      '/login',
      reason: 'the logout has to lead to the login screen',
    );
  });

  testWidgets('the owner logout lands on the login screen', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final user = MockUser(uid: 'owner-1', email: 'owner@example.com');
    final profile = _profile(user.uid, UserRole.owner);
    final session = StreamController<AuthSession?>();
    addTearDown(session.close);

    final controller = _LateSigningOutController(() => session.add(null));

    final container = ProviderContainer(
      overrides: [
        authSessionProvider.overrideWith((ref) => session.stream),
        authControllerProvider.overrideWith(() => controller),
        currentUserProvider.overrideWithValue(user),
        authStateProvider.overrideWith((ref) => Stream.value(user)),
        userProfileProvider.overrideWith((ref, uid) async => profile),
        unreadNotificationCountProvider.overrideWith((ref) => Stream.value(0)),
      ],
    );
    addTearDown(container.dispose);

    final router = container.read(routerProvider);
    router.go('/owner/profile');
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    session.add(AuthSession(user: user, profile: profile));
    await _pump(tester);

    // The button is at the bottom of the profile — and a list only builds
    // the rows that are on the screen, so it has to be scrolled into view
    // first.
    final logoutButton = find.widgetWithText(AppButton, 'Logout');
    await tester.scrollUntilVisible(logoutButton, 300);
    await tester.pump();
    expect(logoutButton, findsOneWidget);

    await tester.tap(logoutButton);
    await _pump(tester);

    expect(find.text('Page Not Found'), findsNothing);
    expect(
      router.routerDelegate.currentConfiguration.uri.path,
      '/login',
      reason: 'the logout has to lead to the login screen',
    );
  });

  testWidgets('the profile screens of the student and of the owner fit on a '
      'narrow phone', (tester) async {
    await tester.binding.setSurfaceSize(const Size(360, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final user = MockUser(uid: 'student-1', email: 'student@example.com');
    final profile = _profile(user.uid, UserRole.student);
    final session = StreamController<AuthSession?>();
    addTearDown(session.close);

    final container = ProviderContainer(
      overrides: [
        authSessionProvider.overrideWith((ref) => session.stream),
        currentUserProvider.overrideWithValue(user),
        authStateProvider.overrideWith((ref) => Stream.value(user)),
        userProfileProvider.overrideWith((ref, uid) async => profile),
        unreadNotificationCountProvider.overrideWith((ref) => Stream.value(0)),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: StudentProfileScreen()),
      ),
    );
    session.add(AuthSession(user: user, profile: profile));
    await _pump(tester);

    expect(tester.takeException(), isNull);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: OwnerProfileScreen()),
      ),
    );
    await _pump(tester);

    expect(tester.takeException(), isNull);
  });
}
