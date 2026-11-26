import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/index.dart';
import '../../../../firebase/messaging/conversation_repository.dart';
import '../../../../models/messaging_model.dart';
import '../../../../models/user_model.dart';

/// Writes the first verified administrator message to a student or owner.
///
/// The actual send is performed by `sendAdminMessage`, so the server owns
/// the conversation id, the sender fields and the verified administrator
/// marker. The client cannot make an ordinary message look like an
/// administrator message.
class AdminMessageDialog extends ConsumerStatefulWidget {
  final UserModel recipient;

  const AdminMessageDialog({required this.recipient, super.key});

  /// Opens the dialog and returns the server result when it was sent.
  static Future<AdminMessageResult?> show(
    BuildContext context,
    UserModel recipient,
  ) {
    return showDialog<AdminMessageResult>(
      context: context,
      builder: (_) => AdminMessageDialog(recipient: recipient),
    );
  }

  @override
  ConsumerState<AdminMessageDialog> createState() => _AdminMessageDialogState();
}

class _AdminMessageDialogState extends ConsumerState<AdminMessageDialog> {
  final _controller = TextEditingController();
  final _focusNode = FocusNode();

  late final AdminMessageRequestTracker _requestTracker;
  bool _isSending = false;

  @override
  void initState() {
    super.initState();
    _requestTracker = AdminMessageRequestTracker(
      () => ref.read(conversationRepositoryProvider).newAdminMessageRequestId(),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final content = _controller.text.trim();
    if (content.isEmpty || _isSending) return;

    setState(() => _isSending = true);
    try {
      final result = await ref
          .read(conversationRepositoryProvider)
          .sendAdminMessage(
            userId: widget.recipient.uid,
            content: content,
            requestId: _requestTracker.requestIdFor(
              content,
              scope: widget.recipient.uid,
            ),
          );
      _requestTracker.markSucceeded(content, scope: widget.recipient.uid);
      if (!mounted) return;
      Navigator.of(context).pop(result);
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            error.toString().replaceFirst('Exception: ', '').trim(),
          ),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    } finally {
      if (mounted) setState(() => _isSending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final role = widget.recipient.role.displayName;

    return AlertDialog(
      title: Text('Message ${widget.recipient.name}'),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'This message is sent from the verified StayServe Admin account.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              'Recipient: ${widget.recipient.name} · $role',
              style: theme.textTheme.labelMedium,
            ),
            const SizedBox(height: AppSpacing.sm),
            TextField(
              controller: _controller,
              focusNode: _focusNode,
              autofocus: true,
              enabled: !_isSending,
              minLines: 3,
              maxLines: 6,
              maxLength: 1000,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'Message',
                hintText: 'Write a support message…',
                alignLabelWithHint: true,
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _isSending ? null : () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton.icon(
          onPressed: _isSending ? null : _send,
          icon: _isSending
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.send),
          label: const Text('Send message'),
        ),
      ],
    );
  }
}
