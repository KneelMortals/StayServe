import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../models/user_model.dart';
import '../providers/admin_providers.dart';
import '../widgets/admin_message_dialog.dart';
import '../widgets/admin_scaffold.dart';

class AdminUsersScreen extends ConsumerStatefulWidget {
  const AdminUsersScreen({super.key});

  @override
  ConsumerState<AdminUsersScreen> createState() => _AdminUsersScreenState();
}

class _AdminUsersScreenState extends ConsumerState<AdminUsersScreen> {
  /// Currently applied role filter. `null` means "all roles".
  UserRole? _roleFilter;

  @override
  Widget build(BuildContext context) {
    final usersAsync = ref.watch(adminUsersProvider(_roleFilter));

    return AdminScaffold(
      title: 'Manage Users',
      actions: [
        IconButton(
          icon: const Icon(Icons.filter_list),
          tooltip: 'Filter by role',
          onPressed: () => _showRoleFilter(context),
        ),
      ],
      body: usersAsync.when(
        data: (users) {
          if (users.isEmpty) {
            return const Center(child: Text('No users found'));
          }
          return RefreshIndicator(
            onRefresh: () async {
              // The indicator has to wait for the **new** data —
              // `invalidate` returns nothing, so the spinner
              // disappeared while the list was still loading.
              final _ = await ref.refresh(
                adminUsersProvider(_roleFilter).future,
              );
            },
            child: ListView.builder(
              padding: const EdgeInsets.all(AppSpacing.md),
              itemCount: users.length,
              itemBuilder: (context, index) {
                final user = users[index];
                return _UserCard(
                  user: user,
                  onToggleActive: (isActive) async {
                    if (isActive) {
                      final error = await ref
                          .read(adminControllerProvider.notifier)
                          .unbanUser(user.uid);
                      if (!context.mounted) return;
                      context.showErrorIfAny(error);
                    } else {
                      _showBanDialog(context, ref, user);
                    }
                  },
                  onMessage: () => _messageUser(context, user),
                  onChangeRole: (newRole) async {
                    final error = await ref
                        .read(adminControllerProvider.notifier)
                        .updateUserRole(user.uid, newRole);
                    if (!context.mounted) return;
                    context.showErrorIfAny(error);
                  },
                  onScheduleDeletion: () =>
                      _confirmScheduleDeletion(context, ref, user),
                  onCancelDeletion: () =>
                      _confirmCancelDeletion(context, ref, user),
                  onDeleteNow: () => _confirmDeleteUser(context, ref, user),
                );
              },
            ),
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(child: Text('Error: $error')),
      ),
    );
  }

  /// Sends a verified administrator message and opens the support chat.
  Future<void> _messageUser(BuildContext context, UserModel user) async {
    final result = await AdminMessageDialog.show(context, user);
    if (result == null || !context.mounted) return;

    await context.push(
      Uri(
        path: '/chat/${result.conversationId}',
        queryParameters: {'peer': result.peerId, 'support': '1'},
      ).toString(),
    );
  }

  Future<void> _showRoleFilter(BuildContext context) async {
    final selected = await RadioFilterSheet.show<UserRole>(
      context,
      title: 'Filter by Role',
      options: UserRole.values,
      labelBuilder: (role) => role.displayName,
      allLabel: 'All Roles',
      initialValue: _roleFilter,
    );
    if (!mounted) return;
    setState(() => _roleFilter = selected);
  }

  void _showBanDialog(BuildContext context, WidgetRef ref, UserModel user) {
    // The context of the *screen* — the one inside the dialog builder is
    // deactivated as soon as the dialog is popped.
    final screenContext = context;

    showDialog<String>(
      context: context,
      builder: (dialogContext) => _BanDialog(name: user.name),
    ).then((reason) async {
      if (reason == null || !screenContext.mounted) return;
      final error = await ref
          .read(adminControllerProvider.notifier)
          .banUser(user.uid, reason: reason.isNotEmpty ? reason : null);
      if (!screenContext.mounted) return;
      screenContext.showErrorIfAny(error);
    });
  }

  /// Schedules the deletion of an account — with a seven day grace period.
  ///
  /// The account is **not** deleted right away. It is disabled at once and
  /// removed after seven days; until then the admin can still cancel the
  /// deletion.
  Future<void> _confirmScheduleDeletion(
    BuildContext context,
    WidgetRef ref,
    UserModel user,
  ) async {
    final screenContext = context;

    // The grace period is chosen in the dialog — it is kept in a local
    // variable so the button can hand it back when the dialog closes.
    var graceDays = _GracePeriodPicker.defaultDays;

    final days = await showDialog<int>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => AlertDialog(
          title: Text('Delete ${user.name}?'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'The account is disabled right away and permanently deleted '
                'after the grace period. Everything that belongs to the user — '
                'their listings, requests and invoices — is removed with it.',
              ),
              const SizedBox(height: AppSpacing.md),
              Wrap(
                spacing: AppSpacing.sm,
                runSpacing: AppSpacing.sm,
                children: [
                  for (final option in _GracePeriodPicker.options)
                    ChoiceChip(
                      label: Text(option == 1 ? '1 day' : '$option days'),
                      selected: graceDays == option,
                      onSelected: (_) =>
                          setDialogState(() => graceDays = option),
                    ),
                ],
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, graceDays),
              style: FilledButton.styleFrom(
                backgroundColor: Theme.of(dialogContext).colorScheme.error,
              ),
              child: const Text('Schedule deletion'),
            ),
          ],
        ),
      ),
    );

    if (days == null || !screenContext.mounted) return;

    final error = await ref
        .read(adminControllerProvider.notifier)
        .scheduleUserDeletion(user.uid, days: days);
    if (!screenContext.mounted) return;
    if (screenContext.showErrorIfAny(error)) return;

    screenContext.showSuccessSnackBar(
      '${user.name} will be deleted in $days day${days == 1 ? '' : 's'}. '
      'The account is already disabled.',
    );
  }

  /// Cancels a scheduled deletion.
  Future<void> _confirmCancelDeletion(
    BuildContext context,
    WidgetRef ref,
    UserModel user,
  ) async {
    final screenContext = context;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Cancel the deletion?'),
        content: Text(
          '${user.name} keeps their account. The account is enabled again and '
          'nothing is deleted.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Keep the deletion'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Cancel the deletion'),
          ),
        ],
      ),
    );

    if (confirmed != true || !screenContext.mounted) return;

    final error = await ref
        .read(adminControllerProvider.notifier)
        .cancelUserDeletion(user.uid);
    if (!screenContext.mounted) return;
    if (screenContext.showErrorIfAny(error)) return;

    screenContext.showSuccessSnackBar(
      'The deletion of ${user.name} was cancelled — the account is active '
      'again.',
    );
  }

  /// Deletes an account **right away** — no grace period.
  ///
  /// This is the "nuclear" option; the seven day delay is the default.
  void _confirmDeleteUser(BuildContext context, WidgetRef ref, UserModel user) {
    final screenContext = context;
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Delete user now'),
        content: Text(
          'This deletes ${user.name} immediately — there is no seven day '
          'grace period. This action cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(dialogContext);
              final controller = ref.read(adminControllerProvider.notifier);
              final error = await controller.deleteUser(user.uid);
              if (!screenContext.mounted) return;
              if (screenContext.showErrorIfAny(error)) return;

              final result = controller.lastDeletionResult;
              if (result == null) {
                screenContext.showSuccessSnackBar(
                  'The deletion request for ${user.name} was submitted.',
                );
                return;
              }

              if (result.completed) {
                screenContext.showSuccessSnackBar(
                  'Deletion completed — state: ${result.state}.',
                );
                return;
              }

              if (result.blocked) {
                screenContext.showWarningSnackBar(
                  'Deletion blocked — state: ${result.state}. '
                  'Retryable: no. '
                  '${result.message.isEmpty ? 'The request remains queued.' : result.message}',
                );
                return;
              }

              screenContext.showWarningSnackBar(
                'Deletion queued — state: ${result.state}. '
                'Retryable: ${result.retryable ? 'yes' : 'no'}. '
                '${result.message}',
              );
            },
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Delete now'),
          ),
        ],
      ),
    );
  }
}

/// The dialog that asks for the reason of a ban.
///
/// It owns its text controller — a controller that is created in the caller
/// and never disposed leaks one controller every time the dialog is opened.
class _BanDialog extends StatefulWidget {
  final String name;

  const _BanDialog({required this.name});

  @override
  State<_BanDialog> createState() => _BanDialogState();
}

class _BanDialogState extends State<_BanDialog> {
  final _reasonController = TextEditingController();

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Ban ${widget.name}?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('This will disable their account and force logout.'),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _reasonController,
            decoration: const InputDecoration(
              labelText: 'Reason (optional)',
              hintText: 'e.g., Policy violation, Spam, etc.',
            ),
            maxLines: 3,
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: () =>
              Navigator.pop(context, _reasonController.text.trim()),
          style: TextButton.styleFrom(foregroundColor: Colors.red),
          child: const Text('Ban User'),
        ),
      ],
    );
  }
}

/// The grace period of the scheduled deletion.
///
/// Seven days is the default — that is what the feature asks for. The
/// other values are there for the cases where a mistake has to be
/// cleaned up quickly.
class _GracePeriodPicker {
  /// The grace period in days.
  static const int defaultDays = 7;

  /// The periods the admin can choose from.
  static const List<int> options = [1, 7, 14, 30];
}

/// Whether the server will accept an administrator message for [user].
///
/// The same live-profile checks are made again by `sendAdminMessage`; this
/// helper only keeps unavailable actions out of the menu.
bool _canReceiveAdminMessage(UserModel user) {
  return user.role != UserRole.admin &&
      user.isActive &&
      user.registrationCompleted &&
      user.phoneVerified;
}

class _UserCard extends ConsumerWidget {
  final UserModel user;
  final ValueChanged<bool> onToggleActive;
  final VoidCallback onMessage;
  final ValueChanged<UserRole> onChangeRole;
  final VoidCallback onScheduleDeletion;
  final VoidCallback onCancelDeletion;
  final VoidCallback onDeleteNow;

  const _UserCard({
    required this.user,
    required this.onToggleActive,
    required this.onMessage,
    required this.onChangeRole,
    required this.onScheduleDeletion,
    required this.onCancelDeletion,
    required this.onDeleteNow,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final adminState = ref.watch(adminControllerProvider);

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AppAvatar(
                  name: user.name,
                  radius: 24,
                  imageUrl: user.profileImage,
                ),
                const SizedBox(width: AppSpacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // The name and the role badge share the row — the
                      // name gives way when it is too long, the badge
                      // never does.
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              user.name,
                              style: theme.textTheme.titleMedium,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: AppSpacing.sm),
                          _RoleBadge(role: user.role),
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        user.email,
                        style: theme.textTheme.bodySmall,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      Text(
                        '${user.phone ?? 'No phone'} • Joined ${_formatDate(user.createdAt)}',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                PopupMenuButton<String>(
                  tooltip: 'Actions',
                  onSelected: (value) {
                    switch (value) {
                      case 'message':
                        onMessage();
                        break;
                      case 'role':
                        _showRoleDialog(context);
                        break;
                      case 'scheduleDeletion':
                        onScheduleDeletion();
                        break;
                      case 'cancelDeletion':
                        onCancelDeletion();
                        break;
                      case 'deleteNow':
                        onDeleteNow();
                        break;
                    }
                  },
                  itemBuilder: (context) => [
                    if (_canReceiveAdminMessage(user))
                      const PopupMenuItem(
                        value: 'message',
                        child: Text('Message user'),
                      ),
                    const PopupMenuItem(
                      value: 'role',
                      child: Text('Change Role'),
                    ),
                    if (user.deletionScheduled)
                      const PopupMenuItem(
                        value: 'cancelDeletion',
                        child: Text('Cancel deletion'),
                      )
                    else
                      const PopupMenuItem(
                        value: 'scheduleDeletion',
                        child: Text('Delete account (7 days)'),
                      ),
                    const PopupMenuItem(
                      value: 'deleteNow',
                      child: Text('Delete account now'),
                    ),
                  ],
                ),
              ],
            ),
            if (user.banReason != null) ...[
              const SizedBox(height: AppSpacing.sm),
              _NoticeChip(
                icon: Icons.block,
                color: Colors.red,
                text: 'Banned: ${user.banReason}',
              ),
            ],
            if (user.deletionScheduled) ...[
              const SizedBox(height: AppSpacing.sm),
              _NoticeChip(
                icon: Icons.delete_forever,
                color: Colors.orange,
                text: user.deleteAfter != null
                    ? 'Account disabled — deleted on ${_formatDate(user.deleteAfter!)}'
                    : 'Account disabled — deletion scheduled',
              ),
            ],
            const SizedBox(height: AppSpacing.sm),
            Row(
              children: [
                Expanded(
                  child: Text(
                    user.isActive ? 'Active' : 'Disabled',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: user.isActive
                          ? Colors.green
                          : theme.colorScheme.onSurfaceVariant,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Switch(
                  value: user.isActive,
                  onChanged: adminState.isLoading
                      ? null
                      : (value) => onToggleActive(value),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _showRoleDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Change Role'),
        content: RadioGroup<UserRole>(
          groupValue: user.role,
          onChanged: (value) {
            if (value != null) {
              Navigator.pop(context);
              onChangeRole(value);
            }
          },
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: UserRole.values
                .map(
                  (role) => RadioListTile<UserRole>(
                    title: Text(role.displayName),
                    value: role,
                  ),
                )
                .toList(),
          ),
        ),
      ),
    );
  }

  String _formatDate(DateTime date) {
    return '${date.day}/${date.month}/${date.year}';
  }
}

/// A short coloured note under the details of a user.
class _NoticeChip extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String text;

  const _NoticeChip({
    required this.icon,
    required this.color,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: AppSpacing.xs,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(AppBorderRadius.sm),
      ),
      child: Row(
        children: [
          Icon(icon, size: 14, color: color),
          const SizedBox(width: AppSpacing.xs),
          Expanded(
            child: Text(
              text,
              style: theme.textTheme.labelSmall?.copyWith(color: color),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

class _RoleBadge extends StatelessWidget {
  final UserRole role;

  const _RoleBadge({required this.role});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    Color color;
    switch (role) {
      case UserRole.student:
        color = Colors.blue;
        break;
      case UserRole.owner:
        color = Colors.green;
        break;
      case UserRole.admin:
        color = Colors.purple;
        break;
    }
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: AppSpacing.xs,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(AppBorderRadius.full),
      ),
      child: Text(
        role.displayName,
        style: theme.textTheme.labelSmall?.copyWith(color: color),
      ),
    );
  }
}
