import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/messaging/conversation_repository.dart';
import '../../../../../firebase/owner/owner_repository.dart';
import '../../../../../models/join_request_model.dart';
import '../../../messaging/presentation/providers/messaging_providers.dart';
import '../../../messaging/presentation/widgets/interaction_status_notice.dart';
import '../../../payments/presentation/widgets/platform_fee_sheet.dart';
import '../providers/owner_providers.dart';

class OwnerRequestsScreen extends ConsumerStatefulWidget {
  const OwnerRequestsScreen({super.key});

  @override
  ConsumerState<OwnerRequestsScreen> createState() =>
      _OwnerRequestsScreenState();
}

class _OwnerRequestsScreenState extends ConsumerState<OwnerRequestsScreen> {
  String? _busyRequestId;

  @override
  Widget build(BuildContext context) {
    final requestsAsync = ref.watch(myJoinRequestsProvider);

    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Requests'),
          bottom: TabBar(
            tabs: const [
              Tab(text: 'Pending'),
              Tab(text: 'All Requests'),
            ],
          ),
        ),
        body: requestsAsync.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (error, stackTrace) {
            // The reason is logged: the screen itself keeps a friendly
            // message, but a support request needs the real cause.
            AppLogger.error(
              'Could not load the join requests of the owner',
              error: error,
              stackTrace: stackTrace,
            );
            return Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    Icons.error_outline,
                    size: 64,
                    color: Theme.of(context).colorScheme.error,
                  ),
                  const SizedBox(height: AppSpacing.md),
                  const Text('Could not load requests'),
                  const SizedBox(height: AppSpacing.md),
                  TextButton(
                    onPressed: () => ref.invalidate(myJoinRequestsProvider),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            );
          },
          data: (requests) {
            // The two tabs are built from their **own** lists. The old code
            // derived the list from `_tabIndex`, so after visiting "All
            // Requests" the "Pending" tab showed every request as well.
            final pending = requests
                .where((r) => r.status == JoinRequestStatus.pending)
                .toList();

            return TabBarView(
              children: [
                _buildList(
                  pending,
                  'No Pending Requests',
                  'New join requests will show up here.',
                ),
                _buildList(
                  requests,
                  'No Requests Yet',
                  'Requests from students will show up here.',
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildList(
    List<JoinRequestModel> requests,
    String emptyTitle,
    String emptyMessage,
  ) {
    if (requests.isEmpty) {
      return EmptyState(
        icon: Icons.mail_outline,
        title: emptyTitle,
        message: emptyMessage,
      );
    }

    return RefreshIndicator(
      onRefresh: () async {
        // The indicator has to wait for the **new** data —
        // `invalidate` returns nothing, so the spinner
        // disappeared while the list was still loading.
        final _ = await ref.refresh(myJoinRequestsProvider.future);
      },
      child: ListView.builder(
        padding: const EdgeInsets.all(AppSpacing.md),
        itemCount: requests.length,
        itemBuilder: (context, index) {
          final request = requests[index];
          return Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.md),
            child: _JoinRequestCard(
              request: request,
              isBusy: _busyRequestId == request.requestId,
              onConfirm: () => _confirmRequest(request),
              onReject: () => _rejectRequest(request),
              onCancel: () => _cancelRequest(request),
              onPayFee: () => _payPlatformFee(request),
              onOpenRoom: () => context.push('/room/${request.roomId}'),
              onMessage: () => _openChat(request),
              onToggleBlock: (name, blockedByMe) =>
                  _toggleBlock(request, name, blockedByMe),
            ),
          );
        },
      ),
    );
  }

  Future<void> _confirmRequest(JoinRequestModel request) async {
    setState(() => _busyRequestId = request.requestId);
    try {
      await ref.read(ownerRepositoryProvider).confirmRequest(request.requestId);
      if (!mounted) return;
      _showSnack(
        'Request accepted — waiting for the student to confirm',
        isError: false,
      );
    } catch (e) {
      if (!mounted) return;
      _showSnack(readableAuthError(e), isError: true);
    } finally {
      if (mounted) setState(() => _busyRequestId = null);
    }
  }

  Future<void> _rejectRequest(JoinRequestModel request) async {
    final reason = await showDialog<String>(
      context: context,
      builder: (context) => _RejectDialog(),
    );
    if (reason == null || !mounted) return;

    setState(() => _busyRequestId = request.requestId);
    try {
      await ref
          .read(ownerRepositoryProvider)
          .rejectRequest(request.requestId, reason: reason);
      if (!mounted) return;
      _showSnack('Request declined', isError: false);
    } catch (e) {
      if (!mounted) return;
      _showSnack(readableAuthError(e), isError: true);
    } finally {
      if (mounted) setState(() => _busyRequestId = null);
    }
  }

  /// Opens the verified conversation for this student and listing.
  Future<void> _openChat(JoinRequestModel request) async {
    setState(() => _busyRequestId = request.requestId);
    try {
      final opened = await ref
          .read(conversationRepositoryProvider)
          .openConversation(
            request.studentId,
            roomId: request.roomId,
            requestId: request.requestId,
          );
      if (!mounted) return;
      context.push(
        Uri(
          path: '/chat/${opened.conversationId}',
          queryParameters: {
            'peer': request.studentId,
            'room': request.roomId,
            'request': request.requestId,
          },
        ).toString(),
      );
    } catch (e) {
      if (!mounted) return;
      _showSnack(readableAuthError(e), isError: true);
    } finally {
      if (mounted) setState(() => _busyRequestId = null);
    }
  }

  /// Blocks or unblocks the student on the other side of this request.
  Future<void> _toggleBlock(
    JoinRequestModel request,
    String studentName,
    bool blockedByMe,
  ) async {
    final shouldChange = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          blockedByMe ? 'Unblock $studentName?' : 'Block $studentName?',
        ),
        content: Text(
          blockedByMe
              ? 'You will be able to exchange messages and continue this '
                    'booking.'
              : 'You will not be able to exchange new messages or advance '
                    'this booking until you unblock $studentName.',
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

    setState(() => _busyRequestId = request.requestId);
    try {
      final repository = ref.read(conversationRepositoryProvider);
      if (blockedByMe) {
        await repository.unblockUser(request.studentId);
      } else {
        await repository.blockUser(
          request.studentId,
          requestId: request.requestId,
        );
      }
      if (!mounted) return;
      invalidateParticipantInteractionProviders(
        ref,
        conversationId: conversationIdForParticipants(
          request.studentId,
          request.ownerId,
        ),
        roomId: request.roomId,
        requestId: request.requestId,
      );
      ref.invalidate(myJoinRequestsProvider);
      _showSnack(
        blockedByMe
            ? '$studentName was unblocked.'
            : '$studentName was blocked.',
        isError: false,
      );
    } catch (e) {
      if (!mounted) return;
      _showSnack(readableAuthError(e), isError: true);
    } finally {
      if (mounted) setState(() => _busyRequestId = null);
    }
  }

  void _showSnack(String message, {required bool isError}) {
    final theme = Theme.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? theme.colorScheme.error : null,
      ),
    );
  }

  /// The owner walks away from a booking they already approved.
  ///
  /// This is only possible while nothing was paid for the booking — the
  /// server refuses it otherwise. The student is told about it.
  Future<void> _cancelRequest(JoinRequestModel request) async {
    final reason = await showDialog<String>(
      context: context,
      builder: (context) => _CancelBookingDialog(),
    );
    if (reason == null || !mounted) return;

    setState(() => _busyRequestId = request.requestId);
    try {
      await ref
          .read(ownerRepositoryProvider)
          .cancelRequest(request.requestId, reason: reason);
      if (!mounted) return;
      _showSnack('Request cancelled', isError: false);
    } catch (e) {
      if (!mounted) return;
      _showSnack(readableAuthError(e), isError: true);
    } finally {
      if (mounted) setState(() => _busyRequestId = null);
    }
  }

  /// The owner pays the platform fee of a booking.
  ///
  /// The cut belongs to the **first** payment of a booking and is paid to
  /// the platform's own UPI — the owner never has to upload a UPI of their
  /// own. Once it has been paid, every later payment goes straight from
  /// the student to the owner.
  Future<void> _payPlatformFee(JoinRequestModel request) async {
    setState(() => _busyRequestId = request.requestId);
    try {
      final submitted = await showPlatformFeeSheet(
        context,
        request,
        title: 'Pay the StayServe platform fee',
      );
      if (!mounted) return;
      if (submitted) {
        _showSnack(
          'Platform fee submitted for verification — awaiting admin '
          'verification.',
          isError: false,
        );
      }
    } catch (e) {
      if (!mounted) return;
      _showSnack(readableAuthError(e), isError: true);
    } finally {
      if (mounted) setState(() => _busyRequestId = null);
    }
  }
}

class _JoinRequestCard extends ConsumerWidget {
  final JoinRequestModel request;
  final bool isBusy;
  final VoidCallback onConfirm;
  final VoidCallback onReject;
  final VoidCallback onCancel;
  final VoidCallback onPayFee;
  final VoidCallback onOpenRoom;
  final VoidCallback onMessage;
  final void Function(String name, bool blockedByMe) onToggleBlock;

  const _JoinRequestCard({
    required this.request,
    required this.isBusy,
    required this.onConfirm,
    required this.onReject,
    required this.onCancel,
    required this.onPayFee,
    required this.onOpenRoom,
    required this.onMessage,
    required this.onToggleBlock,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final isPending = request.status == JoinRequestStatus.pending;
    final detailsAsync = ref.watch(
      bookingInteractionDetailsProvider(request.requestId),
    );
    final details = detailsAsync.valueOrNull;
    // The server-resolved metadata is authoritative. The request fields are
    // only a fallback for the short time before the callable has answered;
    // they may contain an older name or title.
    final studentName = details?.studentName.trim().isNotEmpty == true
        ? details!.studentName.trim()
        : request.studentName.trim().isNotEmpty
        ? request.studentName.trim()
        : request.studentId;
    final roomTitle = details?.roomTitle.trim().isNotEmpty == true
        ? details!.roomTitle.trim()
        : request.roomTitle.trim().isNotEmpty
        ? request.roomTitle.trim()
        : request.roomId;
    final isBlocked = details?.isBlocked ?? false;
    final blockedByMe = details?.blockedByMe ?? false;
    final blockedMe = details?.blockedMe ?? false;
    // The server owns the current block state. Until it has answered, every
    // action which advances the interaction stays disabled. A refresh is
    // also a loading state: a previously cached value must not keep an
    // action enabled while the server is revalidating it.
    final interactionReady =
        details != null && !detailsAsync.isLoading && !detailsAsync.hasError;
    final progressionBlocked = !interactionReady || isBlocked;

    return AppCard(
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              AppAvatar(name: studentName, radius: 20),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      studentName,
                      style: theme.textTheme.titleMedium,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      roomTitle,
                      style: theme.textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      AppFormatters.formatRelativeTime(request.createdAt),
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.sm,
                  vertical: AppSpacing.xs,
                ),
                decoration: BoxDecoration(
                  color: _statusColor(request.status).withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(AppBorderRadius.full),
                ),
                child: Text(
                  request.status.label,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: _statusColor(request.status),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          if (isBlocked) ...[
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.sm),
              decoration: BoxDecoration(
                color: theme.colorScheme.errorContainer,
                borderRadius: BorderRadius.circular(AppBorderRadius.md),
              ),
              child: Text(
                blockedByMe && blockedMe
                    ? 'You and $studentName have blocked each other.'
                    : blockedByMe
                    ? 'You blocked $studentName. Unblock them to continue.'
                    : '$studentName blocked you. You can still decline or '
                          'cancel this request.',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onErrorContainer,
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.md),
          ],
          Text(
            'Rent at request: ${AppFormatters.formatCurrency(request.monthlyRentAtJoin)}/month',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            request.platformCutTaken
                ? 'Platform fee: verified and settled — the rent is paid directly to you'
                : 'Platform fee: '
                      '${request.commissionPercentageAtJoin.toStringAsFixed(0)}% '
                      '(${AppFormatters.formatCurrency(request.commissionAmount)})'
                      ' — payer: '
                      '${request.platformFeePayer == 'owner' ? 'you' : 'the student'}',
            style: theme.textTheme.bodySmall,
          ),
          if (_canPayFee && request.platformFeePayer == 'owner') ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              'When ready, submit it once to our UPI '
              '${AppConstants.platformUpiVpa} for verification.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: AppSpacing.md),
          _buildLifecycleNotice(theme),
          if (!interactionReady) ...[
            const SizedBox(height: AppSpacing.md),
            InteractionStatusNotice(
              isLoading: detailsAsync.isLoading,
              onRetry: () => ref.invalidate(
                bookingInteractionDetailsProvider(request.requestId),
              ),
            ),
          ],
          const SizedBox(height: AppSpacing.md),
          // The buttons are put in a `Wrap` and not in a `Row`: three
          // buttons side by side did not fit on a narrow phone, and the
          // labels ran into each other.
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: [
              _actionButton('View Room', onOpenRoom, ButtonType.secondary),
              _actionButton(
                'Message student',
                isBusy || progressionBlocked ? null : onMessage,
                ButtonType.secondary,
              ),
              if (blockedByMe)
                _actionButton(
                  'Unblock student',
                  isBusy || !interactionReady
                      ? null
                      : () => onToggleBlock(studentName, true),
                  ButtonType.primary,
                )
              else if (!blockedMe)
                _actionButton(
                  'Block student',
                  isBusy || !interactionReady
                      ? null
                      : () => onToggleBlock(studentName, false),
                  ButtonType.danger,
                ),
              if (isPending) ...[
                _actionButton(
                  'Decline',
                  isBusy ? null : onReject,
                  ButtonType.danger,
                ),
                _actionButton(
                  'Approve',
                  isBusy || progressionBlocked ? null : onConfirm,
                  ButtonType.primary,
                ),
              ],
              // The owner may also walk away from a request they already
              // accepted — as long as nothing was paid for it yet.
              if (_canCancel) ...[
                _actionButton(
                  'Cancel request',
                  isBusy ? null : onCancel,
                  ButtonType.danger,
                ),
              ],
              if (_canPayFee) ...[
                _actionButton(
                  'Pay platform fee',
                  isBusy || progressionBlocked ? null : onPayFee,
                  ButtonType.primary,
                ),
              ] else if (_canShowFeeDetails) ...[
                // The student settles the fee for this booking — the owner
                // still gets the payment screen, so the amount and the
                // state of the payment are visible on both sides.
                _actionButton(
                  'Payment details',
                  isBusy || progressionBlocked ? null : onPayFee,
                  ButtonType.secondary,
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  /// Explains the next step without treating an accepted or submitted
  /// request as an active booking.
  Widget _buildLifecycleNotice(ThemeData theme) {
    final paymentStatus = request.advancePaymentStatus;
    final paymentVerified =
        request.advancePaid || paymentStatus == PaymentStatus.verified;

    late final IconData icon;
    late final Color color;
    late final String title;
    late final String subtitle;

    switch (request.status) {
      case JoinRequestStatus.pending:
        icon = Icons.schedule;
        color = Colors.orange;
        title = 'Waiting for your approval';
        subtitle =
            'Approve the request next. The student must then confirm before '
            'the platform fee can be paid.';
        break;
      case JoinRequestStatus.ownerConfirmed:
        icon = Icons.check_circle_outline;
        color = Colors.green;
        title = 'Owner accepted';
        subtitle =
            'Waiting for the student to confirm. The platform fee is not '
            'payable until the student confirms.';
        break;
      case JoinRequestStatus.studentConfirmed:
        if (paymentStatus == PaymentStatus.submitted) {
          icon = Icons.hourglass_top;
          color = Colors.blue;
          title = 'Platform fee submitted for verification';
          subtitle =
              'Awaiting admin verification. The room is not active until the '
              'payment is verified.';
        } else if (paymentStatus == PaymentStatus.rejected) {
          icon = Icons.error_outline;
          color = Colors.red;
          title = 'Platform fee could not be verified';
          subtitle =
              'The request is payable again and must be resubmitted for admin '
              'verification.';
        } else if (paymentVerified) {
          icon = Icons.verified;
          color = Colors.green;
          title = 'Platform fee verified';
          subtitle =
              'The request is waiting for the admin-reviewed booking state. It '
              'is not active yet.';
        } else {
          icon = Icons.check_circle_outline;
          color = Colors.blue;
          title = 'Student confirmed';
          subtitle = request.platformFeePayer == 'owner'
              ? 'You can now submit the platform fee for admin verification.'
              : 'The student must now submit the platform fee for admin '
                    'verification.';
        }
        break;
      case JoinRequestStatus.adminReviewed:
        icon = Icons.task_alt;
        color = Colors.teal;
        title = paymentVerified
            ? 'Payment verified — booking activated'
            : 'Booking admin-reviewed and activated';
        subtitle =
            'An admin reviewed the request and the room is now active for the '
            'student.';
        break;
      case JoinRequestStatus.rejected:
        icon = Icons.cancel_outlined;
        color = Colors.grey;
        title = 'Request declined';
        subtitle = 'This request is closed and no longer needs a payment.';
        break;
      case JoinRequestStatus.cancelled:
        if (paymentVerified || request.platformCutTaken) {
          icon = Icons.event_busy_outlined;
          color = Colors.teal;
          title = 'Booking ended — payment history retained';
          subtitle =
              'This booking is no longer active. Payment and invoice history '
              'remain unchanged; no refund is implied.';
        } else {
          icon = Icons.cancel_outlined;
          color = Colors.grey;
          title = 'Request cancelled';
          subtitle = 'This request is closed and no longer needs a payment.';
        }
        break;
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: color),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: theme.textTheme.labelLarge?.copyWith(color: color),
                ),
                const SizedBox(height: 2),
                Text(subtitle, style: theme.textTheme.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Whether the owner may still walk away from this booking.
  ///
  /// The acceptance alone is not a payment — the booking can be walked away
  /// from as long as **nothing** was paid for it. The server makes the very
  /// same check.
  ///
  /// The button is only offered for a booking the owner has **accepted**:
  /// for a request that is still pending the owner has "Approve" and
  /// "Decline" — and cancelling it would be the same thing as declining it,
  /// only with a confusing label.
  bool get _canCancel => request.canBeCancelled && request.isOwnerAccepted;

  /// Whether the owner has to settle the platform fee for this request.
  ///
  /// The cut belongs to the **first** payment of a booking and is paid
  /// once — afterwards the rent goes straight from the student to the
  /// owner. A payment cannot be submitted until both the owner and the
  /// student have confirmed the request.
  bool get _canPayFee {
    if (request.status != JoinRequestStatus.studentConfirmed) return false;
    if (request.platformCutTaken) return false;
    if (request.platformFeePayer != 'owner') return false;
    if (request.advancePaid) return false;
    if (request.advancePaymentStatus == PaymentStatus.submitted) return false;
    if (request.advancePaymentStatus == PaymentStatus.verified) return false;
    return true;
  }

  /// Whether the payment sheet can be opened for this request.
  ///
  /// The sheet is available on **both** sides of a payable request: the owner
  /// sees who settles the fee and how much it is, even when the student is
  /// the one who has to pay it. It opens only after student confirmation.
  bool get _canShowFeeDetails {
    if (request.status != JoinRequestStatus.studentConfirmed) return false;
    if (request.platformCutTaken) return false;
    if (request.advancePaid) return false;
    if (request.advancePaymentStatus == PaymentStatus.submitted) return false;
    if (request.advancePaymentStatus == PaymentStatus.verified) return false;
    return true;
  }

  /// One button of the action row.
  Widget _actionButton(String label, VoidCallback? onPressed, ButtonType type) {
    return SizedBox(
      width: 150,
      child: AppButton(
        label: label,
        onPressed: onPressed,
        isFullWidth: true,
        type: type,
      ),
    );
  }

  Color _statusColor(JoinRequestStatus status) {
    switch (status) {
      case JoinRequestStatus.pending:
        return Colors.orange;
      case JoinRequestStatus.studentConfirmed:
        return Colors.blue;
      case JoinRequestStatus.ownerConfirmed:
        return Colors.green;
      case JoinRequestStatus.adminReviewed:
        return Colors.teal;
      case JoinRequestStatus.rejected:
      case JoinRequestStatus.cancelled:
        return Colors.grey;
    }
  }
}

class _CancelBookingDialog extends StatefulWidget {
  @override
  State<_CancelBookingDialog> createState() => _CancelBookingDialogState();
}

class _CancelBookingDialogState extends State<_CancelBookingDialog> {
  final _reasonController = TextEditingController();

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Cancel this request?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'The request will be closed and the student will be told that you '
            'cancelled it.',
          ),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _reasonController,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Reason (optional)',
              hintText: 'Let the student know why',
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Keep request'),
        ),
        FilledButton(
          onPressed: () =>
              Navigator.pop(context, _reasonController.text.trim()),
          child: const Text('Cancel request'),
        ),
      ],
    );
  }
}

class _RejectDialog extends StatefulWidget {
  @override
  State<_RejectDialog> createState() => _RejectDialogState();
}

class _RejectDialogState extends State<_RejectDialog> {
  final _reasonController = TextEditingController();

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Decline request'),
      content: TextField(
        controller: _reasonController,
        maxLines: 3,
        decoration: const InputDecoration(
          labelText: 'Reason (optional)',
          hintText: 'Let the student know why',
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () =>
              Navigator.pop(context, _reasonController.text.trim()),
          child: const Text('Decline'),
        ),
      ],
    );
  }
}
