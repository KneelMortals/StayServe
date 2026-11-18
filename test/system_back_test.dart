// Tests for the **system back button** — the one of the phone.
//
// The rule the app has to follow:
//
//   * on a **section** screen (a tab of the bottom navigation, an entry of
//     the drawer) the back button leads to the **dashboard** of the role,
//   * on the dashboard it asks for a second press before the app closes,
//   * on a **detail** screen (a room, a chat, an invoice) it leads to the
//     page the user came from.
//
// ## The trap this test guards against
//
// The app has **two** navigators on a section screen: the root navigator
// holds the page of the shell (the bottom navigation), and the navigator of
// the shell holds the page of the screen itself.
//
// Every navigator tells the platform whether *it* can handle the back
// button (`NavigationNotification.canHandlePop`). The **last** navigator
// that says something wins — and the nested one is built after the root
// one. So the guard has to sit on the screen itself as well: when only the
// shell carried it, the nested navigator said "nobody handles the back
// button", Android closed the activity and the app was gone.
//
// The test watches the platform channel of `SystemNavigator.pop` — that is
// the call that closes the app.

import 'dart:async';

import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/routing/app_router.dart';
import 'package:stayserve/core/routing/back_to_dashboard.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/notifications/presentation/providers/notification_providers.dart';
import 'package:stayserve/features/owners/presentation/providers/owner_providers.dart'
    as owner;
import 'package:stayserve/firebase/owner/owner_repository.dart';
import 'package:stayserve/features/students/presentation/providers/student_providers.dart';
import 'package:stayserve/services/user_location_provider.dart';
import 'package:stayserve/models/notification_model.dart';
import 'package:stayserve/models/owned_room_model.dart';
import 'package:stayserve/firebase/notifications/notifications_repository.dart';
import 'package:stayserve/models/join_request_model.dart';
import 'package:stayserve/models/room_model.dart';

import 'support/audit_fakes.dart';

/// Pumps a fixed number of frames.
///
/// `pumpAndSettle` cannot be used here: several screens show a
/// `CircularProgressIndicator`, which animates for ever — the settle would
/// never end.
Future<void> _pump(WidgetTester tester) async {
  for (var i = 0; i < 12; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// Records every call that would **close the app** — and the signal the
/// framework gives the platform about the back button.
///
/// `SystemNavigator.setFrameworkHandlesBack(false)` tells Android "the
/// framework cannot handle the back button" — and Android closes the
/// activity. That is exactly what happened: the **nested** navigator of the
/// shell said "no" and overtook the guard of the shell.
class _AppCloser {
  int popCalls = 0;

  /// Every value the framework told the platform, in order.
  final List<bool> frameworkHandlesBack = [];

  void install(WidgetTester tester) {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        switch (call.method) {
          case 'SystemNavigator.pop':
            popCalls++;
          case 'SystemNavigator.setFrameworkHandlesBack':
            frameworkHandlesBack.add(call.arguments as bool);
        }
        return null;
      },
    );
    addTearDown(() {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      );
    });
  }

  /// Whether the platform is told that the framework handles the back
  /// button.
  ///
  /// The **last** value wins — the navigators notify one after the other.
  bool get platformCanHandleBack {
    if (frameworkHandlesBack.isEmpty) return true;
    return frameworkHandlesBack.last;
  }
}

/// Mounts the **real** router of the app at [location].
Future<ProviderContainer> _pumpRouter(
  WidgetTester tester, {
  required String location,
  required UserRole role,
  _AppCloser? closer,
}) async {
  await tester.binding.setSurfaceSize(const Size(400, 1200));
  addTearDown(() => tester.binding.setSurfaceSize(null));

  final uid = '${role.name}-1';
  final user = auditUser(uid: uid, role: role, name: 'Test ${role.name}');
  final mockUser = auditMockUser(uid: uid, email: user.email);

  final container = ProviderContainer(
    overrides: [
      currentUserProvider.overrideWithValue(mockUser),
      authStateProvider.overrideWith((ref) => Stream.value(mockUser)),
      authSessionProvider.overrideWith(
        (ref) => Stream.value(AuthSession(user: mockUser, profile: user)),
      ),
      authControllerProvider.overrideWith(() => FakeAuthController()),
      userProfileProvider.overrideWith((ref, id) async => user),
      userLocationProvider.overrideWith(() => FakeUserLocationNotifier()),
      notificationsRepositoryProvider.overrideWithValue(
        FakeNotificationsRepository(),
      ),
      notificationsProvider.overrideWith(
        (ref) => Stream.value(<NotificationModel>[]),
      ),
      unreadNotificationCountProvider.overrideWith((ref) => Stream.value(0)),
      // The data of the student area — without it the screens would talk to
      // the real Firestore and the test would never finish.
      roomsSearchProvider.overrideWith((ref) => Stream.value(<RoomModel>[])),
      filteredRoomsProvider.overrideWith((ref) => Stream.value(<RoomModel>[])),
      savedRoomsProvider.overrideWith((ref) => Stream.value(<RoomModel>[])),
      myJoinRequestsProvider.overrideWith(
        (ref) => Stream.value(<JoinRequestModel>[]),
      ),
      // The data of the owner area.
      owner.myRoomsProvider.overrideWith(
        (ref) => Stream.value(<OwnedRoomModel>[]),
      ),
      owner.myJoinRequestsProvider.overrideWith(
        (ref) => Stream.value(<JoinRequestModel>[]),
      ),
      owner.myInvoicesProvider.overrideWith(
        (ref) => Stream.value(<CommissionInvoiceModel>[]),
      ),
      owner.ownerStatsProvider.overrideWithValue(
        OwnerStats(
          totalRooms: 0,
          availableRooms: 0,
          occupiedRooms: 0,
          pendingRequests: 0,
          awaitingPayment: 0,
          totalRevenue: 0,
        ),
      ),
    ],
  );
  addTearDown(container.dispose);

  final router = container.read(routerProvider);
  router.go(location);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        routerConfig: router,
        // The app says itself that it handles the back button — the same
        // way the real app does it.
        onNavigationNotification: handleNavigationNotification,
      ),
    ),
  );
  await _pump(tester);

  expect(
    router.routerDelegate.currentConfiguration.uri.path,
    location,
    reason: 'the router did not open $location',
  );

  return container;
}

/// The path the router is on right now.
String _path(ProviderContainer container) {
  return container
      .read(routerProvider)
      .routerDelegate
      .currentConfiguration
      .uri
      .path;
}

/// Presses the **system back button** of the phone.
///
/// This is the call the Android system makes when the user presses the
/// back button of the phone.
Future<void> _pressSystemBack(WidgetTester tester) async {
  await tester.binding.handlePopRoute();
  await _pump(tester);
}

void main() {
  group('the system back button of the student', () {
    for (final section in [
      '/student/search',
      '/student/saved',
      '/student/joined-rooms',
      '/student/profile',
      '/student/requests',
    ]) {
      testWidgets('leads from $section to the dashboard', (tester) async {
        final closer = _AppCloser()..install(tester);

        final container = await _pumpRouter(
          tester,
          location: section,
          role: UserRole.student,
          closer: closer,
        );

        await _pressSystemBack(tester);

        expect(
          closer.popCalls,
          0,
          reason: 'the app must not close on $section',
        );
        expect(
          closer.platformCanHandleBack,
          isTrue,
          reason:
              'the platform must be told that the back button is '
              'handled on $section',
        );
        expect(
          _path(container),
          '/student/home',
          reason: 'the back button on $section has to lead to the dashboard',
        );
      });
    }

    testWidgets('on the dashboard it asks before the app closes', (
      tester,
    ) async {
      final closer = _AppCloser()..install(tester);

      final container = await _pumpRouter(
        tester,
        location: '/student/home',
        role: UserRole.student,
        closer: closer,
      );

      // The first press must **not** leave the app.
      await _pressSystemBack(tester);

      expect(closer.popCalls, 0, reason: 'the first press must not close it');
      expect(_path(container), '/student/home');
      expect(find.text('Press back again to leave StayServe'), findsOneWidget);
    });

    testWidgets('on the dashboard a second press closes the app', (
      tester,
    ) async {
      final closer = _AppCloser()..install(tester);

      await _pumpRouter(
        tester,
        location: '/student/home',
        role: UserRole.student,
        closer: closer,
      );

      await _pressSystemBack(tester);
      await _pressSystemBack(tester);

      expect(
        closer.popCalls,
        1,
        reason: 'the second press on the dashboard has to close the app',
      );
    });
  });

  group('the system back button of the owner', () {
    for (final section in [
      '/owner/rooms',
      '/owner/requests',
      '/owner/invoices',
      '/owner/profile',
    ]) {
      testWidgets('leads from $section to the dashboard', (tester) async {
        final closer = _AppCloser()..install(tester);

        final container = await _pumpRouter(
          tester,
          location: section,
          role: UserRole.owner,
          closer: closer,
        );

        await _pressSystemBack(tester);

        expect(
          closer.popCalls,
          0,
          reason: 'the app must not close on $section',
        );
        expect(
          closer.platformCanHandleBack,
          isTrue,
          reason:
              'the platform must be told that the back button is '
              'handled on $section',
        );
        expect(
          _path(container),
          '/owner/dashboard',
          reason: 'the back button on $section has to lead to the dashboard',
        );
      });
    }
  });

  group('the system back button of the admin', () {
    for (final section in [
      '/admin/users',
      '/admin/rooms',
      '/admin/requests',
      '/admin/invoices',
      '/admin/payments',
      '/admin/analytics',
      '/admin/settings',
      '/admin/launch-areas',
    ]) {
      testWidgets('leads from $section to the dashboard', (tester) async {
        final closer = _AppCloser()..install(tester);

        final container = await _pumpRouter(
          tester,
          location: section,
          role: UserRole.admin,
          closer: closer,
        );

        await _pressSystemBack(tester);

        expect(
          closer.popCalls,
          0,
          reason: 'the app must not close on $section',
        );
        expect(
          closer.platformCanHandleBack,
          isTrue,
          reason:
              'the platform must be told that the back button is '
              'handled on $section',
        );
        expect(
          _path(container),
          '/admin/dashboard',
          reason: 'the back button on $section has to lead to the dashboard',
        );
      });
    }
  });
}
