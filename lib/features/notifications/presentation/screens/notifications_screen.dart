import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../features/auth/presentation/providers/auth_provider.dart';
import '../../../../../firebase/notifications/notifications_repository.dart';
import '../../../../../models/notification_model.dart';
import '../providers/notification_providers.dart';

class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notificationsAsync = ref.watch(notificationsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          TextButton(
            onPressed: () async {
              await ref.read(notificationsRepositoryProvider).markAllAsRead();
            },
            child: const Text('Mark All Read'),
          ),
        ],
      ),
      body: notificationsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                Icons.error_outline,
                size: 64,
                color: Theme.of(context).colorScheme.error,
              ),
              const SizedBox(height: AppSpacing.md),
              const Text('Could not load notifications'),
              const SizedBox(height: AppSpacing.md),
              TextButton(
                onPressed: () => ref.invalidate(notificationsProvider),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
        data: (notifications) {
          if (notifications.isEmpty) {
            return const EmptyState(
              icon: Icons.notifications_none,
              title: 'No Notifications',
              message: 'You will be notified here about requests, messages and invoices.',
            );
          }

          return RefreshIndicator(
            onRefresh: () async {
              // The indicator has to wait for the **new** data —
              // `invalidate` returns nothing, so the spinner
              // disappeared while the list was still loading.
              final _ = await ref.refresh(notificationsProvider.future);
            },
            child: ListView.builder(
              padding: const EdgeInsets.all(AppSpacing.md),
              itemCount: notifications.length,
              itemBuilder: (context, index) {
                final notification = notifications[index];
                return _NotificationTile(
                  notification: notification,
                  onTap: () => _open(context, ref, notification),
                );
              },
            ),
          );
        },
      ),
    );
  }

  Future<void> _open(
    BuildContext context,
    WidgetRef ref,
    NotificationModel notification,
  ) async {
    if (!notification.isRead) {
      try {
        await ref
            .read(notificationsRepositoryProvider)
            .markAsRead(notification.notificationId);
      } catch (_) {
        // Non fatal: the tile still opens.
      }
    }
    if (!context.mounted) return;

    // The route depends on the role of the user — see [notificationRouteFor].
    final role = ref.read(userRoleProvider);
    final route = notification.routeFor(role);
    if (route.isEmpty) return;

    // Shared routes are reachable from every role.
    if (route.startsWith('/room/') ||
        route.startsWith('/chat/') ||
        route.startsWith('/invoice/') ||
        route == '/conversations' ||
        route == '/notifications') {
      // A notification opens a destination, it does not add another layer
      // to the role shell's navigator. `go` also avoids the duplicate
      // ShellRoute page keys that made the old implementation render a
      // blank page.
      context.go(route);
      return;
    }

    // Role specific routes: only navigate when the user may access them.
    final allowed = switch (role) {
      UserRole.admin => true,
      UserRole.owner => route.startsWith('/owner'),
      UserRole.student => route.startsWith('/student'),
      null => false,
    };

    if (allowed) {
      // A notification opens a destination, it does not add another layer
      // to the role shell's navigator. `go` also avoids the duplicate
      // ShellRoute page keys that made the old implementation render a
      // blank page.
      context.go(route);
      return;
    }

    // The notification points at a screen the user may not open. The old
    // code just returned — the tap did nothing at all and the user had no
    // idea why.
    context.showErrorSnackBar(
      'This notification points to a screen that is not available for your '
      'account.',
    );
  }
}

class _NotificationTile extends StatelessWidget {
  final NotificationModel notification;
  final VoidCallback onTap;

  const _NotificationTile({required this.notification, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    final (icon, iconColor) = switch (notification.type) {
      NotificationType.newMessage => (Icons.message, Colors.blue),
      NotificationType.joinRequest => (Icons.person_add, Colors.orange),
      NotificationType.joinConfirmed => (Icons.check_circle, Colors.green),
      NotificationType.invoiceCreated => (Icons.receipt, Colors.purple),
      NotificationType.invoicePaid => (Icons.paid, Colors.teal),
      NotificationType.adminReview => (Icons.admin_panel_settings, Colors.red),
      NotificationType.account => (Icons.person_off, Colors.grey),
      NotificationType.review => (Icons.star_outline, Colors.amber),
      NotificationType.general => (Icons.info, Colors.blueGrey),
    };

    final isRead = notification.isRead;

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      color: isRead
          ? theme.colorScheme.surface
          : theme.colorScheme.primaryContainer.withValues(alpha: 0.3),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppBorderRadius.lg),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.all(AppSpacing.sm),
                decoration: BoxDecoration(
                  color: iconColor.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(AppBorderRadius.md),
                ),
                child: Icon(icon, color: iconColor, size: 24),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            notification.title,
                            style: theme.textTheme.titleMedium,
                          ),
                        ),
                        Text(
                          AppFormatters.formatRelativeTime(notification.createdAt),
                          style: theme.textTheme.bodySmall,
                        ),
                      ],
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    Text(notification.body, style: theme.textTheme.bodyMedium),
                  ],
                ),
              ),
              if (!isRead)
                Container(
                  width: 8,
                  height: 8,
                  margin: const EdgeInsets.only(top: 4),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primary,
                    shape: BoxShape.circle,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
