// The button audit.
//
// Every screen of the student, the owner and the admin area is mounted with
// fake data and **every button on it is tapped**. A tap that throws — a
// `TextEditingController` that was used after it was disposed, a provider
// that was read with the wrong name, a route that does not exist — fails
// the test.
//
// The audit is deliberately mechanical: it does not know what a button is
// supposed to do, it only knows that pressing it must not break the app.
// The behaviour of the individual buttons is covered by the other test
// files.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/admin/presentation/providers/admin_providers.dart'
    as admin;
import 'package:stayserve/features/admin/presentation/screens/admin_analytics_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_dashboard_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_invoices_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_launch_areas_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_payments_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_requests_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_rooms_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_settings_screen.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_users_screen.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/auth/presentation/providers/remote_config_providers.dart';
import 'package:stayserve/features/auth/presentation/screens/forgot_password_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/login_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/otp_verification_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/register_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/role_selection_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/splash_screen.dart';
import 'package:stayserve/features/invoices/presentation/providers/invoice_providers.dart';
import 'package:stayserve/features/invoices/presentation/screens/invoice_detail_screen.dart';
import 'package:stayserve/features/joined_rooms/presentation/screens/joined_rooms_screen.dart';
import 'package:stayserve/features/messaging/presentation/providers/messaging_providers.dart';
import 'package:stayserve/features/messaging/presentation/screens/chat_screen.dart';
import 'package:stayserve/features/messaging/presentation/screens/conversations_screen.dart';
import 'package:stayserve/features/notifications/presentation/providers/notification_providers.dart';
import 'package:stayserve/features/notifications/presentation/screens/notifications_screen.dart';
import 'package:stayserve/features/owners/presentation/providers/owner_providers.dart'
    as owner;
import 'package:stayserve/features/owners/presentation/screens/create_room_screen.dart';
import 'package:stayserve/features/owners/presentation/screens/edit_room_screen.dart';
import 'package:stayserve/features/owners/presentation/screens/my_rooms_screen.dart';
import 'package:stayserve/features/owners/presentation/screens/owner_dashboard_screen.dart';
import 'package:stayserve/features/owners/presentation/screens/owner_invoices_screen.dart';
import 'package:stayserve/features/owners/presentation/screens/owner_profile_screen.dart';
import 'package:stayserve/features/owners/presentation/screens/owner_requests_screen.dart';
import 'package:stayserve/features/profile/presentation/screens/edit_profile_screen.dart';
import 'package:stayserve/features/reviews/presentation/providers/review_providers.dart';
import 'package:stayserve/features/reviews/presentation/screens/room_reviews_screen.dart';
import 'package:stayserve/features/students/presentation/providers/student_providers.dart'
    as student;
import 'package:stayserve/features/students/presentation/screens/room_detail_screen.dart';
import 'package:stayserve/features/students/presentation/screens/saved_rooms_screen.dart';
import 'package:stayserve/features/students/presentation/screens/student_home_screen.dart';
import 'package:stayserve/features/students/presentation/screens/student_profile_screen.dart';
import 'package:stayserve/features/students/presentation/screens/student_requests_screen.dart';
import 'package:stayserve/features/students/presentation/screens/student_search_screen.dart';
import 'package:stayserve/firebase/admin/admin_repository.dart';
import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/firebase/messaging/conversation_repository.dart';
import 'package:stayserve/firebase/notifications/notifications_repository.dart';
import 'package:stayserve/firebase/owner/owner_repository.dart';
import 'package:stayserve/firebase/otp/otp_service.dart';
import 'package:stayserve/firebase/payments/payment_repository.dart';
import 'package:stayserve/firebase/reviews/review_repository.dart';
import 'package:stayserve/firebase/settings/platform_settings.dart';
import 'package:stayserve/firebase/student/student_join_request_repository.dart';
import 'package:stayserve/firebase/student/student_repository.dart';
import 'package:stayserve/firebase/visits/visit_repository.dart';
import 'package:stayserve/models/launch_pincode_config.dart';
import 'package:stayserve/models/notification_model.dart';
import 'package:stayserve/services/location_service.dart';
import 'package:stayserve/services/user_location_provider.dart';

import 'support/audit_fakes.dart';

// ---------------------------------------------------------------------------
// The helpers of the audit.
// ---------------------------------------------------------------------------

/// Every route the app can navigate to.
///
/// The audit registers all of them so that a button which navigates does not
/// crash with "no routes for location" — the audit only checks the tap.
const List<String> kAuditRoutes = [
  '/room/:roomId',
  '/room/:roomId/reviews',
  '/conversations',
  '/chat/:conversationId',
  '/invoice/:invoiceId',
  '/notifications',
  '/forgot-password',
  '/login',
  '/student/home',
  '/student/search',
  '/student/saved',
  '/student/joined-rooms',
  '/student/requests',
  '/student/profile',
  '/student/profile/edit',
  '/owner/dashboard',
  '/owner/rooms',
  '/owner/rooms/create',
  '/owner/rooms/edit/:roomId',
  '/owner/requests',
  '/owner/invoices',
  '/owner/profile',
  '/owner/profile/edit',
  '/admin/dashboard',
  '/admin/users',
  '/admin/rooms',
  '/admin/requests',
  '/admin/invoices',
  '/admin/payments',
  '/admin/analytics',
  '/admin/settings',
  '/admin/launch-areas',
];

/// Whether the widget is something the user can press.
bool _isTappable(Widget widget) {
  if (widget is ButtonStyleButton) return widget.onPressed != null;
  if (widget is IconButton) return widget.onPressed != null;
  if (widget is FloatingActionButton) return widget.onPressed != null;
  if (widget is Switch) return widget.onChanged != null;
  if (widget is Checkbox) return widget.onChanged != null;
  if (widget is ChoiceChip) return widget.onSelected != null;
  if (widget is FilterChip) return widget.onSelected != null;
  if (widget is InputChip) return widget.onSelected != null;
  if (widget is ListTile) return widget.onTap != null;
  if (widget is InkWell) return widget.onTap != null;
  if (widget is InkResponse) return widget.onTap != null;
  // The callback of a `PopupMenuButton` and of a `DropdownButton` is typed
  // with the type of its entries — it cannot be read through the untyped
  // base class without a runtime type error.
  if (widget is PopupMenuButton) return (widget as dynamic).onSelected != null;
  if (widget is DropdownButton) return (widget as dynamic).onChanged != null;
  return false;
}

/// Whether the element sits inside another tappable widget.
///
/// The `ListTile` of a profile builds an `InkWell` of its own — tapping
/// both would test the same thing twice.
bool _hasTappableAncestor(Element element) {
  var found = false;
  element.visitAncestorElements((ancestor) {
    final widget = ancestor.widget;
    if (widget is ListTile || widget is ButtonStyleButton) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/// All the buttons of the screen, in the order they appear in the tree.
List<Element> _tappableElements() {
  final finder = find.byWidgetPredicate(_isTappable);
  final result = <Element>[];
  for (final element in finder.evaluate()) {
    final widget = element.widget;
    final isInk = widget is InkWell || widget is InkResponse;
    if (isInk && _hasTappableAncestor(element)) continue;
    result.add(element);
  }
  return result;
}

/// A short description of a button — used in the failure messages.
String _describe(Element element) {
  final widget = element.widget;
  final type = widget.runtimeType.toString();

  // The label of the button — the text below it.
  String label = '';
  element.visitChildren((child) {
    if (label.isNotEmpty) return;
    final childWidget = child.widget;
    if (childWidget is Text && (childWidget.data ?? '').isNotEmpty) {
      label = childWidget.data!;
    }
  });
  if (label.isEmpty) {
    element.visitAncestorElements((ancestor) {
      if (label.isNotEmpty) return false;
      final ancestorWidget = ancestor.widget;
      if (ancestorWidget is Text && (ancestorWidget.data ?? '').isNotEmpty) {
        label = ancestorWidget.data!;
      }
      return true;
    });
  }
  if (label.isEmpty) {
    try {
      final match = RegExp(r"'([^']{1,60})'").firstMatch(widget.toString());
      if (match != null) label = match.group(1)!;
    } catch (_) {
      // The description is a nicety — it must never break the audit.
    }
  }

  return label.isEmpty ? type : '$type("$label")';
}

/// Pumps a few frames.
///
/// `pumpAndSettle` is not used: a screen with a running animation (a
/// progress indicator, a blinking cursor) never settles and the test would
/// time out instead of failing.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 120));
  }
}

/// Mounts [build] and taps every button of it.
Future<void> auditScreen(
  WidgetTester tester, {
  required String name,
  required Widget Function(BuildContext context) build,
  required List<Override> overrides,
  int minButtons = 1,
  int tabCount = 1,
}) async {
  final router = GoRouter(
    // The audited screen sits on top of a second route: some screens pop
    // themselves (the room form does that when the listing was saved) and
    // popping the **last** route of the stack leaves the navigator without
    // a single page — go_router then disposes it and the audit would report
    // an error that the user never sees.
    initialLocation: '/base/audit',
    routes: [
      GoRoute(
        path: '/base',
        builder: (context, state) => const Scaffold(
          body: Center(child: Text('audit base page')),
        ),
        routes: [
          GoRoute(
            path: 'audit',
            builder: (context, state) => build(context),
          ),
        ],
      ),
      for (final path in kAuditRoutes)
        GoRoute(
          path: path,
          builder: (context, state) => const Scaffold(
            body: Center(child: Text('audit placeholder')),
          ),
        ),
    ],
    errorBuilder: (context, state) => const Scaffold(
      body: Center(child: Text('audit error page')),
    ),
  );
  // The router is **not** disposed by hand: the widget tree owns the
  // navigator of the router, and disposing the router as well would dispose
  // the navigator twice ("!_debugLocked" assertion).

  Widget app() => ProviderScope(
        overrides: overrides,
        child: MaterialApp.router(routerConfig: router),
      );

  /// Builds the screen and shows the tab [tab].
  Future<void> showTab(int tab) async {
    router.go('/base/audit');
    // The navigation has to be finished before the tree is rebuilt:
    // replacing the tree while a route is still moving disposes the
    // navigator while it is locked.
    await _settle(tester);
    await tester.pumpWidget(app());
    await _settle(tester);

    if (tab == 0) return;

    final tabBar = find.byType(TabBar);
    expect(
      tabBar.evaluate(),
      isNotEmpty,
      reason: '$name: the screen should have $tabCount tabs, but it has no '
          'tab bar at all',
    );
    final controller = DefaultTabController.of(tester.element(tabBar));
    controller.animateTo(tab);
    await _settle(tester);
  }

  await showTab(0);

  final total = <int>[];
  for (var tab = 0; tab < tabCount; tab++) {
    if (tab > 0) await showTab(tab);

    final buttons = _tappableElements();
    total.add(buttons.length);
    expect(
      buttons.length,
      greaterThanOrEqualTo(minButtons),
      reason: '$name: the screen does not contain a single button — '
          'the audit would not check anything at all',
    );

    for (var index = 0; index < buttons.length; index++) {
      // Every tap starts from a **fresh** screen: the router is put back to
      // the audited route and the widget tree is rebuilt, so a button that
      // opened a dialog or navigated away cannot influence the next tap.
      await showTab(tab);

      final current = _tappableElements();
      expect(
        current.length,
        greaterThan(index),
        reason: '$name: button #$index is gone after the rebuild',
      );

      final finder =
          find.byElementPredicate((e) => identical(e, current[index]));
      final description = _describe(current[index]);

      await tester.ensureVisible(finder);
      await tester.pump(const Duration(milliseconds: 50));

      await tester.tap(finder, warnIfMissed: false);
      await _settle(tester);

      final error = tester.takeException();
      expect(
        error,
        isNull,
        reason: '$name: the button $description ( #$index ) threw when it was '
            'tapped',
      );
    }
  }

  // The number of buttons that are really tapped is printed — it shows how
  // much of the app the audit really covers.
  // ignore: avoid_print
  print('button-audit: $name — ${total.join(" + ")} buttons');

  // Leave no dialog and no route behind: an open modal route keeps a
  // performance-mode request alive, and the test framework reports that as
  // an error at the end of the test.
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump();
}

// ---------------------------------------------------------------------------
// The fakes of the providers.
// ---------------------------------------------------------------------------

/// An admin controller whose every action succeeds.
class FakeAdminController extends admin.AdminController {
  @override
  Future<String?> toggleUserActive(String uid, bool isActive) async => null;

  @override
  Future<String?> updateUserRole(String uid, UserRole newRole) async => null;

  @override
  Future<String?> deleteUser(String uid) async => null;

  @override
  Future<String?> scheduleUserDeletion(String uid, {int days = 7}) async =>
      null;

  @override
  Future<String?> cancelUserDeletion(String uid) async => null;

  @override
  Future<String?> banUser(String uid, {String? reason}) async => null;

  @override
  Future<String?> unbanUser(String uid) async => null;

  @override
  Future<String?> updateRoomStatus(String roomId, RoomStatus status) async =>
      null;

  @override
  Future<String?> deleteRoom(String roomId) async => null;

  @override
  Future<String?> adminReviewRequest(
    String requestId, {
    required bool approve,
    String? rejectionReason,
  }) async =>
      null;

  @override
  Future<String?> markInvoicePaid(
    String invoiceId, {
    String? paymentReference,
    String? paymentMethod,
    String? upiTransactionId,
  }) async =>
      null;

  @override
  Future<String?> cancelInvoice(String invoiceId) async => null;

  @override
  Future<String?> updateCommissionPercentage(double percentage) async => null;

  @override
  Future<String?> setMaintenanceMode(bool enabled) async => null;

  @override
  Future<String?> setNotificationsEnabled(bool enabled) async => null;

  @override
  Future<String?> setFeePayer(String payer) async => null;

  @override
  Future<String?> runMaintenanceTask(String task) async => null;

  @override
  Future<String?> updateLaunchPincodeConfig({
    required List<String> enabledPincodes,
    required List<String> disabledPincodes,
    required String mode,
  }) async =>
      null;
}

/// The statistics of the admin dashboard.
AdminStats auditStats() {
  return AdminStats(
    totalUsers: 5,
    totalStudents: 3,
    totalOwners: 2,
    totalRooms: 4,
    availableRooms: 2,
    joinedRooms: 1,
    pendingConfirmations: 1,
    pendingInvoices: 1,
    totalRevenue: 1500,
  );
}

/// The overrides that every screen needs.
List<Override> commonOverrides({
  UserRole role = UserRole.student,
  String uid = 'student-1',
}) {
  final user = auditUser(
    uid: uid,
    role: role,
    name: role == UserRole.owner ? 'Test Owner' : 'Test Student',
  );

  return [
    currentUserProvider.overrideWithValue(
      auditMockUser(uid: uid, email: user.email),
    ),
    authStateProvider.overrideWith((ref) => Stream.value(auditMockUser(
      uid: uid,
      email: user.email,
    ))),
    authSessionProvider.overrideWith(
      (ref) => Stream.value(AuthSession(
        user: auditMockUser(uid: uid, email: user.email),
        profile: user,
      )),
    ),
    authControllerProvider.overrideWith(() => FakeAuthController()),
    userProfileProvider.overrideWith((ref, id) async => user),
    userLocationProvider.overrideWith(() => FakeUserLocationNotifier()),
    notificationsRepositoryProvider
        .overrideWithValue(FakeNotificationsRepository()),
    notificationsProvider.overrideWith(
      (ref) => Stream.value(<NotificationModel>[]),
    ),
    unreadNotificationCountProvider.overrideWith((ref) => Stream.value(0)),
  ];
}

// ---------------------------------------------------------------------------
// The audit itself.
// ---------------------------------------------------------------------------

void main() {
  // A tall surface so that the buttons below the fold are built as well —
  // a lazy list only builds the rows it has shown so far.
  setUp(() {
    // (the size is set per test, see `_setSurface`)
  });

  group('admin panel — every button works', () {
    testWidgets('dashboard', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'AdminDashboardScreen',
        build: (_) => const AdminDashboardScreen(),
        overrides: [
          ...commonOverrides(role: UserRole.admin, uid: 'admin-1'),
          admin.adminStatsProvider
              .overrideWith((ref) => Stream.value(auditStats())),
        ],
      );
    });

    testWidgets('users', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'AdminUsersScreen',
        build: (_) => const AdminUsersScreen(),
        overrides: [
          ...commonOverrides(role: UserRole.admin, uid: 'admin-1'),
          adminRepositoryProvider
              .overrideWithValue(FakeAdminRepository()),
          admin.adminControllerProvider
              .overrideWith(() => FakeAdminController()),
          admin.adminUsersProvider.overrideWith(
            (ref, roleFilter) => Stream.value([
              auditUser(uid: 'student-1'),
              auditUser(uid: 'owner-1', role: UserRole.owner),
            ]),
          ),
        ],
      );
    });

    testWidgets('rooms', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'AdminRoomsScreen',
        build: (_) => const AdminRoomsScreen(),
        overrides: [
          ...commonOverrides(role: UserRole.admin, uid: 'admin-1'),
          adminRepositoryProvider
              .overrideWithValue(FakeAdminRepository()),
          admin.adminControllerProvider
              .overrideWith(() => FakeAdminController()),
          admin.adminRoomsProvider.overrideWith(
            (ref, statusFilter) => Stream.value([
              auditRoom(),
              auditRoom(roomId: 'room-2', title: 'Second Room'),
            ]),
          ),
        ],
      );
    });

    testWidgets('requests', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'AdminRequestsScreen',
        build: (_) => const AdminRequestsScreen(),
        overrides: [
          ...commonOverrides(role: UserRole.admin, uid: 'admin-1'),
          adminRepositoryProvider
              .overrideWithValue(FakeAdminRepository()),
          admin.adminControllerProvider
              .overrideWith(() => FakeAdminController()),
          admin.adminJoinRequestsProvider.overrideWith(
            (ref, statusFilter) => Stream.value([
              auditRequest(),
              auditRequest(
                requestId: 'request-2',
                status: JoinRequestStatus.ownerConfirmed,
              ),
            ]),
          ),
        ],
      );
    });

    testWidgets('invoices', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'AdminInvoicesScreen',
        build: (_) => const AdminInvoicesScreen(),
        tabCount: 3,
        overrides: [
          ...commonOverrides(role: UserRole.admin, uid: 'admin-1'),
          adminRepositoryProvider
              .overrideWithValue(FakeAdminRepository()),
          admin.adminControllerProvider
              .overrideWith(() => FakeAdminController()),
          admin.adminInvoicesProvider.overrideWith(
            (ref, statusFilter) => Stream.value([
              auditInvoice(),
              auditInvoice(
                invoiceId: 'INV-request-2',
                status: InvoiceStatus.paid,
              ),
            ]),
          ),
        ],
      );
    });

    testWidgets('payments', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'AdminPaymentsScreen',
        build: (_) => const AdminPaymentsScreen(),
        tabCount: 3,
        overrides: [
          ...commonOverrides(role: UserRole.admin, uid: 'admin-1'),
          adminRepositoryProvider
              .overrideWithValue(FakeAdminRepository()),
          admin.adminControllerProvider
              .overrideWith(() => FakeAdminController()),
          admin.adminPaymentsProvider.overrideWith(
            (ref, statusFilter) => Stream.value([
              auditPayment(),
              auditPayment(
                paymentId: 'payment-2',
                status: PaymentStatus.verified,
              ),
            ]),
          ),
        ],
      );
    });

    testWidgets('settings', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'AdminSettingsScreen',
        build: (_) => const AdminSettingsScreen(),
        overrides: [
          ...commonOverrides(role: UserRole.admin, uid: 'admin-1'),
          adminRepositoryProvider
              .overrideWithValue(FakeAdminRepository()),
          admin.adminControllerProvider
              .overrideWith(() => FakeAdminController()),
          admin.adminCommissionPercentageProvider
              .overrideWith((ref) async => 30.0),
          admin.adminMaintenanceModeProvider
              .overrideWith((ref) async => false),
          admin.adminNotificationsEnabledProvider
              .overrideWith((ref) async => true),
          admin.adminFeePayerProvider.overrideWith((ref) async => 'student'),
        ],
      );
    });

    testWidgets('launch areas', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'AdminLaunchAreasScreen',
        build: (_) => const AdminLaunchAreasScreen(),
        overrides: [
          ...commonOverrides(role: UserRole.admin, uid: 'admin-1'),
          adminRepositoryProvider
              .overrideWithValue(FakeAdminRepository()),
          admin.adminControllerProvider
              .overrideWith(() => FakeAdminController()),
          admin.adminLaunchPincodeConfigProvider.overrideWith(
            (ref) => Stream.value(const LaunchPincodeConfig(
              enabledPincodes: ['560001'],
              disabledPincodes: ['560002'],
              mode: 'whitelist',
              configured: true,
            )),
          ),
        ],
      );
    });

    testWidgets('analytics', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'AdminAnalyticsScreen',
        build: (_) => const AdminAnalyticsScreen(),
        overrides: [
          ...commonOverrides(role: UserRole.admin, uid: 'admin-1'),
          admin.adminStatsProvider
              .overrideWith((ref) => Stream.value(auditStats())),
          admin.adminInvoicesProvider.overrideWith(
            (ref, statusFilter) => Stream.value([
              auditInvoice(),
              auditInvoice(
                invoiceId: 'INV-request-2',
                status: InvoiceStatus.paid,
              ),
            ]),
          ),
        ],
      );
    });
  });

  group('owner panel — every button works', () {
    testWidgets('dashboard', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'OwnerDashboardScreen',
        build: (_) => const OwnerDashboardScreen(),
        overrides: [
          ...commonOverrides(role: UserRole.owner, uid: 'owner-1'),
          ownerRepositoryProvider
              .overrideWithValue(FakeOwnerRepository()),
          owner.myRoomsProvider
              .overrideWith((ref) => Stream.value([auditRoom()])),
          owner.myJoinRequestsProvider.overrideWith(
            (ref) => Stream.value([
              auditRequest(),
              auditRequest(
                requestId: 'request-2',
                status: JoinRequestStatus.ownerConfirmed,
              ),
            ]),
          ),
          owner.myInvoicesProvider
              .overrideWith((ref) => Stream.value([auditInvoice()])),
        ],
      );
    });

    testWidgets('requests', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'OwnerRequestsScreen',
        build: (_) => const OwnerRequestsScreen(),
        tabCount: 2,
        overrides: [
          ...commonOverrides(role: UserRole.owner, uid: 'owner-1'),
          ownerRepositoryProvider
              .overrideWithValue(FakeOwnerRepository()),
          owner.myJoinRequestsProvider.overrideWith(
            (ref) => Stream.value([
              auditRequest(),
              auditRequest(
                requestId: 'request-2',
                status: JoinRequestStatus.ownerConfirmed,
              ),
              auditRequest(
                requestId: 'request-3',
                status: JoinRequestStatus.studentConfirmed,
              ),
            ]),
          ),
        ],
      );
    });

    testWidgets('my rooms', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'MyRoomsScreen',
        build: (_) => const MyRoomsScreen(),
        overrides: [
          ...commonOverrides(role: UserRole.owner, uid: 'owner-1'),
          ownerRepositoryProvider
              .overrideWithValue(FakeOwnerRepository()),
          owner.myRoomsProvider.overrideWith(
            (ref) => Stream.value([
              auditRoom(),
              auditRoom(
                roomId: 'room-2',
                title: 'Second Room',
                status: RoomStatus.occupied,
              ),
            ]),
          ),
        ],
      );
    });

    testWidgets('invoices', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'OwnerInvoicesScreen',
        build: (_) => const OwnerInvoicesScreen(),
        tabCount: 3,
        overrides: [
          ...commonOverrides(role: UserRole.owner, uid: 'owner-1'),
          owner.myInvoicesProvider.overrideWith(
            (ref) => Stream.value([
              auditInvoice(),
              auditInvoice(
                invoiceId: 'INV-request-2',
                status: InvoiceStatus.paid,
              ),
            ]),
          ),
        ],
      );
    });

    testWidgets('profile', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'OwnerProfileScreen',
        build: (_) => const OwnerProfileScreen(),
        overrides: commonOverrides(role: UserRole.owner, uid: 'owner-1'),
      );
    });

    testWidgets('create a room', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'CreateRoomScreen',
        build: (_) => const CreateRoomScreen(),
        overrides: [
          ...commonOverrides(role: UserRole.owner, uid: 'owner-1'),
          ownerRepositoryProvider.overrideWithValue(FakeOwnerRepository()),
          owner.myRoomsProvider
              .overrideWith((ref) => Stream.value([auditRoom()])),
        ],
      );
    });

    testWidgets('edit a room', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'EditRoomScreen',
        build: (_) => const EditRoomScreen(roomId: 'room-1'),
        overrides: [
          ...commonOverrides(role: UserRole.owner, uid: 'owner-1'),
          ownerRepositoryProvider.overrideWithValue(FakeOwnerRepository()),
          owner.myRoomsProvider
              .overrideWith((ref) => Stream.value([auditRoom()])),
        ],
      );
    });
  });

  group('student panel — every button works', () {
    testWidgets('home', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'StudentHomeScreen',
        build: (_) => const StudentHomeScreen(),
        overrides: [
          ...commonOverrides(),
          studentRepositoryProvider
              .overrideWithValue(FakeStudentRepository()),
          student.roomsSearchProvider
              .overrideWith((ref) => Stream.value([auditRoom()])),
          student.myJoinRequestsProvider
              .overrideWith((ref) => Stream.value([auditRequest()])),
        ],
      );
    });

    testWidgets('search', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'StudentSearchScreen',
        build: (_) => const StudentSearchScreen(),
        overrides: [
          ...commonOverrides(),
          studentRepositoryProvider
              .overrideWithValue(FakeStudentRepository()),
          student.filteredRoomsProvider
              .overrideWith((ref) => Stream.value([auditRoom()])),
        ],
      );
    });

    testWidgets('requests', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'StudentRequestsScreen',
        build: (_) => const StudentRequestsScreen(),
        overrides: [
          ...commonOverrides(),
          student.myJoinRequestsProvider.overrideWith(
            (ref) => Stream.value([
              auditRequest(),
              auditRequest(
                requestId: 'request-2',
                status: JoinRequestStatus.ownerConfirmed,
              ),
              auditRequest(
                requestId: 'request-3',
                status: JoinRequestStatus.studentConfirmed,
              ),
            ]),
          ),
          student.roomProvider
              .overrideWith((ref, roomId) => Stream.value(auditRoom())),
          studentJoinRequestProvider
              .overrideWithValue(FakeStudentJoinRequestRepository()),
          paymentRepositoryProvider
              .overrideWithValue(FakePaymentRepository()),
          visitRepositoryProvider.overrideWithValue(FakeVisitRepository()),
        ],
      );
    });

    testWidgets('saved rooms', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'SavedRoomsScreen',
        build: (_) => const SavedRoomsScreen(),
        overrides: [
          ...commonOverrides(),
          studentRepositoryProvider
              .overrideWithValue(FakeStudentRepository()),
          student.savedRoomsProvider
              .overrideWith((ref) => Stream.value([auditRoom()])),
        ],
      );
    });

    testWidgets('joined rooms', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'JoinedRoomsScreen',
        build: (_) => const JoinedRoomsScreen(),
        tabCount: 2,
        overrides: [
          ...commonOverrides(),
          student.myJoinedRoomsProvider
              .overrideWith((ref) => Stream.value([auditRoom()])),
          student.myJoinRequestsProvider
              .overrideWith((ref) => Stream.value([auditRequest()])),
          student.roomProvider
              .overrideWith((ref, roomId) => Stream.value(auditRoom())),
          studentJoinRequestProvider
              .overrideWithValue(FakeStudentJoinRequestRepository()),
        ],
      );
    });

    testWidgets('profile', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'StudentProfileScreen',
        build: (_) => const StudentProfileScreen(),
        overrides: commonOverrides(),
      );
    });

    testWidgets('room detail', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'RoomDetailScreen',
        build: (_) => const RoomDetailScreen(roomId: 'room-1'),
        overrides: [
          ...commonOverrides(),
          student.roomProvider
              .overrideWith((ref, roomId) => Stream.value(auditRoom())),
          student.myJoinRequestsProvider
              .overrideWith((ref) => Stream.value([auditRequest()])),
          studentRepositoryProvider
              .overrideWithValue(FakeStudentRepository()),
          studentJoinRequestProvider
              .overrideWithValue(FakeStudentJoinRequestRepository()),
          conversationRepositoryProvider
              .overrideWithValue(FakeConversationRepository()),
          visitRepositoryProvider.overrideWithValue(FakeVisitRepository()),
          reviewRepositoryProvider
              .overrideWithValue(FakeReviewRepository()),
          roomReviewsProvider.overrideWith(
            (ref, roomId) => Stream.value([auditReview()]),
          ),
          myRoomReviewProvider
              .overrideWith((ref, roomId) => Stream.value(auditReview())),
          platformSettingsProvider.overrideWith(
            (ref) async => const PlatformSettings(feePercentage: 30),
          ),
        ],
      );
    });

    testWidgets('reviews of a room', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'RoomReviewsScreen',
        build: (_) => const RoomReviewsScreen(roomId: 'room-1'),
        overrides: [
          ...commonOverrides(),
          // The owner accepted the request — only then the student may
          // write a review, so the form (and its buttons) is shown.
          student.myJoinRequestsProvider.overrideWith(
            (ref) => Stream.value([
              auditRequest(status: JoinRequestStatus.ownerConfirmed),
            ]),
          ),
          reviewRepositoryProvider
              .overrideWithValue(FakeReviewRepository()),
          roomReviewsProvider.overrideWith(
            (ref, roomId) => Stream.value([auditReview()]),
          ),
          myRoomReviewProvider
              .overrideWith((ref, roomId) => Stream.value(auditReview())),
        ],
      );
    });

    testWidgets('notifications', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'NotificationsScreen',
        build: (_) => const NotificationsScreen(),
        overrides: [
          ...commonOverrides(),
          notificationsRepositoryProvider
              .overrideWithValue(FakeNotificationsRepository()),
          notificationsProvider.overrideWith(
            (ref) => Stream.value([
              NotificationModel(
                notificationId: 'notification-1',
                userId: 'student-1',
                type: NotificationType.joinConfirmed,
                title: 'Your request was accepted',
                body: 'The owner accepted your request.',
                data: const {'roomId': 'room-1'},
                createdAt: auditNow(),
              ),
            ]),
          ),
        ],
      );
    });

    testWidgets('conversations', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'ConversationsScreen',
        build: (_) => const ConversationsScreen(),
        overrides: [
          ...commonOverrides(),
          conversationRepositoryProvider
              .overrideWithValue(FakeConversationRepository()),
          conversationsProvider
              .overrideWith((ref) => Stream.value([auditConversation()])),
        ],
      );
    });

    testWidgets('invoice detail', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'InvoiceDetailScreen',
        build: (_) => const InvoiceDetailScreen(invoiceId: 'INV-request-1'),
        // The invoice detail screen is a read-only view — it really has no
        // button at all (the app bar of the scaffold draws the back button).
        minButtons: 0,
        overrides: [
          ...commonOverrides(role: UserRole.admin, uid: 'admin-1'),
          invoiceProvider.overrideWith(
            (ref, invoiceId) => Stream.value(auditInvoice()),
          ),
        ],
      );
    });

    testWidgets('edit profile', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'EditProfileScreen',
        build: (_) => const EditProfileScreen(),
        overrides: [
          ...commonOverrides(),
          authRepositoryProvider.overrideWithValue(FakeAuthRepository()),
        ],
      );
    });

    testWidgets('chat', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'ChatScreen',
        build: (_) => const ChatScreen(
          conversationId: 'conversation-1',
          peerId: 'owner-1',
        ),
        overrides: [
          ...commonOverrides(),
          conversationRepositoryProvider
              .overrideWithValue(FakeConversationRepository()),
          conversationsProvider
              .overrideWith((ref) => Stream.value([auditConversation()])),
          messagesProvider.overrideWith(
            (ref, conversationId) => Stream.value([auditMessage()]),
          ),
        ],
      );
    });
  });

  group('the sign-up and sign-in screens — every button works', () {
    testWidgets('login', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'LoginScreen',
        build: (_) => const LoginScreen(),
        overrides: [
          authControllerProvider.overrideWith(() => FakeAuthController()),
        ],
      );
    });

    testWidgets('register', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'RegisterScreen',
        build: (_) => const RegisterScreen(),
        overrides: [
          authControllerProvider.overrideWith(() => FakeAuthController()),
          otpServiceProvider.overrideWithValue(FakeOtpService()),
        ],
      );
    });

    testWidgets('forgot password', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'ForgotPasswordScreen',
        build: (_) => const ForgotPasswordScreen(),
        overrides: [
          authControllerProvider.overrideWith(() => FakeAuthController()),
        ],
      );
    });

    testWidgets('role selection', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'RoleSelectionScreen',
        build: (_) => const RoleSelectionScreen(),
        overrides: [
          authControllerProvider.overrideWith(() => FakeAuthController()),
          authRepositoryProvider.overrideWithValue(FakeAuthRepository()),
          otpServiceProvider.overrideWithValue(FakeOtpService()),
        ],
      );
    });

    testWidgets('the verification code', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'OtpVerificationScreen',
        build: (_) => const OtpVerificationScreen(
          channel: OtpChannel.email,
          identifier: 'student@example.test',
        ),
        overrides: [
          otpServiceProvider.overrideWithValue(FakeOtpService()),
        ],
      );
    });

    testWidgets('the splash screen with a forced update', (tester) async {
      await _setSurface(tester);
      await auditScreen(
        tester,
        name: 'SplashScreen (forced update)',
        build: (_) => const SplashScreen(),
        overrides: [
          forceUpdateCheckProvider.overrideWith(
            (ref) async => ForceUpdateResult(
              isUpdateRequired: true,
              isForceUpdate: true,
              currentVersion: '1.0.0',
              latestVersion: '2.0.0',
              minVersion: '2.0.0',
              message: 'Please update StayServe.',
              updateUrlAndroid: 'https://example.test/update',
              updateUrlIos: 'https://example.test/update',
              maintenanceMode: false,
              maintenanceMessage: '',
            ),
          ),
          adminRepositoryProvider.overrideWithValue(FakeAdminRepository()),
          locationServiceProvider.overrideWithValue(FakeLocationService()),
          authSessionProvider.overrideWith((ref) => Stream.value(null)),
        ],
      );
    });
  });
}

/// Makes the surface of the test tall enough that the whole screen is
/// built — a lazy list only builds the rows it has shown so far.
Future<void> _setSurface(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1200, 3000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}
