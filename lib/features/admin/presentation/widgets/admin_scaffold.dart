import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../auth/presentation/providers/auth_provider.dart';
import '../../../notifications/presentation/widgets/notification_bell.dart';

/// The destinations of the admin area.
///
/// They are defined **once** and used by the drawer (phone), the rail
/// (tablet) and the dashboard — so the navigation can never get out of sync
/// with itself.
class AdminDestination {
  final String route;
  final String label;
  final IconData icon;
  final IconData selectedIcon;

  const AdminDestination({
    required this.route,
    required this.label,
    required this.icon,
    required this.selectedIcon,
  });
}

/// The groups of the admin navigation.
class AdminNavGroup {
  final String title;
  final List<AdminDestination> destinations;

  const AdminNavGroup({required this.title, required this.destinations});
}

/// Every admin destination, in the order they appear in the navigation.
const List<AdminDestination> kAdminDestinations = [
  AdminDestination(
    route: '/admin/dashboard',
    label: 'Dashboard',
    icon: Icons.dashboard_outlined,
    selectedIcon: Icons.dashboard,
  ),
  AdminDestination(
    route: '/admin/users',
    label: 'Users',
    icon: Icons.people_outline,
    selectedIcon: Icons.people,
  ),
  AdminDestination(
    route: '/admin/rooms',
    label: 'Rooms',
    icon: Icons.apartment_outlined,
    selectedIcon: Icons.apartment,
  ),
  AdminDestination(
    route: '/admin/requests',
    label: 'Requests',
    icon: Icons.assignment_outlined,
    selectedIcon: Icons.assignment,
  ),
  AdminDestination(
    route: '/admin/invoices',
    label: 'Invoices',
    icon: Icons.receipt_outlined,
    selectedIcon: Icons.receipt,
  ),
  AdminDestination(
    route: '/admin/payments',
    label: 'Payments',
    icon: Icons.payments_outlined,
    selectedIcon: Icons.payments,
  ),
  AdminDestination(
    route: '/admin/analytics',
    label: 'Analytics',
    icon: Icons.analytics_outlined,
    selectedIcon: Icons.analytics,
  ),
  AdminDestination(
    route: '/admin/settings',
    label: 'Settings',
    icon: Icons.settings_outlined,
    selectedIcon: Icons.settings,
  ),
  AdminDestination(
    route: '/admin/launch-areas',
    label: 'Launch Areas',
    icon: Icons.location_on_outlined,
    selectedIcon: Icons.location_on,
  ),
];

/// The navigation of the admin area, split into groups.
///
/// The list is **not** a `const` list: it refers to the entries of
/// [kAdminDestinations] by index, and a const list cannot be indexed in a
/// constant expression.
final List<AdminNavGroup> kAdminNavGroups = [
  AdminNavGroup(
    title: 'Overview',
    destinations: [kAdminDestinations[0], kAdminDestinations[6]],
  ),
  AdminNavGroup(
    title: 'People & listings',
    destinations: [kAdminDestinations[1], kAdminDestinations[2], kAdminDestinations[3]],
  ),
  AdminNavGroup(
    title: 'Money',
    destinations: [kAdminDestinations[4], kAdminDestinations[5]],
  ),
  AdminNavGroup(
    title: 'Configuration',
    destinations: [kAdminDestinations[7], kAdminDestinations[8]],
  ),
];

/// Every destination in the order the **drawer** shows them.
///
/// The drawer groups the destinations (Overview / People & listings / …),
/// so its order is **not** the order of [kAdminDestinations].
///
/// That difference matters: `NavigationDrawer.onDestinationSelected` hands
/// over the index of the tapped destination — counted in the order of the
/// drawer, without the group headings. Using that index on
/// [kAdminDestinations] opened the **wrong screen** (the second entry of
/// the drawer is "Analytics", but the second entry of the list is "Users"),
/// which made the admin panel look completely unresponsive.
final List<AdminDestination> kAdminDrawerDestinations = [
  for (final group in kAdminNavGroups) ...group.destinations,
];

/// The index of the destination that belongs to [location].
///
/// A location that belongs to no destination (for example the error page)
/// falls back to the dashboard.
int adminDestinationIndex(String location) {
  final index = kAdminDestinations.indexWhere(
    (destination) => location.startsWith(destination.route),
  );
  return index < 0 ? 0 : index;
}

/// The index of the destination that belongs to [location] **in the drawer**.
///
/// The drawer highlights the destination of the screen the admin is on — it
/// has to use the order of the drawer, not the order of the list.
int adminDrawerIndex(String location) {
  final index = kAdminDrawerDestinations.indexWhere(
    (destination) => location.startsWith(destination.route),
  );
  return index < 0 ? 0 : index;
}

/// The drawer of the admin area — the navigation on a phone.
///
/// Nine destinations in a vertical rail squeezed the content of every screen
/// into a third of the width, which is what made the admin panel look
/// broken. On a phone the navigation lives in a drawer instead, so the
/// content gets the full width.
class AdminNavigationDrawer extends ConsumerWidget {
  final String location;

  const AdminNavigationDrawer({required this.location, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    // The index has to be the one of the **drawer** — the drawer groups the
    // destinations, so its order differs from the order of the list.
    final selected = adminDrawerIndex(location);

    return NavigationDrawer(
      selectedIndex: selected,
      onDestinationSelected: (index) {
        // Close the **drawer** — not the page.
        //
        // `Navigator.of(context).pop()` used to close the drawer, but the
        // drawer of a `Scaffold` is **not a route**: there is nothing to pop
        // for it. What the pop did instead was pop the *page* the drawer
        // belongs to. On the last page of the stack that leaves the router
        // without a single match, and go_router then shows its error page
        // ("Page Not Found") — the admin was kicked out of the app with an
        // error instead of the screen they picked.
        Scaffold.of(context).closeDrawer();
        // The index is the one of the drawer as well.
        final destination = kAdminDrawerDestinations[index];
        context.go(destination.route);
      },
      children: [
        const _AdminDrawerHeader(),
        const Divider(height: 1),
        for (final group in kAdminNavGroups) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.lg,
              AppSpacing.md,
              AppSpacing.lg,
              AppSpacing.xs,
            ),
            child: Text(
              group.title.toUpperCase(),
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                letterSpacing: 0.8,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          for (final destination in group.destinations)
            NavigationDrawerDestination(
              icon: Icon(destination.icon),
              selectedIcon: Icon(destination.selectedIcon),
              label: Text(destination.label),
            ),
        ],
        const SizedBox(height: AppSpacing.sm),
        const Divider(height: 1),
        const SizedBox(height: AppSpacing.sm),
        // -----------------------------------------------------------------
        // The profile of the signed-in admin.
        //
        // There is **no** log out button here: the app bar of every admin
        // screen has one, and two log out buttons for the same thing only
        // confused everybody ("which one do I press?").
        // -----------------------------------------------------------------
        const _AdminDrawerProfile(),
        const SizedBox(height: AppSpacing.lg),
      ],
    );
  }
}

/// The header of the admin drawer — the logo of the app.
class _AdminDrawerHeader extends StatelessWidget {
  const _AdminDrawerHeader();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.lg,
        AppSpacing.lg,
        AppSpacing.lg,
        AppSpacing.sm,
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: theme.colorScheme.primary,
              borderRadius: BorderRadius.circular(AppBorderRadius.md),
            ),
            child: Icon(
              Icons.home_work,
              color: theme.colorScheme.onPrimary,
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'StayServe',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w700,
                  ),
                ),
                Text(
                  'Admin panel',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The profile of the signed-in admin — the bottom of the drawer.
///
/// It replaces the log out tile that used to be here: the log out button
/// lives in the app bar now, so there is only **one** way to sign out.
class _AdminDrawerProfile extends ConsumerWidget {
  const _AdminDrawerProfile();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final session = ref.watch(authSessionProvider).valueOrNull;
    final profile = session?.profile;

    final name = (profile?.name.isNotEmpty ?? false)
        ? profile!.name
        : (session?.user.displayName ?? 'Admin');
    final email = (profile?.email.isNotEmpty ?? false)
        ? profile!.email
        : (session?.user.email ?? '');

    final initials = name.trim().isEmpty
        ? '?'
        : name
            .trim()
            .split(RegExp(r'\s+'))
            .where((part) => part.isNotEmpty)
            .take(2)
            .map((part) => part.substring(0, 1).toUpperCase())
            .join();

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.lg),
      child: Row(
        children: [
          CircleAvatar(
            radius: 20,
            backgroundColor: theme.colorScheme.primaryContainer,
            child: Text(
              initials,
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.onPrimaryContainer,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  name,
                  style: theme.textTheme.bodyLarge?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                if (email.isNotEmpty)
                  Text(
                    email,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Signs the admin out and sends them back to the login screen.
class AdminLogout {
  /// Signs the user out and goes to the login screen.
  ///
  /// It is used by the app bar of every admin screen.
  static Future<void> logOut(BuildContext context, WidgetRef ref) {
    return signOutAndGoToLogin(context, ref);
  }
}

/// The frame of every admin screen.
///
/// It replaces the plain `Scaffold` of the admin screens: it adds the
/// drawer, a consistent app bar and — on a wide screen — the navigation
/// rail.
class AdminScaffold extends ConsumerWidget {
  final String title;
  final Widget body;

  /// The actions of the app bar (refresh, …).
  final List<Widget>? actions;

  /// The bottom of the app bar — used by the screens with tabs.
  final PreferredSizeWidget? bottom;

  final Widget? floatingActionButton;

  const AdminScaffold({
    required this.title,
    required this.body,
    this.actions,
    this.bottom,
    this.floatingActionButton,
    super.key,
  });

  /// From this width on the navigation is a rail, so the drawer is not
  /// needed any more.
  static const double railBreakpoint = 900;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final width = MediaQuery.of(context).size.width;
    final isWide = width >= railBreakpoint;

    // The location is read from the router, so the drawer always highlights
    // the screen the admin is actually on.
    final location = GoRouterState.of(context).matchedLocation;

    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: [
          // The bell with the number of unread notifications — the admin
          // has to be able to see that a booking or a payment needs a
          // look without opening every screen.
          const NotificationBell(),
          // The log out button. The admin area has no profile screen, so
          // without this the admin could not sign out of the app at all.
          IconButton(
            tooltip: 'Log out',
            icon: const Icon(Icons.logout),
            onPressed: () => AdminLogout.logOut(context, ref),
          ),
          ...?actions,
        ],
        bottom: bottom,
      ),
      // On a wide screen the rail of the shell does the navigation — a
      // drawer on top of it would only be in the way.
      drawer: isWide
          ? null
          : AdminNavigationDrawer(location: location),
      body: body,
      floatingActionButton: floatingActionButton,
    );
  }
}

/// The navigation rail of the admin area — used on tablets and desktops.
class AdminNavigationRail extends ConsumerWidget {
  final String location;

  const AdminNavigationRail({required this.location, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selected = adminDestinationIndex(location);

    return NavigationRail(
      selectedIndex: selected,
      onDestinationSelected: (index) =>
          context.go(kAdminDestinations[index].route),
      labelType: NavigationRailLabelType.all,
      destinations: [
        for (final destination in kAdminDestinations)
          NavigationRailDestination(
            icon: Icon(destination.icon),
            selectedIcon: Icon(destination.selectedIcon),
            label: Text(destination.label),
          ),
      ],
    );
  }
}
