import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/owner/owner_repository.dart';
import '../../../../../models/join_request_model.dart';
import '../../../notifications/presentation/widgets/notification_bell.dart';
import '../providers/owner_providers.dart';

class OwnerDashboardScreen extends ConsumerWidget {
  const OwnerDashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final stats = ref.watch(ownerStatsProvider);
    final requestsAsync = ref.watch(myJoinRequestsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Dashboard'),
        actions: const [NotificationBell()],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(myRoomsProvider);
          ref.invalidate(myJoinRequestsProvider);
          ref.invalidate(myInvoicesProvider);
        },
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            _buildStatsGrid(context, stats),
            const SizedBox(height: AppSpacing.lg),
            _buildQuickActions(context),
            const SizedBox(height: AppSpacing.lg),
            _buildRecentActivity(context, requestsAsync),
          ],
        ),
      ),
    );
  }

  Widget _buildStatsGrid(BuildContext context, OwnerStats stats) {
    final cards = [
      ('Total Rooms', '${stats.totalRooms}', Icons.apartment),
      ('Homes', '${stats.totalHomes}', Icons.home_work_outlined),
      ('Available', '${stats.availableRooms}', Icons.check_circle),
      ('Occupied', '${stats.occupiedRooms}', Icons.lock_outline),
      ('Pending Requests', '${stats.pendingRequests}', Icons.pending),
      ('Awaiting Payment', '${stats.awaitingPayment}', Icons.receipt),
    ];

    // -------------------------------------------------------------------
    // The height is given as a fixed extent instead of an aspect ratio.
    //
    // With `childAspectRatio: 1.5` the tile was only ~104 px high on a
    // normal phone, while its content (icon + a big number + a two-word
    // label) needs ~120 px — the card overflowed and the number was drawn
    // on top of the label. A fixed extent gives every tile the same, ample
    // room, and the cards below make sure the content adapts anyway.
    //
    // The extent is 150 px: the tallest card is the one with a **two
    // line** label ("Pending Requests", "Awaiting Payment"). With 132 px
    // those cards overflowed by six pixels and the yellow-and-black
    // overflow stripes were shown on the phone.
    // -------------------------------------------------------------------
    return GridView.count(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      crossAxisCount: 2,
      crossAxisSpacing: AppSpacing.md,
      mainAxisSpacing: AppSpacing.md,
      mainAxisExtent: 150,
      children: cards
          .map(
            (card) => _StatCard(title: card.$1, value: card.$2, icon: card.$3),
          )
          .toList(),
    );
  }

  Widget _buildQuickActions(BuildContext context) {
    final actions = [
      ('Add Room', Icons.add, () => context.push('/owner/rooms/create')),
      ('View Requests', Icons.mail, () => context.go('/owner/requests')),
      ('View Invoices', Icons.receipt, () => context.go('/owner/invoices')),
      ('Edit Profile', Icons.person, () => context.go('/owner/profile')),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Quick Actions', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: AppSpacing.md),
        Wrap(
          spacing: AppSpacing.md,
          runSpacing: AppSpacing.md,
          children: actions
              .map(
                (action) => _ActionCard(
                  title: action.$1,
                  icon: action.$2,
                  onTap: action.$3,
                ),
              )
              .toList(),
        ),
      ],
    );
  }

  Widget _buildRecentActivity(
    BuildContext context,
    AsyncValue<List<JoinRequestModel>> requestsAsync,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Recent Activity', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: AppSpacing.md),
        requestsAsync.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, _) => const Text('Could not load recent activity'),
          data: (requests) {
            if (requests.isEmpty) {
              return const Text('No activity yet.');
            }
            return Card(
              child: Column(
                children: requests
                    .take(5)
                    .map((request) => _ActivityTile(request: request))
                    .toList(),
              ),
            );
          },
        ),
      ],
    );
  }
}

class _StatCard extends StatelessWidget {
  final String title;
  final String value;
  final IconData icon;

  const _StatCard({
    required this.title,
    required this.value,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Icon(icon, color: theme.colorScheme.primary, size: 24),
            const SizedBox(height: AppSpacing.sm),
            // The column of the number and the label is **flexible**: when
            // the label needs two lines the column gets smaller instead of
            // overflowing the card.
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  // The number shrinks instead of overflowing when it is very
                  // large (a lot of rooms).
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
                  const SizedBox(height: 2),
                  // The label gives way when the room is tight: it is
                  // shortened with an ellipsis instead of overflowing the
                  // card.
                  Flexible(
                    child: Text(
                      title,
                      style: theme.textTheme.bodySmall,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ActionCard extends StatelessWidget {
  final String title;
  final IconData icon;
  final VoidCallback onTap;

  const _ActionCard({
    required this.title,
    required this.icon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppBorderRadius.lg),
      child: Container(
        width: 150,
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(AppBorderRadius.lg),
        ),
        child: Column(
          children: [
            Icon(icon, size: 32, color: theme.colorScheme.primary),
            const SizedBox(height: AppSpacing.sm),
            Text(
              title,
              style: theme.textTheme.labelLarge,
              textAlign: TextAlign.center,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }
}

class _ActivityTile extends StatelessWidget {
  final JoinRequestModel request;

  const _ActivityTile({required this.request});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    final (title, subtitle, icon) = switch (request.status) {
      JoinRequestStatus.pending => (
        'New join request',
        'Waiting for your confirmation',
        Icons.mail_outline,
      ),
      JoinRequestStatus.ownerConfirmed => (
        'Request accepted',
        'Waiting for the student to confirm',
        Icons.check_circle_outline,
      ),
      JoinRequestStatus.adminReviewed => (
        'Booking activated',
        'The payment was verified and the student has joined your room',
        Icons.verified_outlined,
      ),
      JoinRequestStatus.rejected => (
        'Request rejected',
        'You declined this request',
        Icons.cancel_outlined,
      ),
      JoinRequestStatus.cancelled => (
        'Request cancelled',
        'The student withdrew the request',
        Icons.remove_circle_outline,
      ),
      JoinRequestStatus.studentConfirmed => (
        'Platform fee pending',
        'Waiting for the fee to be submitted and verified',
        Icons.payments_outlined,
      ),
    };

    return ListTile(
      leading: CircleAvatar(
        backgroundColor: theme.colorScheme.primaryContainer,
        child: Icon(icon, color: theme.colorScheme.primary),
      ),
      title: Text(title),
      subtitle: Text(subtitle),
      trailing: Text(
        AppFormatters.formatRelativeTime(request.createdAt),
        style: theme.textTheme.bodySmall,
      ),
    );
  }
}
