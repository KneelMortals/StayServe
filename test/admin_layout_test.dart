import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/theme/app_theme.dart';
import 'package:stayserve/features/admin/presentation/providers/admin_providers.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_analytics_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_dashboard_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_invoices_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_launch_areas_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_payments_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_requests_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_rooms_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_settings_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_users_screen.dart';
import 'package:stayserve/features/admin/presentation/widgets/admin_scaffold.dart';
import 'package:stayserve/features/messaging/presentation/providers/messaging_providers.dart';
import 'package:stayserve/features/notifications/presentation/providers/notification_providers.dart';
import 'package:stayserve/firebase/admin/admin_repository.dart';
import 'package:stayserve/models/interaction_model.dart';
import 'package:stayserve/models/join_request_model.dart';
import 'package:stayserve/models/launch_pincode_config.dart';
import 'package:stayserve/models/payment_model.dart';
import 'package:stayserve/models/room_model.dart';
import 'package:stayserve/models/user_model.dart';

// ---------------------------------------------------------------------------
// Test data.
//
// The data is deliberately "too long": the names, the e-mail addresses and
// the room titles are much longer than a real one, because that is exactly
// what made the admin panel look broken.
// ---------------------------------------------------------------------------

final DateTime _now = DateTime(2026, 11, 13);

UserModel _user({
  required String uid,
  required String name,
  required String email,
  UserRole role = UserRole.student,
  bool isActive = true,
  bool deletionScheduled = false,
  String? banReason,
}) {
  return UserModel(
    uid: uid,
    name: name,
    email: email,
    phone: '+91 98765 43210',
    role: role,
    isActive: isActive,
    createdAt: _now,
    updatedAt: _now,
    banReason: banReason,
    deletionScheduled: deletionScheduled,
    deletionScheduledAt: deletionScheduled ? _now : null,
    deleteAfter: deletionScheduled ? _now.add(const Duration(days: 7)) : null,
  );
}

final List<UserModel> _users = [
  _user(
    uid: 'admin-1',
    name: 'Shaurya Pratap Rai',
    email: 'shauryapratapraiom@gmail.com',
    role: UserRole.admin,
  ),
  _user(
    uid: 'owner-1',
    name: 'Dharmpal Singh With A Very Long Name',
    email: 'dhrampal99880@gmail.com',
    role: UserRole.owner,
  ),
  _user(
    uid: 'student-1',
    name: 'Student',
    email: 'shauryaprataprai2007@gmail.com',
  ),
  _user(
    uid: 'student-2',
    name: 'Banned Student',
    email: 'fourteennine14@gmail.com',
    isActive: false,
    banReason: 'Policy violation — spam of the owners',
  ),
  _user(
    uid: 'student-3',
    name: 'Scheduled For Deletion',
    email: 'to.be.deleted@gmail.com',
    isActive: false,
    deletionScheduled: true,
  ),
];

RoomModel _room({
  String roomId = 'room-1',
  String ownerId = 'owner-1',
  String title = 'A very long room title that does not fit on one line',
}) {
  return RoomModel(
    roomId: roomId,
    ownerId: ownerId,
    title: title,
    description: 'A comfortable room near the college',
    monthlyRent: 12000,
    securityDeposit: 30000,
    location: const Location(city: 'Bengaluru', state: 'Karnataka'),
    roomType: RoomType.single,
    furnishing: FurnishingType.semi,
    availableFrom: _now,
    amenities: const ['WiFi', 'Power backup', 'Water'],
    occupancy: 2,
    currentOccupancy: 1,
    genderPreference: GenderPreference.any,
    status: RoomStatus.available,
    createdAt: _now,
    updatedAt: _now,
  );
}

final List<RoomModel> _rooms = [
  _room(),
  _room(roomId: 'room-2', ownerId: 'owner-2', title: 'Second listing'),
];

JoinRequestModel _request({
  String requestId = 'JRQ-1794513452376',
  JoinRequestStatus status = JoinRequestStatus.ownerConfirmed,
  bool advancePaid = false,
}) {
  return JoinRequestModel(
    requestId: requestId,
    roomId: 'room-1',
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: status,
    createdAt: _now,
    updatedAt: _now,
    monthlyRentAtJoin: 12000,
    commissionPercentageAtJoin: 30,
    advancePaid: advancePaid,
    advanceAmount: advancePaid ? 3600 : null,
    advancePaymentReference: advancePaid ? '425781234567' : null,
    advancePaymentStatus: advancePaid ? PaymentStatus.submitted : null,
    platformFeePayer: 'owner',
  );
}

final List<JoinRequestModel> _requests = [
  _request(),
  _request(
    requestId: 'JRQ-1794513353709',
    status: JoinRequestStatus.adminReviewed,
    advancePaid: true,
  ),
];

CommissionInvoiceModel _invoice({
  String invoiceId = 'INV-JRQ-1794513452376',
  InvoiceStatus status = InvoiceStatus.pending,
}) {
  return CommissionInvoiceModel(
    invoiceId: invoiceId,
    roomId: 'room-1',
    ownerId: 'owner-1',
    tenantId: 'student-1',
    joinRequestId: 'JRQ-1794513452376',
    monthlyRent: 12000,
    commissionPercentage: 30,
    commissionAmount: 3600,
    status: status,
    createdAt: _now,
    updatedAt: _now,
  );
}

final List<CommissionInvoiceModel> _invoices = [
  _invoice(),
  _invoice(invoiceId: 'INV-JRQ-1794513353709', status: InvoiceStatus.paid),
  _invoice(invoiceId: 'INV-JRQ-1794513353708', status: InvoiceStatus.overdue),
];

PaymentModel _payment({
  String paymentId = 'PAY-1',
  PaymentStatus status = PaymentStatus.submitted,
}) {
  return PaymentModel(
    paymentId: paymentId,
    requestId: 'JRQ-1794513452376',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'room-1',
    amount: 3600,
    feePercentage: 30,
    reference: '425781234567',
    method: 'upi',
    payeeVpa: 'shauryaprataprai461-2@oksbi',
    status: status,
    submittedAt: _now,
  );
}

final List<PaymentModel> _payments = [
  _payment(),
  _payment(paymentId: 'PAY-2', status: PaymentStatus.verified),
  _payment(paymentId: 'PAY-3', status: PaymentStatus.rejected),
];

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

/// The newest booking requests — the "recent activity" of the dashboard.
final List<AdminRecentRequest> _recentRequests = [
  AdminRecentRequest(
    request: _requests.first,
    roomTitle: 'A very long room title that does not fit on one line',
    studentName: 'Shaurya Pratap Rai',
  ),
  AdminRecentRequest(
    request: _requests.last,
    roomTitle: 'Second listing',
    studentName: 'Student',
  ),
];

const LaunchPincodeConfig _launchConfig = LaunchPincodeConfig(
  enabledPincodes: ['560001', '560002', '560003'],
  disabledPincodes: ['110001'],
  mode: 'whitelist',
  configured: true,
);

/// Every provider the admin screens read.
///
/// The screens are rendered with **data** — the point of the test is the
/// layout, and a list with long names is what used to break it.
List<Override> _overrides() {
  return [
    adminStatsProvider.overrideWith((ref) => Stream.value(_stats())),
    adminRecentRequestsProvider.overrideWith(
      (ref) => Stream.value(_recentRequests),
    ),
    adminUsersProvider.overrideWith((ref, filter) => Stream.value(_users)),
    adminRoomsProvider.overrideWith((ref, filter) => Stream.value(_rooms)),
    adminJoinRequestsProvider.overrideWith(
      (ref, filter) => Stream.value(_requests),
    ),
    adminInvoicesProvider.overrideWith(
      (ref, filter) => Stream.value(_invoices),
    ),
    adminPaymentsProvider.overrideWith(
      (ref, filter) => Stream.value(
        _payments
            .where((payment) => filter == null || payment.status == filter)
            .toList(),
      ),
    ),
    bookingInteractionDetailsProvider.overrideWith(
      (ref, requestId) async => const BookingInteractionDetails(
        requestId: 'JRQ-1794513452376',
        studentId: 'student-1',
        ownerId: 'owner-1',
        studentName: 'Arjun Shah',
        ownerName: 'Meera Nair',
        roomId: 'room-1',
        roomTitle: 'Sunset Studio',
        canSend: true,
      ),
    ),
    adminCommissionPercentageProvider.overrideWith((ref) async => 30.0),
    adminMaintenanceModeProvider.overrideWith((ref) async => false),
    adminNotificationsEnabledProvider.overrideWith((ref) async => true),
    adminFeePayerProvider.overrideWith((ref) async => 'owner'),
    adminLaunchPincodeConfigProvider.overrideWith(
      (ref) => Stream.value(_launchConfig),
    ),
    unreadNotificationCountProvider.overrideWith((ref) => Stream.value(7)),
  ];
}

/// Renders one admin screen and returns the exception (if any).
Future<Object?> _render(
  WidgetTester tester, {
  required String path,
  required Widget screen,
  required Size size,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));

  final router = GoRouter(
    initialLocation: path,
    routes: [GoRoute(path: path, builder: (context, state) => screen)],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(
    ProviderScope(
      overrides: _overrides(),
      child: MaterialApp.router(
        routerConfig: router,
        theme: buildAppTheme(Brightness.light),
      ),
    ),
  );

  // Let every stream settle, the layout settle and the animations finish.
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));

  return tester.takeException();
}

/// Every admin screen with the path it lives on.
final List<MapEntry<String, Widget>> _screens = [
  MapEntry('/admin/dashboard', const AdminDashboardScreen()),
  MapEntry('/admin/users', const AdminUsersScreen()),
  MapEntry('/admin/rooms', const AdminRoomsScreen()),
  MapEntry('/admin/requests', const AdminRequestsScreen()),
  MapEntry('/admin/invoices', const AdminInvoicesScreen()),
  MapEntry('/admin/payments', const AdminPaymentsScreen()),
  MapEntry('/admin/analytics', const AdminAnalyticsScreen()),
  MapEntry('/admin/settings', const AdminSettingsScreen()),
  MapEntry('/admin/launch-areas', const AdminLaunchAreasScreen()),
];

void main() {
  group('the admin screens fit on a small phone', () {
    for (final entry in _screens) {
      testWidgets('${entry.key} has no overflow at 360x640', (tester) async {
        final error = await _render(
          tester,
          path: entry.key,
          screen: entry.value,
          size: const Size(360, 640),
        );

        expect(
          error,
          isNull,
          reason: '${entry.key} overflowed at 360x640: $error',
        );
      });
    }
  });

  group('the admin screens fit on a tablet', () {
    for (final entry in _screens) {
      testWidgets('${entry.key} has no overflow at 800x600', (tester) async {
        final error = await _render(
          tester,
          path: entry.key,
          screen: entry.value,
          size: const Size(800, 600),
        );

        expect(
          error,
          isNull,
          reason: '${entry.key} overflowed at 800x600: $error',
        );
      });
    }
  });

  testWidgets('payments show the resolved listing and participant names', (
    tester,
  ) async {
    final error = await _render(
      tester,
      path: '/admin/payments',
      screen: const AdminPaymentsScreen(),
      size: const Size(800, 600),
    );

    expect(error, isNull);
    expect(find.text('Room: Sunset Studio'), findsWidgets);
    expect(find.text('Student: Arjun Shah'), findsWidgets);
    expect(find.text('Owner: Meera Nair'), findsWidgets);
    expect(find.text('Room: room-1'), findsNothing);
    expect(find.text('Student: student-1'), findsNothing);
    expect(find.text('Owner: owner-1'), findsNothing);
  });

  group('the admin navigation', () {
    testWidgets('the drawer lists every destination', (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 640));
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
          overrides: _overrides(),
          child: MaterialApp.router(
            routerConfig: router,
            theme: buildAppTheme(Brightness.light),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      // Open the drawer — it holds all nine destinations.
      final scaffold = tester.state<ScaffoldState>(find.byType(Scaffold).first);
      scaffold.openDrawer();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(tester.takeException(), isNull);
      expect(find.byType(NavigationDrawer), findsOneWidget);

      // Every destination is reachable from the drawer.
      //
      // The drawer is a list, so the destinations at the bottom are only
      // built when they are scrolled into view.
      for (final destination in kAdminDestinations) {
        final label = find.text(destination.label);
        if (label.evaluate().isEmpty) {
          await tester.dragUntilVisible(
            label,
            find.byType(ListView).last,
            const Offset(0, -120),
          );
          await tester.pump();
        }
        expect(
          label,
          findsWidgets,
          reason: '"${destination.label}" is missing in the drawer',
        );
      }
    });
  });

  group('the admin area fits on every phone', () {
    // 320 px is the narrowest phone that is still in use; 414 px is a big
    // one. The dashboard and the drawer have to work on both.
    for (final width in [320.0, 360.0, 400.0, 414.0]) {
      testWidgets('the dashboard has no overflow at $width', (tester) async {
        final error = await _render(
          tester,
          path: '/admin/dashboard',
          screen: const AdminDashboardScreen(),
          size: Size(width, 1600),
        );

        expect(
          error,
          isNull,
          reason: 'The dashboard overflowed at $width: $error',
        );
      });

      testWidgets('the drawer has no overflow at $width', (tester) async {
        await tester.binding.setSurfaceSize(Size(width, 1400));
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
            overrides: _overrides(),
            child: MaterialApp.router(
              routerConfig: router,
              theme: buildAppTheme(Brightness.light),
            ),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));

        final scaffold = tester.state<ScaffoldState>(
          find.byType(Scaffold).first,
        );
        scaffold.openDrawer();
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));

        expect(
          tester.takeException(),
          isNull,
          reason: 'The drawer overflowed at $width',
        );
      });
    }
  });
}
