import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/index.dart';
import '../../../../../models/join_request_model.dart';
import '../../../payments/presentation/widgets/platform_fee_sheet.dart';
import '../providers/student_providers.dart';
import '../widgets/room_visit_sheet.dart';

/// Standalone screen with every join request the student has sent.
///
/// The payment itself is server-authoritative: the app only launches a UPI
/// intent that the Cloud Function issued, and the reference the student
/// enters is recorded as *submitted* — an admin has to verify it before the
/// booking is activated.
class StudentRequestsScreen extends ConsumerWidget {
  const StudentRequestsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('My Requests'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.invalidate(myJoinRequestsProvider),
          ),
        ],
      ),
      body: const StudentRequestsView(),
    );
  }
}

/// The request list. Used both as a standalone screen body and as the
/// "Requests" tab inside the joined-rooms screen.
class StudentRequestsView extends ConsumerStatefulWidget {
  const StudentRequestsView({super.key});

  @override
  ConsumerState<StudentRequestsView> createState() =>
      _StudentRequestsViewState();
}

class _StudentRequestsViewState extends ConsumerState<StudentRequestsView> {
  String? _busyRequestId;

  @override
  Widget build(BuildContext context) {
    final requestsAsync = ref.watch(myJoinRequestsProvider);

    return requestsAsync.when(
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
            const Text('Could not load your requests'),
            const SizedBox(height: AppSpacing.md),
            TextButton(
              onPressed: () => ref.invalidate(myJoinRequestsProvider),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
      data: (requests) {
        if (requests.isEmpty) {
          return EmptyState(
            icon: Icons.inbox_outlined,
            title: 'No Requests Yet',
            message:
                'When you request a room it will show up here, together with '
                'the platform fee status.',
            actionLabel: 'Browse Rooms',
            onAction: () => context.go('/student/search'),
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
                child: _StudentRequestCard(
                  request: request,
                  isBusy: _busyRequestId == request.requestId,
                  onConfirm: () => _confirmRequest(request),
                  onPay: () => _startPayment(request),
                  onCancel: () => _cancelRequest(request),
                  onOpenRoom: () => context.push('/room/${request.roomId}'),
                  onVisit: () => showRoomVisitSheet(context, request.roomId),
                  onReview: () =>
                      context.push('/room/${request.roomId}/reviews'),
                ),
              );
            },
          ),
        );
      },
    );
  }

  /// Confirms the request after the owner accepted it.
  ///
  /// Student confirmation and payment submission are deliberately separate:
  /// the platform fee becomes payable only after this transition succeeds.
  Future<void> _confirmRequest(JoinRequestModel request) async {
    setState(() => _busyRequestId = request.requestId);
    try {
      await ref
          .read(studentJoinRequestProvider)
          .studentConfirmJoin(request.requestId);
      if (!mounted) return;
      ref.invalidate(myJoinRequestsProvider);
      _showSnack(
        request.platformFeePayer == 'owner'
            ? 'Request confirmed — waiting for the owner to submit the platform fee'
            : 'Request confirmed — submit the platform fee for verification',
        isError: false,
      );
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    } finally {
      if (mounted) setState(() => _busyRequestId = null);
    }
  }

  Future<void> _startPayment(JoinRequestModel request) async {
    setState(() => _busyRequestId = request.requestId);
    try {
      await _showPaymentSheet(request);
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceFirst('Exception: ', ''), isError: true);
    } finally {
      if (mounted) setState(() => _busyRequestId = null);
    }
  }

  Future<void> _showPaymentSheet(JoinRequestModel request) async {
    final submitted = await showPlatformFeeSheet(context, request);

    if (!mounted) return;
    if (submitted == true) {
      ref.invalidate(myJoinRequestsProvider);
      _showSnack(
        'Payment submitted for verification — awaiting admin verification.',
        isError: false,
      );
    }
  }

  Future<void> _cancelRequest(JoinRequestModel request) async {
    final reason = await showDialog<String>(
      context: context,
      builder: (context) => const _CancelRequestDialog(),
    );
    if (reason == null || !mounted) return;

    setState(() => _busyRequestId = request.requestId);
    try {
      await ref
          .read(studentJoinRequestProvider)
          .cancelJoinRequest(request.requestId, reason: reason);
      if (!mounted) return;
      ref.invalidate(myJoinRequestsProvider);
      _showSnack('Request cancelled', isError: false);
    } catch (e) {
      if (!mounted) return;
      _showSnack(e.toString().replaceFirst('Exception: ', ''), isError: true);
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
}

/// One request card.
class _StudentRequestCard extends ConsumerWidget {
  final JoinRequestModel request;
  final bool isBusy;
  final VoidCallback onConfirm;
  final VoidCallback onPay;
  final VoidCallback onCancel;
  final VoidCallback onOpenRoom;
  final VoidCallback onVisit;
  final VoidCallback onReview;

  const _StudentRequestCard({
    required this.request,
    required this.isBusy,
    required this.onConfirm,
    required this.onPay,
    required this.onCancel,
    required this.onOpenRoom,
    required this.onVisit,
    required this.onReview,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final roomAsync = ref.watch(roomProvider(request.roomId));
    final room = roomAsync.valueOrNull;

    final fee = request.commissionAmount;
    final paymentStatus = request.advancePaymentStatus;
    final canPay = _canPay;

    // When the room owner settles the platform fee, the student does not
    // pay anything to the platform — they only confirm the booking.
    final ownerPaysFee = request.platformFeePayer == 'owner';

    return AppCard(
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      room?.title ?? 'Room ${request.roomId}',
                      style: theme.textTheme.titleMedium,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      AppFormatters.formatRelativeTime(request.createdAt),
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
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
          Text(
            'Rent: ${AppFormatters.formatCurrency(request.monthlyRentAtJoin)}/month',
            style: theme.textTheme.bodyMedium,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            request.platformCutTaken
                ? 'Platform fee: settled — the rent goes directly to the '
                      'room owner'
                : ownerPaysFee
                ? 'Platform fee (${request.commissionPercentageAtJoin.toStringAsFixed(0)}%): '
                      '${AppFormatters.formatCurrency(fee)} — payer: room owner'
                : 'Platform fee (${request.commissionPercentageAtJoin.toStringAsFixed(0)}%): '
                      '${AppFormatters.formatCurrency(fee)} — payer: student',
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: AppSpacing.md),
          _PaymentStatusBanner(request: request, paymentStatus: paymentStatus),
          if (request.rejectionReason != null &&
              request.rejectionReason!.trim().isNotEmpty) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              'Reason: ${request.rejectionReason}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ],
          const SizedBox(height: AppSpacing.md),
          // The buttons are put in a `Wrap` and not in a `Row`: with the
          // extra "Visit" and "Review" buttons three of them did not fit on
          // a narrow phone any more.
          Wrap(
            spacing: AppSpacing.sm,
            runSpacing: AppSpacing.sm,
            children: [
              _actionButton('View Room', onOpenRoom, ButtonType.secondary),
              // Once the owner accepted the request the student knows where
              // the room is and may review it.
              if (request.isOwnerAccepted) ...[
                _actionButton('Visit room', onVisit, ButtonType.primary),
                _actionButton('Write a review', onReview, ButtonType.secondary),
              ],
              if (request.status == JoinRequestStatus.ownerConfirmed)
                _actionButton(
                  'Confirm Request',
                  isBusy ? null : onConfirm,
                  ButtonType.primary,
                ),
              if (canPay)
                _actionButton(
                  paymentStatus == PaymentStatus.rejected
                      ? 'Pay Again'
                      : 'Pay Platform Fee',
                  isBusy ? null : onPay,
                  ButtonType.primary,
                ),
              // A student may withdraw only before the booking is activated.
              // After activation, the room owner or an administrator ends
              // the joined room by making the listing available again.
              if (canCancel)
                _actionButton(
                  'Cancel',
                  isBusy ? null : onCancel,
                  ButtonType.danger,
                ),
            ],
          ),
        ],
      ),
    );
  }

  /// Whether the student may still withdraw this booking request.
  ///
  /// Once the booking is activated the room is joined and cannot be
  /// cancelled from the student side.
  bool get canCancel => request.canStudentCancel && !isClosed;

  /// Whether the request is over — it was declined or cancelled.
  bool get isClosed =>
      request.status == JoinRequestStatus.rejected ||
      request.status == JoinRequestStatus.cancelled;

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

  /// The fee can be paid only after the owner and the student have both
  /// confirmed, and only when the student is the payer.
  bool get _canPay {
    if (request.status != JoinRequestStatus.studentConfirmed) return false;
    if (request.platformFeePayer == 'owner') return false;
    if (request.advancePaid) return false;
    if (request.advancePaymentStatus == PaymentStatus.submitted) return false;
    if (request.advancePaymentStatus == PaymentStatus.verified) return false;
    // Still payable while the payment is missing or was rejected.
    return request.advancePaymentStatus == null ||
        request.advancePaymentStatus == PaymentStatus.rejected;
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

/// Asks the student whether they really want to cancel — and why.
class _CancelRequestDialog extends StatefulWidget {
  const _CancelRequestDialog();

  @override
  State<_CancelRequestDialog> createState() => _CancelRequestDialogState();
}

class _CancelRequestDialogState extends State<_CancelRequestDialog> {
  final _reasonController = TextEditingController();

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Cancel request?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'The owner will be notified that you are no longer interested.',
          ),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _reasonController,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Reason (optional)',
              hintText: 'Let the owner know why',
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Keep it'),
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

/// Explains where the payment stands.
class _PaymentStatusBanner extends StatelessWidget {
  final JoinRequestModel request;
  final PaymentStatus? paymentStatus;

  const _PaymentStatusBanner({
    required this.request,
    required this.paymentStatus,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    // An availability release ends an active booking without rewriting its
    // payment history. The request is closed now; it is not waiting for an
    // activation that will never happen again.
    if (request.status == JoinRequestStatus.cancelled &&
        (request.advancePaid ||
            paymentStatus == PaymentStatus.verified ||
            request.platformCutTaken)) {
      return _banner(
        context,
        icon: Icons.event_busy_outlined,
        color: Colors.teal,
        title: 'Booking ended — payment history retained',
        subtitle:
            'This booking is no longer active. Payment and invoice history '
            'remain unchanged; no refund is implied.',
      );
    }

    // `adminReviewed` is the only request state that makes the room joined.
    // The legacy `admin_reviewed` spelling is normalised by the model before
    // it reaches this screen.
    if (request.status == JoinRequestStatus.adminReviewed) {
      return _banner(
        context,
        icon: Icons.task_alt,
        color: Colors.teal,
        title: 'Booking activated — room joined',
        subtitle:
            'The request is Admin Reviewed and the room is active. It now '
            'appears in Joined Rooms.',
      );
    }

    if (paymentStatus == PaymentStatus.submitted) {
      return _banner(
        context,
        icon: Icons.hourglass_top,
        color: Colors.blue,
        title: 'Payment submitted — awaiting verification',
        subtitle:
            'Ref: ${request.advancePaymentReference ?? '-'}. The submission is '
            'awaiting admin verification. The room is not active until the '
            'payment is verified.',
      );
    }

    if (request.advancePaid || paymentStatus == PaymentStatus.verified) {
      return _banner(
        context,
        icon: Icons.verified,
        color: Colors.green,
        title: 'Payment verified — awaiting booking activation',
        subtitle:
            'The payment was verified, but this request is not yet Admin '
            'Reviewed. The room is not joined yet.',
      );
    }

    if (paymentStatus == PaymentStatus.rejected) {
      return _banner(
        context,
        icon: Icons.error_outline,
        color: Colors.red,
        title: 'Payment rejected — awaiting payment again',
        subtitle: request.platformFeePayer == 'owner'
            ? 'The owner must resubmit the platform fee for verification. The '
                  'room stays inactive until the payment is verified.'
            : 'Check the transaction reference and submit the payment again. '
                  'The room stays inactive until the payment is verified.',
      );
    }

    if (request.status == JoinRequestStatus.ownerConfirmed) {
      return _banner(
        context,
        icon: Icons.check_circle_outline,
        color: Colors.green,
        title: 'Owner accepted — your confirmation is required',
        subtitle:
            'The owner accepted your request. Confirm your request next. The '
            'platform fee becomes payable only after your confirmation.',
      );
    }

    if (request.status == JoinRequestStatus.studentConfirmed) {
      return _banner(
        context,
        icon: Icons.check_circle_outline,
        color: Colors.blue,
        title: 'Student confirmed — payment required',
        subtitle: request.platformFeePayer == 'owner'
            ? 'The room owner must now submit the platform fee for admin '
                  'verification. The room is activated only after verification.'
            : 'Submit the '
                  '${AppFormatters.formatCurrency(request.commissionAmount)} '
                  'platform fee for admin verification. The room is activated '
                  'only after verification.',
      );
    }

    if (request.status == JoinRequestStatus.pending) {
      return _banner(
        context,
        icon: Icons.schedule,
        color: Colors.orange,
        title: 'Waiting for the owner',
        subtitle:
            'The owner must approve your request first. The platform fee is '
            'not payable yet.',
      );
    }

    if (request.status == JoinRequestStatus.rejected) {
      return _banner(
        context,
        icon: Icons.cancel_outlined,
        color: Colors.grey,
        title: 'Request declined',
        subtitle: 'The owner declined this request. No payment is due.',
      );
    }

    if (request.status == JoinRequestStatus.cancelled) {
      return _banner(
        context,
        icon: Icons.cancel_outlined,
        color: Colors.grey,
        title: 'Request cancelled',
        subtitle: 'This request was cancelled. No payment is due.',
      );
    }

    return _banner(
      context,
      icon: Icons.info_outline,
      color: theme.colorScheme.onSurfaceVariant,
      title: 'Waiting for the next step',
      subtitle: 'No platform fee has been submitted for this request yet.',
    );
  }

  Widget _banner(
    BuildContext context, {
    required IconData icon,
    required Color color,
    required String title,
    required String subtitle,
  }) {
    final theme = Theme.of(context);
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
}
