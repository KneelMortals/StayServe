import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/features/admin/presentation/providers/admin_providers.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_dashboard_screen.dart';
import 'package:stayserve/features/admin/presentation/widgets/admin_scaffold.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/notifications/presentation/providers/notification_providers.dart';
import 'package:stayserve/firebase/admin/admin_repository.dart';

/// An auth controller that only remembers that it was asked to sign out.
class _FakeAuthController extends AuthController {
  bool signedOut = false;

  @override
  Future<void> build() async {}

  @override
  Future<void> signOut() async {
    signedOut = true;
  }
}

/// A router with one route for every admin destination.
///
/// The screens use the real [AdminScaffold], so the drawer, the app bar and
/// the log out button are the ones of the app.
GoRouter _adminRouter({String initialLocation = '/admin/dashboard'}) {
  return GoRouter(
    initialLocation: initialLocation,
    routes: [
      for (final destination in kAdminDestinations)
        GoRoute(
          path: destination.route,
          builder: (context, state) => AdminScaffold(
            title: destination.label,
            body: Center(child: Text('SCREEN ${destination.label}')),
          ),
        ),
      GoRoute(
        path: '/login',
        builder: (context, state) =>
            const Scaffold(body: Center(child: Text('LOGIN'))),
      ),
    ],
  );
}

/// A phone that is tall enough for the whole drawer.
///
/// The drawer is a list — on a short phone the last entries are below the
/// fold, and a widget test only sees the ones that were built.
const Size _phone = Size(360, 1100);

Future<void> _pumpAdmin(
  WidgetTester tester, {
  required GoRouter router,
  _FakeAuthController? controller,
}) async {
  await tester.binding.setSurfaceSize(_phone);
  addTearDown(() => tester.binding.setSurfaceSize(null));

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        unreadNotificationCountProvider
            .overrideWith((ref) => Stream.value(0)),
        if (controller != null)
          authControllerProvider.overrideWith(() => controller),
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

/// Opens the drawer of the admin area.
Future<void> _openDrawer(WidgetTester tester) async {
  final scaffold = tester.state<ScaffoldState>(find.byType(Scaffold).first);
  scaffold.openDrawer();
  await tester.pumpAndSettle();
}

/// The key figures of the dashboard.
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

void main() {
  group('the admin navigation', () {
    test('the drawer order is not the order of the list', () {
      // The drawer groups the destinations, so its order differs from the
      // order of the list. Using the wrong one opened the wrong screen —
      // that is what made the admin panel look unresponsive.
      expect(
        kAdminDrawerDestinations.map((d) => d.route).toList(),
        isNot(kAdminDestinations.map((d) => d.route).toList()),
      );

      // The second entry of the drawer is "Analytics" …
      expect(kAdminDrawerDestinations[1].route, '/admin/analytics');
      // … while the second entry of the list is "Users".
      expect(kAdminDestinations[1].route, '/admin/users');

      // The two helpers therefore have to give different answers.
      expect(adminDrawerIndex('/admin/analytics'), 1);
      expect(adminDestinationIndex('/admin/analytics'), 6);
    });

    testWidgets('every entry of the drawer opens the screen it names',
        (tester) async {
      final router = _adminRouter();
      addTearDown(router.dispose);

      await _pumpAdmin(tester, router: router);

      for (final destination in kAdminDrawerDestinations) {
        // The drawer is opened again for every destination.
        await _openDrawer(tester);

        final entry = find.descendant(
          of: find.byType(NavigationDrawer),
          matching: find.text(destination.label),
        );
        expect(entry, findsOneWidget);

        await tester.tap(entry);
        await tester.pumpAndSettle();

        // The screen that belongs to the tapped entry — and not another one.
        expect(
          router.routerDelegate.currentConfiguration.uri.path,
          destination.route,
          reason: '"${destination.label}" has to open ${destination.route}',
        );
      }
    });

    testWidgets('the drawer highlights the screen the admin is on',
        (tester) async {
      final router = _adminRouter(initialLocation: '/admin/analytics');
      addTearDown(router.dispose);

      await _pumpAdmin(tester, router: router);
      await _openDrawer(tester);

      final drawer = tester.widget<NavigationDrawer>(
        find.byType(NavigationDrawer),
      );
      expect(drawer.selectedIndex, adminDrawerIndex('/admin/analytics'));
      expect(
        kAdminDrawerDestinations[drawer.selectedIndex!].route,
        '/admin/analytics',
      );
    });

    testWidgets('the quick actions of the dashboard open their screens',
        (tester) async {
      // A big screen, so that the whole dashboard is visible at once.
      await tester.binding.setSurfaceSize(const Size(900, 2000));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final router = GoRouter(
        initialLocation: '/admin/dashboard',
        routes: [
          GoRoute(
            path: '/admin/dashboard',
            builder: (context, state) => const AdminDashboardScreen(),
          ),
          for (final destination in kAdminDestinations)
            if (destination.route != '/admin/dashboard')
              GoRoute(
                path: destination.route,
                builder: (context, state) => Scaffold(
                  body: Center(child: Text('SCREEN ${destination.label}')),
                ),
              ),
        ],
      );
      addTearDown(router.dispose);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            adminStatsProvider.overrideWith((ref) => Stream.value(_stats())),
            unreadNotificationCountProvider
                .overrideWith((ref) => Stream.value(0)),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      const actions = {
        'Manage Users': '/admin/users',
        'Review Rooms': '/admin/rooms',
        'Review Requests': '/admin/requests',
        'Manage Invoices': '/admin/invoices',
        'Payments': '/admin/payments',
        'Analytics': '/admin/analytics',
        'Settings': '/admin/settings',
        'Launch Areas': '/admin/launch-areas',
      };

      for (final entry in actions.entries) {
        // The dashboard is opened again for every action.
        router.go('/admin/dashboard');
        await tester.pumpAndSettle();

        final tile = find.text(entry.key);
        expect(tile, findsOneWidget);

        await tester.tap(tile);
        await tester.pumpAndSettle();

        expect(
          router.routerDelegate.currentConfiguration.uri.path,
          entry.value,
          reason: '"${entry.key}" has to open ${entry.value}',
        );
      }
    });
  });

  group('the log out button of the admin', () {
    testWidgets('is only in the app bar', (tester) async {
      final router = _adminRouter();
      addTearDown(router.dispose);

      await _pumpAdmin(tester, router: router);

      // The app bar of every admin screen has the button.
      expect(find.byTooltip('Log out'), findsOneWidget);
      expect(find.byIcon(Icons.logout), findsOneWidget);

      // The drawer does **not** have one any more — there were two log out
      // buttons for the same thing, and everybody asked which one to press.
      await _openDrawer(tester);

      expect(
        find.descendant(
          of: find.byType(NavigationDrawer),
          matching: find.text('Log out'),
        ),
        findsNothing,
      );
      expect(
        find.descendant(
          of: find.byType(NavigationDrawer),
          matching: find.byIcon(Icons.logout),
        ),
        findsNothing,
      );
    });

    testWidgets('in the app bar signs the admin out', (tester) async {
      final controller = _FakeAuthController();
      final router = _adminRouter();
      addTearDown(router.dispose);

      await _pumpAdmin(tester, router: router, controller: controller);

      await tester.tap(find.byTooltip('Log out'));
      await tester.pumpAndSettle();

      expect(controller.signedOut, isTrue);
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/login',
      );
    });

    testWidgets('the drawer does not pop the page off the stack',
        (tester) async {
      // The drawer of a `Scaffold` is **not a route**. The old code closed
      // it with `Navigator.of(context).pop()`, which popped the *page* the
      // drawer belongs to. On the last page of the stack that leaves the
      // router without a single match and go_router shows its error page.
      final router = _adminRouter();
      addTearDown(router.dispose);

      await _pumpAdmin(tester, router: router);
      await _openDrawer(tester);

      final entry = find.descendant(
        of: find.byType(NavigationDrawer),
        matching: find.text('Users'),
      );
      await tester.tap(entry);
      await tester.pumpAndSettle();

      // The screen is open — and the router still has a match.
      expect(find.text('SCREEN Users'), findsOneWidget);
      expect(
        router.routerDelegate.currentConfiguration.matches,
        isNotEmpty,
        reason: 'the router must never be left without a page',
      );
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/admin/users',
      );
    });
  });
}
