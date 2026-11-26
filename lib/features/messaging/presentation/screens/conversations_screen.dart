import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../features/auth/presentation/providers/auth_provider.dart';
import '../../../../../models/messaging_model.dart';
import '../providers/messaging_providers.dart';

class ConversationsScreen extends ConsumerWidget {
  const ConversationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(title: const Text('Messages')),
      body: const ConversationsList(),
    );
  }
}

/// The list of the conversations of the current user.
///
/// It deliberately has **no scaffold of its own**: the admin area puts it
/// into its own frame, so the drawer, the notification bell and the log out
/// button are there on a phone as well. The plain conversation screen used
/// to be routed into the admin area directly, which replaced the whole
/// admin frame with a bare `Scaffold` — the administrator lost the
/// navigation, the notifications and the log out button.
class ConversationsList extends ConsumerWidget {
  const ConversationsList({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final conversationsAsync = ref.watch(conversationsProvider);
    final currentUid = ref.watch(currentUserProvider)?.uid ?? '';

    return conversationsAsync.when(
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
            const Text('Could not load conversations'),
            const SizedBox(height: AppSpacing.md),
            TextButton(
              onPressed: () => ref.invalidate(conversationsProvider),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
      data: (conversations) {
        if (conversations.isEmpty) {
          return const EmptyState(
            icon: Icons.chat_bubble_outline,
            title: 'No Conversations',
            message: 'Messages with owners and students will show up here.',
          );
        }

        return RefreshIndicator(
          onRefresh: () async {
            // The indicator has to wait for the **new** data —
            // `invalidate` returns nothing, so the spinner
            // disappeared while the list was still loading.
            final _ = await ref.refresh(conversationsProvider.future);
          },
          child: ListView.builder(
            padding: const EdgeInsets.all(AppSpacing.md),
            itemCount: conversations.length,
            itemBuilder: (context, index) {
              final conversation = conversations[index];
              final otherParticipant = conversation.getPeerForViewer(
                currentUid,
              );
              return _ConversationTile(
                conversation: conversation,
                peerId: otherParticipant,
                unread: conversation.getUnreadCountForViewer(currentUid) > 0,
                onTap: () => context.push(
                  Uri(
                    path: '/chat/${conversation.conversationId}',
                    queryParameters: {
                      'peer': otherParticipant,
                      if (conversation.roomId?.isNotEmpty ?? false)
                        'room': conversation.roomId!,
                    },
                  ).toString(),
                ),
              );
            },
          ),
        );
      },
    );
  }
}

class _ConversationTile extends ConsumerWidget {
  final ConversationModel conversation;
  final String peerId;
  final bool unread;
  final VoidCallback onTap;

  const _ConversationTile({
    required this.conversation,
    required this.peerId,
    required this.unread,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final detailsAsync = ref.watch(
      conversationInteractionDetailsProvider((
        conversationId: conversation.conversationId,
        roomId: conversation.roomId,
        requestId: null,
      )),
    );
    final details = detailsAsync.valueOrNull;
    final name = details?.peerName.isNotEmpty == true
        ? details!.peerName
        : conversation.getParticipantName(peerId).isNotEmpty
        ? conversation.getParticipantName(peerId)
        : peerId.isNotEmpty
        ? peerId
        : 'Loading participant…';
    final roomTitle = details?.roomTitle.isNotEmpty == true
        ? details!.roomTitle
        : conversation.roomTitle;
    final isAdminPeer =
        conversation.isAdminSupport && conversation.adminId == peerId;

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppBorderRadius.lg),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            children: [
              Stack(
                children: [
                  AppAvatar(name: name, radius: 24),
                  if (unread)
                    Positioned(
                      right: 0,
                      top: 0,
                      child: Container(
                        width: 12,
                        height: 12,
                        decoration: BoxDecoration(
                          color: theme.colorScheme.primary,
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: theme.colorScheme.surface,
                            width: 2,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            name,
                            style: theme.textTheme.titleMedium?.copyWith(
                              fontWeight: unread
                                  ? FontWeight.w700
                                  : FontWeight.w500,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (isAdminPeer) ...[
                          const SizedBox(width: AppSpacing.xs),
                          const Icon(
                            Icons.verified,
                            size: 16,
                            color: Colors.blue,
                          ),
                          const SizedBox(width: 3),
                          Text(
                            'Admin',
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: Colors.blue,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ],
                    ),
                    if (roomTitle.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        roomTitle,
                        style: theme.textTheme.labelMedium?.copyWith(
                          color: theme.colorScheme.primary,
                          fontWeight: FontWeight.w600,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      conversation.lastMessage.isEmpty
                          ? 'No messages yet'
                          : conversation.lastMessage,
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
              Text(
                AppFormatters.formatRelativeTime(conversation.lastMessageAt),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
