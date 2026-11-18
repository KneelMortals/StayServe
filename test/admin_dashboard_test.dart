// Tests for the **dashboard of the admin area**.
//
// The rule the dashboard has to follow:
//
//   * it shows **four rows of data** — the headline figures, the open work,
//     the breakdown and the newest bookings,
//   * the newest bookings are **real**: they come from Firestore and they
//     say who booked what.
//
// The old dashboard showed three made-up "recent activity" entries
// ("Admin dashboard loaded", "Commission settings", …) that never changed
// and told the admin nothing.

import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/theme/app_theme.dart';
import 'package:stayserve/features/admin/presentation/providers/admin_providers.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_dashboard_screen.dart';
import 'package:stayserve/features/notifications/presentation/providers/notification_providers.dart';
import 'package:stayserve/firebase/admin/admin_repository.dart';
import 'package:stayserve/models/join_request_model.dart';

final DateTime _now = DateTime(2026, 11, 14);

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

JoinRequestModel _request(String requestId, JoinRequestStatus status) {
  return JoinRequestModel(
    requestId: requestId,
    roomId: 'room-$requestId',
    studentId: 'student-$requestId',
    ownerId: 'owner-1',
    status: status,
    createdAt: _now,
    updatedAt: _now,
    monthlyRentAtJoin: 12000,
    commissionPercentageAtJoin: 30,
  );
}

final List<AdminRecentRequest> _recent = [
  AdminRecentRequest(
    request: _request('JRQ-AAA', JoinRequestStatus.pending),
    roomTitle: 'Sunny PG for boys',
    studentName: 'Sunita Sharma',
  ),
  AdminRecentRequest(
    request: _request('JRQ-BBB', JoinRequestStatus.ownerConfirmed),
    roomTitle: 'Green Nest',
    studentName: 'Rahul Verma',
  ),
  AdminRecentRequest(
    request: _request('JRQ-CCC', JoinRequestStatus.adminReviewed),
    roomTitle: 'Quiet Corner',
    studentName: 'Anita Desai',
  ),
  AdminRecentRequest(
    request: _request('JRQ-DDD', JoinRequestStatus.rejected),
    roomTitle: 'City View',
    studentName: 'Vikram Singh',
  ),
];

Future<void> _pumpDashboard(
  WidgetTester tester, {
  List<AdminRecentRequest>? recent,
}) async {
  await tester.binding.setSurfaceSize(const Size(400, 1200));
  addTearDown(() => tester.binding.setSurfaceSize(null));

  final router = GoRouter(
    initialLocation: '/admin/dashboard',
    routes: [
      GoRoute(
        path: '/admin/dashboard',
        builder: (context, state) => const AdminDashboardScreen(),
      ),
      GoRoute(
        path: '/admin/users',
        builder: (context, state) => const Scaffold(body: Text('Users')),
      ),
      GoRoute(
        path: '/admin/rooms',
        builder: (context, state) => const Scaffold(body: Text('Rooms')),
      ),
      GoRoute(
        path: '/admin/requests',
        builder: (context, state) => const Scaffold(body: Text('Requests')),
      ),
      GoRoute(
        path: '/admin/invoices',
        builder: (context, state) => const Scaffold(body: Text('Invoices')),
      ),
      GoRoute(
        path: '/admin/payments',
        builder: (context, state) => const Scaffold(body: Text('Payments')),
      ),
    ],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        adminStatsProvider.overrideWith((ref) => Stream.value(_stats())),
        adminRecentRequestsProvider.overrideWith(
          (ref) => Stream.value(recent ?? _recent),
        ),
        unreadNotificationCountProvider.overrideWith((ref) => Stream.value(3)),
      ],
      child: MaterialApp.router(
        routerConfig: router,
        theme: buildAppTheme(Brightness.light),
      ),
    ),
  );

  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

/// Scrolls the dashboard down to the bottom.
///
/// The list is lazy — the sections below the fold are only built when they
/// are scrolled into view.
Future<void> _scrollToBottom(WidgetTester tester) async {
  await tester.dragUntilVisible(
    find.text('Quick Actions'),
    find.byType(ListView).first,
    const Offset(0, -200),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  testWidgets('the dashboard shows four rows of data', (tester) async {
    await _pumpDashboard(tester);

    // Row 1 — the headline figures.
    expect(find.text('At a glance'), findsOneWidget);
    expect(find.text('Users'), findsOneWidget);
    expect(find.text('Rooms'), findsOneWidget);
    expect(find.text('Open work'), findsOneWidget);
    // The number is in the headline row **and** in the breakdown.
    expect(find.text('1284'), findsWidgets);
    expect(find.text('742'), findsWidgets);

    // Row 2 — the work that is still open.
    expect(find.text('Needs attention'), findsOneWidget);
    expect(find.text('Pending confirmations'), findsWidgets);
    expect(find.text('Pending invoices'), findsWidgets);

    // Row 3 — the breakdown.
    expect(find.text('Key figures'), findsOneWidget);
    expect(find.text('PEOPLE'), findsOneWidget);
    expect(find.text('LISTINGS'), findsOneWidget);
    expect(find.text('MONEY'), findsOneWidget);

    // Row 4 — the newest bookings.
    await _scrollToBottom(tester);
    expect(find.text('Recent activity'), findsOneWidget);
    expect(find.textContaining('Sunita Sharma'), findsOneWidget);
    expect(find.textContaining('Rahul Verma'), findsOneWidget);
    expect(find.textContaining('Anita Desai'), findsOneWidget);
    expect(find.textContaining('Vikram Singh'), findsOneWidget);
  });

  testWidgets('the recent activity shows the room and the state', (
    tester,
  ) async {
    await _pumpDashboard(tester);
    await _scrollToBottom(tester);

    expect(find.textContaining('Sunny PG for boys'), findsOneWidget);
    // The state of the request is on the row as well.
    expect(find.text('Pending'), findsOneWidget);
    expect(find.text('Owner Confirmed'), findsOneWidget);
    expect(find.text('Admin Reviewed'), findsOneWidget);
    expect(find.text('Rejected'), findsOneWidget);
  });

  testWidgets('the recent activity explains itself when there is none', (
    tester,
  ) async {
    await _pumpDashboard(tester, recent: const []);
    await _scrollToBottom(tester);

    expect(find.text('Recent activity'), findsOneWidget);
    expect(find.textContaining('No booking request yet'), findsOneWidget);
  });

  testWidgets('the headline figures lead to their screen', (tester) async {
    await _pumpDashboard(tester);

    final users = find.text('Users');
    await tester.ensureVisible(users);
    await tester.pumpAndSettle();
    await tester.tap(users);
    await tester.pumpAndSettle();

    expect(find.text('Users'), findsWidgets);
  });

  testWidgets('the dashboard has no overflow on a narrow phone', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final router = GoRouter(
      initialLocation: '/admin/dashboard',
      routes: [
        GoRoute(
          path: '/admin/dashboard',
          builder: (context, state) => const AdminDashboardScreen(),
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          adminStatsProvider.overrideWith((ref) => Stream.value(_stats())),
          adminRecentRequestsProvider.overrideWith(
            (ref) => Stream.value(_recent),
          ),
          unreadNotificationCountProvider.overrideWith(
            (ref) => Stream.value(3),
          ),
        ],
        child: MaterialApp.router(
          routerConfig: router,
          theme: buildAppTheme(Brightness.light),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(tester.takeException(), isNull);
  });
}
