import 'dart:async';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/index.dart';
import '../../../../../features/auth/presentation/providers/auth_provider.dart';
import '../../../../../firebase/messaging/conversation_repository.dart';
import '../../../../../models/interaction_model.dart';
import '../../../../../models/messaging_model.dart';
import '../providers/messaging_providers.dart';

/// The longest message the server accepts.
///
/// The body of the chat notification is the message itself, and the server
/// refuses a notification whose body is longer than 1000 characters.
const int maxMessageLength = 1000;

class ChatScreen extends ConsumerStatefulWidget {
  final String conversationId;

  /// The uid of the other participant.
  ///
  /// It is handed over through the route (`/chat/<id>?peer=<uid>`) so that
  /// the message input does not depend on the conversation *list* — that
  /// list is only a convenience, and while it is loading (or if it fails)
  /// the chat would have no input field at all.
  final String? peerId;

  /// The listing context which opened this conversation.
  final String? roomId;
  final String? requestId;

  const ChatScreen({
    required this.conversationId,
    this.peerId,
    this.roomId,
    this.requestId,
    super.key,
  });

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final _controller = TextEditingController();
  final _scrollController = ScrollController();
  final _focusNode = FocusNode();
  bool _isSending = false;
  bool _isChangingBlock = false;

  /// The recipient of the messages.
  String? _receiverId;

  ConversationInteractionKey get _interactionKey => (
    conversationId: widget.conversationId,
    roomId: widget.roomId,
    requestId: widget.requestId,
  );

  @override
  void initState() {
    super.initState();

    // The recipient that came with the route is used right away.
    _receiverId = widget.peerId;

    // Otherwise it is read from the conversation document.
    if (_receiverId == null || _receiverId!.isEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadReceiver());
    }

    // Opening the chat clears the unread badge. Without this the counter
    // kept growing even though the user had read every message.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref
          .read(conversationRepositoryProvider)
          .markConversationRead(widget.conversationId);
      ref.invalidate(conversationsProvider);
    });
  }

  /// Reads the other participant of the conversation from Firestore.
  Future<void> _loadReceiver() async {
    final receiverId = await ref
        .read(conversationRepositoryProvider)
        .getOtherParticipant(widget.conversationId);
    if (!mounted) return;
    if (receiverId == null || receiverId.isEmpty) return;
    setState(() => _receiverId = receiverId);
  }

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (!_scrollController.hasClients) return;
    _scrollController.animateTo(
      _scrollController.position.maxScrollExtent,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
    );
  }

  Future<void> _send(String receiverId, bool canSend) async {
    final text = _controller.text.trim();
    if (text.isEmpty || _isSending) return;

    if (!canSend) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text(
            'Messaging is unavailable while this participant is blocked.',
          ),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
      return;
    }

    // The server refuses a notification whose body is longer than 1000
    // characters. The message itself would be stored, but the recipient
    // would never be told about it — so the limit is enforced here, where
    // the user can still see it.
    if (text.length > maxMessageLength) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'A message can be at most $maxMessageLength characters long',
          ),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
      return;
    }

    setState(() => _isSending = true);
    try {
      await ref
          .read(conversationRepositoryProvider)
          .sendMessage(
            conversationId: widget.conversationId,
            receiverId: receiverId,
            content: text,
          );

      // The screen may have been closed while the message was on its way.
      // Touching the controller (or the scroll controller) of a screen that
      // is gone throws — the message was sent, but the app crashed.
      if (!mounted) return;

      _controller.clear();
      _scrollToBottom();
      // The conversation list shows the unread counter and the last message,
      // so it has to be refreshed after a new message.
      ref.invalidate(conversationsProvider);
    } catch (e) {
      if (!mounted) return;
      // A concurrent block is rejected by the Firestore rules. Reload the
      // server-owned state so the composer changes to its read-only form.
      ref.invalidate(conversationInteractionDetailsProvider(_interactionKey));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    } finally {
      if (mounted) setState(() => _isSending = false);
    }
  }

  Future<void> _toggleBlock({
    required String peerId,
    required String peerName,
    required bool blockedByMe,
    required bool blockedMe,
  }) async {
    if (_isChangingBlock) return;

    if (blockedMe && !blockedByMe) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('$peerName blocked you. You cannot send messages.'),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
      return;
    }

    final shouldChange = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(blockedByMe ? 'Unblock $peerName?' : 'Block $peerName?'),
        content: Text(
          blockedByMe
              ? 'You will be able to exchange messages again.'
              : 'You will not be able to exchange new messages or advance '
                    'this booking until you unblock $peerName.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(blockedByMe ? 'Unblock' : 'Block'),
          ),
        ],
      ),
    );
    if (shouldChange != true || !mounted) return;

    setState(() => _isChangingBlock = true);
    try {
      final repository = ref.read(conversationRepositoryProvider);
      if (blockedByMe) {
        await repository.unblockUser(peerId);
      } else {
        await repository.blockUser(
          peerId,
          conversationId: widget.conversationId,
          requestId: widget.requestId,
        );
      }
      if (!mounted) return;
      invalidateParticipantInteractionProviders(
        ref,
        conversationId: widget.conversationId,
        roomId: widget.roomId,
        requestId: widget.requestId,
      );
      ref.invalidate(conversationsProvider);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            blockedByMe ? '$peerName was unblocked.' : '$peerName was blocked.',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    } finally {
      if (mounted) setState(() => _isChangingBlock = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final messagesAsync = ref.watch(messagesProvider(widget.conversationId));
    final conversationsAsync = ref.watch(conversationsProvider);
    final detailsAsync = ref.watch(
      conversationInteractionDetailsProvider(_interactionKey),
    );
    final details = detailsAsync.valueOrNull;

    // ---------------------------------------------------------------------
    // Messages that arrive while the chat is open are read right away.
    //
    // The counter of unread messages is raised by the **sender** — also
    // when the recipient has the chat open at that very moment. The badge
    // in the conversation list then kept counting messages the user had
    // already read.
    // ---------------------------------------------------------------------
    ref.listen(messagesProvider(widget.conversationId), (previous, next) {
      final before = previous?.valueOrNull?.length ?? 0;
      final after = next.valueOrNull?.length ?? 0;
      if (after <= before) return;
      unawaited(
        ref
            .read(conversationRepositoryProvider)
            .markConversationRead(widget.conversationId),
      );
      ref.invalidate(conversationsProvider);
    });

    ConversationModel? conversation;
    for (final candidate
        in conversationsAsync.valueOrNull ?? const <ConversationModel>[]) {
      if (candidate.conversationId == widget.conversationId) {
        conversation = candidate;
        break;
      }
    }

    // The server-resolved peer id and name are authoritative. The route and
    // the stored conversation are only fallbacks while the details load.
    var receiverId = details?.peerId ?? _receiverId;
    final storedPeerName =
        conversation?.getParticipantName(
          details?.peerId ?? _receiverId ?? '',
        ) ??
        '';
    final peerName = details?.peerName.isNotEmpty == true
        ? details!.peerName
        : storedPeerName.isNotEmpty
        ? storedPeerName
        : receiverId?.trim().isNotEmpty == true
        ? receiverId!
        : 'Loading participant…';
    final roomTitle = details?.roomTitle.isNotEmpty == true
        ? details!.roomTitle
        : conversation?.roomTitle ?? '';

    // Messaging fails closed until the server confirms that neither side
    // has blocked the other. A refresh is a loading state too, so a stale
    // cached value cannot keep the composer enabled while the server
    // revalidates the block state.
    final interactionReady =
        details != null && !detailsAsync.isLoading && !detailsAsync.hasError;
    final canSend = interactionReady && details.canSend;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(peerName, maxLines: 1, overflow: TextOverflow.ellipsis),
            if (roomTitle.isNotEmpty)
              Text(
                roomTitle,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: details?.blockedByMe == true
                ? 'Unblock $peerName'
                : details?.blockedMe == true
                ? '$peerName blocked you'
                : 'Block $peerName',
            icon: Icon(
              details?.blockedByMe == true ? Icons.lock_open : Icons.block,
            ),
            onPressed:
                !interactionReady ||
                    receiverId == null ||
                    receiverId.isEmpty ||
                    _isChangingBlock ||
                    (details.blockedMe && !details.blockedByMe)
                ? null
                : () => _toggleBlock(
                    peerId: receiverId,
                    peerName: peerName,
                    blockedByMe: details.blockedByMe,
                    blockedMe: details.blockedMe,
                  ),
          ),
        ],
      ),
      body: Column(
        children: [
          if (details != null && details.isBlocked)
            _BlockNotice(details: details, peerName: peerName),
          if (detailsAsync.hasError)
            _InteractionErrorNotice(
              onRetry: () => ref.invalidate(
                conversationInteractionDetailsProvider(_interactionKey),
              ),
            ),
          Expanded(
            child: messagesAsync.when(
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
                    const Text('Could not load messages'),
                    const SizedBox(height: AppSpacing.md),
                    TextButton(
                      onPressed: () => ref.invalidate(
                        messagesProvider(widget.conversationId),
                      ),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
              data: (messages) {
                if (messages.isEmpty) {
                  return const EmptyState(
                    icon: Icons.chat_bubble_outline,
                    title: 'No Messages Yet',
                    message: 'Start the conversation!',
                  );
                }

                WidgetsBinding.instance.addPostFrameCallback(
                  (_) => _scrollToBottom(),
                );

                final currentUid = ref.watch(currentUserProvider)?.uid ?? '';
                return ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.all(AppSpacing.md),
                  itemCount: messages.length,
                  itemBuilder: (context, index) {
                    final message = messages[index];
                    final isMine = message.senderId == currentUid;
                    return _MessageBubble(message: message, isMine: isMine);
                  },
                );
              },
            ),
          ),
          if (receiverId != null && receiverId.isNotEmpty)
            _MessageInput(
              controller: _controller,
              focusNode: _focusNode,
              isSending: _isSending,
              enabled: canSend,
              onSend: () => _send(receiverId, canSend),
            ),
        ],
      ),
    );
  }
}

class _BlockNotice extends StatelessWidget {
  final ConversationInteractionDetails details;
  final String peerName;

  const _BlockNotice({required this.details, required this.peerName});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final message = details.blockedByMe && details.blockedMe
        ? 'You and $peerName have blocked each other.'
        : details.blockedByMe
        ? 'You blocked $peerName. Unblock them to send messages.'
        : '$peerName blocked you. You cannot send new messages.';

    return Container(
      width: double.infinity,
      color: theme.colorScheme.errorContainer,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      child: Row(
        children: [
          Icon(Icons.block, color: theme.colorScheme.onErrorContainer),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              message,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onErrorContainer,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _InteractionErrorNotice extends StatelessWidget {
  final VoidCallback onRetry;

  const _InteractionErrorNotice({required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      color: theme.colorScheme.errorContainer,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.sm,
      ),
      child: Row(
        children: [
          Icon(Icons.warning_amber, color: theme.colorScheme.onErrorContainer),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              'Could not verify the conversation status. Messaging is paused.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onErrorContainer,
              ),
            ),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  final MessageModel message;
  final bool isMine;

  const _MessageBubble({required this.message, required this.isMine});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Align(
      alignment: isMine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: AppSpacing.sm),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.sm,
        ),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.75,
        ),
        decoration: BoxDecoration(
          color: isMine
              ? theme.colorScheme.primary
              : theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(AppBorderRadius.lg),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              message.content,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: isMine ? theme.colorScheme.onPrimary : null,
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              AppFormatters.formatDateTime(message.createdAt),
              style: theme.textTheme.labelSmall?.copyWith(
                color: isMine
                    ? theme.colorScheme.onPrimary.withValues(alpha: 0.7)
                    : theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MessageInput extends StatelessWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool isSending;
  final bool enabled;
  final VoidCallback onSend;

  const _MessageInput({
    required this.controller,
    required this.focusNode,
    required this.isSending,
    required this.enabled,
    required this.onSend,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          top: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: controller,
              focusNode: focusNode,
              enabled: enabled,
              textInputAction: TextInputAction.send,
              maxLength: maxMessageLength,
              decoration: InputDecoration(
                hintText: enabled
                    ? 'Type a message...'
                    : 'Messaging is unavailable',
                counterText: '',
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: BorderSide(
                    color: theme.colorScheme.outlineVariant,
                  ),
                ),
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 8,
                ),
                filled: true,
                fillColor: theme.colorScheme.surfaceContainerHighest,
              ),
              onSubmitted: enabled ? (_) => onSend() : null,
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          IconButton.filled(
            icon: const Icon(Icons.send),
            onPressed: enabled && !isSending ? onSend : null,
          ),
        ],
      ),
    );
  }
}
