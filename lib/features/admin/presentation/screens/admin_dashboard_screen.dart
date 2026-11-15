import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../firebase/admin/admin_repository.dart';
import '../../../auth/presentation/providers/auth_provider.dart';
import '../providers/admin_providers.dart';
import '../widgets/admin_scaffold.dart';

/// The dashboard of the admin area.
///
/// ## How it is organised
///
/// The screen is built in the order an admin actually works in — and it
/// shows **four rows of data**, so the whole picture fits on one screen:
///
///  1. **At a glance** — the four numbers that decide where the admin has
///     to look first: users, rooms, revenue and the open work,
///  2. **Needs attention** — the bookings and the invoices that are still
///     open (they are shown first, because they are the only part of the
///     dashboard that is a *task*),
///  3. **Key figures** — the breakdown, grouped into people / listings /
///     money,
///  4. **Recent activity** — the newest booking requests as rows of real
///     data ("Sunita booked "Sunny PG" — waiting for the owner"),
///  5. the **shortcuts** to the other screens.
///
/// The old screen showed a fixed list of three made-up "recent activity"
/// entries ("Admin dashboard loaded", "Commission settings", …) that never
/// changed and told the admin nothing. Those are gone — the section is
/// called "Needs attention" now and it shows the real pending work, and the
/// activity section below it reads the **real** requests from Firestore.
class AdminDashboardScreen extends ConsumerWidget {
  const AdminDashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statsAsync = ref.watch(adminStatsProvider);
    final recentAsync = ref.watch(adminRecentRequestsProvider);

    return AdminScaffold(
      title: 'Admin Dashboard',
      body: statsAsync.when(
        data: (stats) => RefreshIndicator(
          onRefresh: () async {
              // The indicator has to wait for the **new** data —
              // `invalidate` returns nothing, so the spinner
              // disappeared while the list was still loading.
              final _ = await ref.refresh(adminStatsProvider.future);
              ref.invalidate(adminRecentRequestsProvider);
            },
          child: ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              const _GreetingHeader(),
              const SizedBox(height: AppSpacing.lg),

              // -----------------------------------------------------------------
              // Row 1 of data — the headline figures.
              // -----------------------------------------------------------------
              _buildAtAGlance(context, stats),
              const SizedBox(height: AppSpacing.lg),

              // -----------------------------------------------------------------
              // Row 2 of data — the work that is still open.
              // -----------------------------------------------------------------
              _buildNeedsAttention(context, stats),
              const SizedBox(height: AppSpacing.lg),

              // -----------------------------------------------------------------
              // Row 3 of data — the breakdown.
              // -----------------------------------------------------------------
              _buildStatsGrid(context, stats),
              const SizedBox(height: AppSpacing.lg),

              // -----------------------------------------------------------------
              // Row 4 of data — the newest bookings.
              // -----------------------------------------------------------------
              _buildRecentActivity(context, recentAsync),
              const SizedBox(height: AppSpacing.lg),

              _buildQuickActions(context),
              const SizedBox(height: AppSpacing.lg),
            ],
          ),
        ),
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(child: Text('Error: $error')),
      ),
    );
  }

  /// The four numbers that matter most — one card each.
  ///
  /// Every card leads to the screen where the number can be acted upon, so
  /// the dashboard is a way **into** the work and not only a report about
  /// it.
  Widget _buildAtAGlance(BuildContext context, AdminStats stats) {
    final theme = Theme.of(context);
    final openWork = stats.pendingConfirmations + stats.pendingInvoices;

    final cards = [
      (
        'Users',
        '${stats.totalUsers}',
        Icons.people,
        '/admin/users',
      ),
      (
        'Rooms',
        '${stats.totalRooms}',
        Icons.meeting_room,
        '/admin/rooms',
      ),
      (
        'Revenue',
        '₹${_formatNumber(stats.totalRevenue)}',
        Icons.account_balance_wallet,
        '/admin/payments',
      ),
      (
        'Open work',
        '$openWork',
        Icons.pending_actions,
        '/admin/requests',
      ),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('At a glance', style: theme.textTheme.titleLarge),
        const SizedBox(height: AppSpacing.md),
        LayoutBuilder(
          builder: (context, constraints) {
            // Two columns on a phone, four on a tablet — the cards never
            // get narrower than they can hold their number.
            final columns = constraints.maxWidth >= 720 ? 4 : 2;
            return GridView.count(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              crossAxisCount: columns,
              crossAxisSpacing: AppSpacing.sm,
              mainAxisSpacing: AppSpacing.sm,
              mainAxisExtent: 104,
              children: cards
                  .map((card) => _HeadlineCard(
                        title: card.$1,
                        value: card.$2,
                        icon: card.$3,
                        route: card.$4,
                      ))
                  .toList(),
            );
          },
        ),
      ],
    );
  }

  /// The work that is still open.
  ///
  /// It replaces the fake "recent activity" list: every entry is a real
  /// number and leads to the screen where the work can be done.
  Widget _buildNeedsAttention(BuildContext context, AdminStats stats) {
    final theme = Theme.of(context);
    final pending = [
      if (stats.pendingConfirmations > 0)
        (
          'Pending confirmations',
          stats.pendingConfirmations,
          Icons.pending_actions,
          '/admin/requests',
        ),
      if (stats.pendingInvoices > 0)
        (
          'Pending invoices',
          stats.pendingInvoices,
          Icons.receipt_long,
          '/admin/invoices',
        ),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            // The title has to be flexible: on a narrow phone the row with
            // the badge was 11 pixels too wide.
            Flexible(
              child: Text(
                'Needs attention',
                style: theme.textTheme.titleLarge,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            if (pending.isNotEmpty)
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.sm,
                  vertical: 2,
                ),
                decoration: BoxDecoration(
                  color: theme.colorScheme.errorContainer,
                  borderRadius: BorderRadius.circular(AppBorderRadius.md),
                ),
                child: Text(
                  '${pending.fold<int>(0, (sum, item) => sum + item.$2)}',
                  style: theme.textTheme.labelMedium?.copyWith(
                    color: theme.colorScheme.onErrorContainer,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: AppSpacing.md),
        if (pending.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpacing.md),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(AppBorderRadius.lg),
            ),
            child: Row(
              children: [
                Icon(
                  Icons.check_circle_outline,
                  color: theme.colorScheme.primary,
                ),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Text(
                    'Nothing is waiting for you — every booking and every '
                    'invoice is settled.',
                    style: theme.textTheme.bodyMedium,
                  ),
                ),
              ],
            ),
          )
        else
          Column(
            children: [
              for (final item in pending)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.sm),
                  child: _AttentionTile(
                    title: item.$1,
                    count: item.$2,
                    icon: item.$3,
                    route: item.$4,
                  ),
                ),
            ],
          ),
      ],
    );
  }

  /// The key figures — grouped, so a number is not just a number.
  ///
  /// `SliverGridDelegateWithMaxCrossAxisExtent` with a fixed
  /// `mainAxisExtent` gives every card exactly the height it needs — the
  /// old `childAspectRatio` made the cards too short for their text on a
  /// narrow phone.
  Widget _buildStatsGrid(BuildContext context, AdminStats stats) {
    final groups = [
      (
        'People',
        [
          ('Total users', stats.totalUsers.toString(), Icons.people),
          ('Students', stats.totalStudents.toString(), Icons.school),
          ('Owners', stats.totalOwners.toString(), Icons.apartment),
        ],
      ),
      (
        'Listings',
        [
          ('Total rooms', stats.totalRooms.toString(), Icons.meeting_room),
          ('Available', stats.availableRooms.toString(), Icons.check_circle),
          ('Joined', stats.joinedRooms.toString(), Icons.assignment_turned_in),
        ],
      ),
      (
        'Money',
        [
          ('Revenue', '₹${_formatNumber(stats.totalRevenue)}', Icons.attach_money),
          ('Pending invoices', stats.pendingInvoices.toString(), Icons.receipt),
          ('Pending confirmations', stats.pendingConfirmations.toString(), Icons.pending),
        ],
      ),
    ];

    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Key figures', style: theme.textTheme.titleLarge),
        const SizedBox(height: AppSpacing.md),
        for (final group in groups) ...[
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: Text(
              group.$1.toUpperCase(),
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                letterSpacing: 0.8,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          LayoutBuilder(
            builder: (context, constraints) {
              // One column on a very narrow phone, two on a normal one,
              // three on a tablet — the cards never get narrower than they
              // can hold their text.
              final columns = constraints.maxWidth >= 720
                  ? 3
                  : (constraints.maxWidth >= 420 ? 2 : 1);

              return GridView.count(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                crossAxisCount: columns,
                crossAxisSpacing: AppSpacing.sm,
                mainAxisSpacing: AppSpacing.sm,
                // A fixed height instead of an aspect ratio: the cards have
                // to hold a two-line label ("Pending confirmations") and a
                // big number — with a ratio they overflowed on a phone.
                mainAxisExtent: 92,
                children: group.$2
                    .map((stat) => _StatCard(
                          title: stat.$1,
                          value: stat.$2,
                          icon: stat.$3,
                        ))
                    .toList(),
              );
            },
          ),
          const SizedBox(height: AppSpacing.md),
        ],
      ],
    );
  }

  /// The newest booking requests — **rows of real data**.
  ///
  /// The old dashboard showed three made-up entries ("Admin dashboard
  /// loaded", …) that never changed. This section reads the real requests
  /// from Firestore and shows who booked what, how long ago and where the
  /// request stands.
  Widget _buildRecentActivity(
    BuildContext context,
    AsyncValue<List<AdminRecentRequest>> recentAsync,
  ) {
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Flexible(
              child: Text(
                'Recent activity',
                style: theme.textTheme.titleLarge,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            TextButton(
              onPressed: () => context.go('/admin/requests'),
              style: TextButton.styleFrom(
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
                minimumSize: const Size(0, 32),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              child: const Text('See all'),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        recentAsync.when(
          data: (requests) {
            if (requests.isEmpty) {
              return Container(
                width: double.infinity,
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(AppBorderRadius.lg),
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.inbox_outlined,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: AppSpacing.md),
                    Expanded(
                      child: Text(
                        'No booking request yet — the activity shows up here '
                        'as soon as a student sends one.',
                        style: theme.textTheme.bodyMedium,
                      ),
                    ),
                  ],
                ),
              );
            }

            return Container(
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(AppBorderRadius.lg),
              ),
              child: Column(
                children: [
                  for (var i = 0; i < requests.length; i++) ...[
                    if (i > 0)
                      Divider(
                        height: 1,
                        color: theme.colorScheme.outlineVariant,
                      ),
                    _RecentRequestTile(entry: requests[i]),
                  ],
                ],
              ),
            );
          },
          loading: () => const Padding(
            padding: EdgeInsets.symmetric(vertical: AppSpacing.lg),
            child: Center(child: CircularProgressIndicator()),
          ),
          // The dashboard is still useful without the activity — a failure
          // here must not take the whole screen down.
          error: (error, stack) => Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpacing.md),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(AppBorderRadius.lg),
            ),
            child: Row(
              children: [
                Icon(Icons.cloud_off, color: theme.colorScheme.onSurfaceVariant),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Text(
                    'The latest bookings could not be loaded.',
                    style: theme.textTheme.bodyMedium,
                  ),
                ),
                TextButton(
                  onPressed: () => context.go('/admin/requests'),
                  child: const Text('Open requests'),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// The shortcuts to the other admin screens.
  Widget _buildQuickActions(BuildContext context) {
    final actions = [
      ('Manage Users', Icons.people, '/admin/users'),
      ('Review Rooms', Icons.apartment, '/admin/rooms'),
      ('Review Requests', Icons.assignment, '/admin/requests'),
      ('Manage Invoices', Icons.receipt, '/admin/invoices'),
      ('Payments', Icons.payments, '/admin/payments'),
      ('Analytics', Icons.analytics, '/admin/analytics'),
      ('Settings', Icons.settings, '/admin/settings'),
      ('Launch Areas', Icons.location_on, '/admin/launch-areas'),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Quick Actions', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: AppSpacing.md),
        LayoutBuilder(
          builder: (context, constraints) {
            final columns = constraints.maxWidth >= 720 ? 4 : 2;
            return GridView.count(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              crossAxisCount: columns,
              crossAxisSpacing: AppSpacing.sm,
              mainAxisSpacing: AppSpacing.sm,
              childAspectRatio: 1.75,
              children: actions
                  .map((action) => _ActionCard(
                        title: action.$1,
                        icon: action.$2,
                        route: action.$3,
                      ))
                  .toList(),
            );
          },
        ),
      ],
    );
  }

  String _formatNumber(int number) {
    if (number >= 100000) {
      return '${(number / 100000).toStringAsFixed(1)}L';
    } else if (number >= 1000) {
      return '${(number / 1000).toStringAsFixed(1)}K';
    }
    return number.toString();
  }
}

/// The greeting at the top of the dashboard.
class _GreetingHeader extends ConsumerWidget {
  const _GreetingHeader();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final session = ref.watch(authSessionProvider).valueOrNull;

    final name = (session?.profile?.name.isNotEmpty ?? false)
        ? session!.profile!.name
        : (session?.user.displayName ?? 'Admin');
    final firstName = name.trim().split(RegExp(r'\s+')).first;

    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '${_greeting()}, $firstName',
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                'Here is what is going on in StayServe today.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
        Icon(
          Icons.admin_panel_settings,
          size: 36,
          color: theme.colorScheme.primary,
        ),
      ],
    );
  }

  /// "Good morning" / "Good afternoon" / "Good evening".
  static String _greeting() {
    final hour = DateTime.now().hour;
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }
}

/// One headline figure of the "at a glance" row.
class _HeadlineCard extends StatelessWidget {
  final String title;
  final String value;
  final IconData icon;
  final String route;

  const _HeadlineCard({
    required this.title,
    required this.value,
    required this.icon,
    required this.route,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.primaryContainer,
      borderRadius: BorderRadius.circular(AppBorderRadius.lg),
      child: InkWell(
        onTap: () => context.go(route),
        borderRadius: BorderRadius.circular(AppBorderRadius.lg),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm + 2),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Row(
                children: [
                  Icon(
                    icon,
                    size: 18,
                    color: theme.colorScheme.onPrimaryContainer,
                  ),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: Text(
                      title,
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: theme.colorScheme.onPrimaryContainer,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(
                  value,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    fontWeight: FontWeight.w700,
                    color: theme.colorScheme.onPrimaryContainer,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One piece of work that is waiting for the admin.
class _AttentionTile extends StatelessWidget {
  final String title;
  final int count;
  final IconData icon;
  final String route;

  const _AttentionTile({
    required this.title,
    required this.count,
    required this.icon,
    required this.route,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Material(
      color: theme.colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(AppBorderRadius.lg),
      child: InkWell(
        onTap: () => context.go(route),
        borderRadius: BorderRadius.circular(AppBorderRadius.lg),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            children: [
              CircleAvatar(
                backgroundColor: theme.colorScheme.errorContainer,
                child: Icon(icon, color: theme.colorScheme.onErrorContainer),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.bodyLarge?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(
                      count == 1 ? '1 item' : '$count items',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right),
            ],
          ),
        ),
      ),
    );
  }
}

/// One key figure.
///
/// The value is put in a [FittedBox] so a big number shrinks instead of
/// pushing the label out of the card, and the label takes two lines at
/// most.
class _StatCard extends StatelessWidget {
  final String title;
  final String value;
  final IconData icon;

  const _StatCard({required this.title, required this.value, required this.icon});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.sm + 2),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Row(
              children: [
                Icon(icon, color: theme.colorScheme.primary, size: 20),
                const SizedBox(width: AppSpacing.xs),
                Expanded(
                  child: Text(
                    title,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(
                value,
                style: theme.textTheme.headlineSmall?.copyWith(
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One row of the **recent activity**.
class _RecentRequestTile extends StatelessWidget {
  final AdminRecentRequest entry;

  const _RecentRequestTile({required this.entry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final status = entry.status;

    final (Color background, Color foreground) = switch (status) {
      JoinRequestStatus.adminReviewed => (
          theme.colorScheme.primaryContainer,
          theme.colorScheme.onPrimaryContainer,
        ),
      JoinRequestStatus.rejected => (
          theme.colorScheme.errorContainer,
          theme.colorScheme.onErrorContainer,
        ),
      JoinRequestStatus.cancelled => (
          theme.colorScheme.surfaceContainerHighest,
          theme.colorScheme.onSurfaceVariant,
        ),
      _ => (
          theme.colorScheme.secondaryContainer,
          theme.colorScheme.onSecondaryContainer,
        ),
    };

    return InkWell(
      onTap: () => context.go('/admin/requests'),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.sm + 2,
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${entry.studentName} booked "${entry.roomLabel}"',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${AppFormatters.formatRelativeTime(entry.createdAt)} · '
                    '${entry.request.requestId}',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.sm,
                vertical: 2,
              ),
              decoration: BoxDecoration(
                color: background,
                borderRadius: BorderRadius.circular(AppBorderRadius.full),
              ),
              child: Text(
                status.label,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: foreground,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One shortcut.
class _ActionCard extends StatelessWidget {
  final String title;
  final IconData icon;
  final String route;

  const _ActionCard({required this.title, required this.icon, required this.route});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: () => context.go(route),
      borderRadius: BorderRadius.circular(AppBorderRadius.lg),
      child: Container(
        padding: const EdgeInsets.all(AppSpacing.sm + 2),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(AppBorderRadius.lg),
        ),
        child: Row(
          children: [
            Icon(icon, size: 22, color: theme.colorScheme.primary),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Text(
                title,
                style: theme.textTheme.labelLarge,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
