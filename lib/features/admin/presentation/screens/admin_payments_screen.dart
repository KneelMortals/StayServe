import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/index.dart';
import '../../../../firebase/index.dart';
import '../../../../models/payment_model.dart';
import '../../../messaging/presentation/providers/messaging_providers.dart';
import '../providers/admin_providers.dart';
import '../widgets/admin_scaffold.dart';

/// Lets an admin verify (or reject) platform-fee payments.
///
/// This screen is the human side of the server-authoritative payment flow:
/// submission records the payment as `submitted` only. Verifying it confirms
/// that the money arrived, activates the booking and moves the request to
/// `adminReviewed`. Rejecting it returns the request to a payable /
/// awaiting-confirmation state.
class AdminPaymentsScreen extends ConsumerWidget {
  const AdminPaymentsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return DefaultTabController(
      length: 3,
      child: AdminScaffold(
        title: 'Payments',
        bottom: const TabBar(
          isScrollable: true,
          tabAlignment: TabAlignment.start,
          tabs: [
            Tab(text: 'Awaiting Verification'),
            Tab(text: 'Verified'),
            Tab(text: 'Rejected'),
          ],
        ),
        body: const TabBarView(
          children: [
            _AdminPaymentsTab(status: PaymentStatus.submitted),
            _AdminPaymentsTab(status: PaymentStatus.verified),
            _AdminPaymentsTab(status: PaymentStatus.rejected),
          ],
        ),
      ),
    );
  }
}

class _AdminPaymentsTab extends ConsumerWidget {
  final PaymentStatus status;

  const _AdminPaymentsTab({required this.status});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final paymentsAsync = ref.watch(adminPaymentsProvider(status));

    return paymentsAsync.when(
      data: (payments) {
        if (payments.isEmpty) {
          return Center(
            child: Text('No ${status.label.toLowerCase()} payments'),
          );
        }
        return RefreshIndicator(
          onRefresh: () async {
            // The indicator has to wait for the **new** data —
            // `invalidate` returns nothing, so the spinner
            // disappeared while the list was still loading.
            final _ = await ref.refresh(adminPaymentsProvider(status).future);
          },
          child: ListView.builder(
            padding: const EdgeInsets.all(AppSpacing.md),
            itemCount: payments.length,
            itemBuilder: (context, index) {
              final payment = payments[index];
              return _AdminPaymentCard(
                payment: payment,
                onVerify: () => _verify(context, ref, payment, approve: true),
                onReject: () => _verify(context, ref, payment, approve: false),
              );
            },
          ),
        );
      },
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, stack) => Center(child: Text('Error: $error')),
    );
  }

  Future<void> _verify(
    BuildContext context,
    WidgetRef ref,
    PaymentModel payment, {
    required bool approve,
  }) async {
    String? note;

    if (!approve) {
      // The controller of the text field belongs to the dialog — a
      // controller that is created here leaks one every time the dialog is
      // opened.
      note = await showDialog<String>(
        context: context,
        builder: (context) => const _RejectPaymentDialog(),
      );
      if (note == null) return;
    } else {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Verify payment'),
          content: Text(
            'Confirm that ₹${payment.amount.toStringAsFixed(0)} was actually '
            'received for reference ${payment.reference}.\n\n'
            'Verification activates the booking, creates the commission invoice '
            'and moves the request to Admin Reviewed.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Verify'),
            ),
          ],
        ),
      );
      if (confirmed != true) return;
    }

    if (!context.mounted) return;

    try {
      await ref
          .read(paymentRepositoryProvider)
          .verifyPayment(
            requestId: payment.requestId,
            approve: approve,
            note: note,
          );
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            approve
                ? 'Payment verified — booking activated and request admin-reviewed'
                : 'Payment rejected — booking returned to a payable / '
                      'awaiting-confirmation state',
          ),
        ),
      );
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    }
  }
}

/// The dialog that asks why a payment is rejected.
///
/// It owns its text controller — a controller that is created in the caller
/// and never disposed leaks one controller every time the dialog is opened.
class _RejectPaymentDialog extends StatefulWidget {
  const _RejectPaymentDialog();

  @override
  State<_RejectPaymentDialog> createState() => _RejectPaymentDialogState();
}

class _RejectPaymentDialogState extends State<_RejectPaymentDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Reject payment'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Rejecting returns the booking to a payable / awaiting-confirmation '
            'state. If this is a legacy booking that was already active, its '
            'room occupancy is released.',
          ),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _controller,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Reason (optional)',
              hintText: 'Let the student know what went wrong',
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, _controller.text.trim()),
          style: TextButton.styleFrom(foregroundColor: Colors.red),
          child: const Text('Reject'),
        ),
      ],
    );
  }
}

class _AdminPaymentCard extends ConsumerWidget {
  final PaymentModel payment;
  final VoidCallback onVerify;
  final VoidCallback onReject;

  const _AdminPaymentCard({
    required this.payment,
    required this.onVerify,
    required this.onReject,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final details = ref
        .watch(bookingInteractionDetailsProvider(payment.requestId))
        .valueOrNull;
    final roomLabel = details?.roomTitle.trim().isNotEmpty == true
        ? details!.roomTitle.trim()
        : payment.roomId;
    final studentLabel = details?.studentName.trim().isNotEmpty == true
        ? details!.studentName.trim()
        : payment.studentId;
    final ownerLabel = details?.ownerName.trim().isNotEmpty == true
        ? details!.ownerName.trim()
        : payment.ownerId;
    final statusColor = switch (payment.status) {
      PaymentStatus.submitted => Colors.orange,
      PaymentStatus.verified => Colors.green,
      PaymentStatus.rejected => Colors.red,
    };

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
                      'Request ${payment.requestId}',
                      style: theme.textTheme.titleMedium,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Room: $roomLabel',
                      style: theme.textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      'Student: $studentLabel',
                      style: theme.textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      'Owner: $ownerLabel',
                      style: theme.textTheme.bodySmall,
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
                  vertical: AppSpacing.xs,
                ),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(AppBorderRadius.full),
                ),
                child: Text(
                  payment.status.label,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: statusColor,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Divider(color: theme.colorScheme.outlineVariant),
          const SizedBox(height: AppSpacing.md),
          // The amount and the payee are in a `Wrap` — side by side in a
          // `Row` the long UPI address ran off the card.
          Wrap(
            spacing: AppSpacing.xl,
            runSpacing: AppSpacing.sm,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    payment.status == PaymentStatus.verified
                        ? 'Amount received'
                        : 'Amount submitted',
                    style: theme.textTheme.bodySmall,
                  ),
                  Text(
                    AppFormatters.formatCurrency(payment.amount),
                    style: theme.textTheme.titleLarge?.copyWith(
                      color: theme.colorScheme.primary,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Payee', style: theme.textTheme.bodySmall),
                  Text(payment.payeeVpa, style: theme.textTheme.bodyMedium),
                ],
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(
            'Reference: ${payment.reference}',
            style: theme.textTheme.bodySmall,
          ),
          Text(
            'Submitted: ${_formatDateTime(payment.submittedAt)}',
            style: theme.textTheme.bodySmall,
          ),
          if (payment.verifiedAt != null)
            Text(
              'Reviewed: ${_formatDateTime(payment.verifiedAt!)}',
              style: theme.textTheme.bodySmall?.copyWith(color: statusColor),
            ),
          if (payment.note != null && payment.note!.trim().isNotEmpty)
            Text(
              'Note: ${payment.note}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          if (payment.status == PaymentStatus.submitted) ...[
            const SizedBox(height: AppSpacing.md),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.sm),
              decoration: BoxDecoration(
                color: theme.colorScheme.primaryContainer.withValues(
                  alpha: 0.5,
                ),
                borderRadius: BorderRadius.circular(AppBorderRadius.md),
              ),
              child: Text(
                'Verification activates the booking and moves the request to '
                'Admin Reviewed. Rejection returns it to a payable / '
                'awaiting-confirmation state.',
                style: theme.textTheme.bodySmall,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            Row(
              children: [
                Expanded(
                  child: AppButton(
                    label: 'Reject',
                    onPressed: onReject,
                    isFullWidth: true,
                    type: ButtonType.danger,
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: AppButton(
                    label: 'Verify Payment',
                    onPressed: onVerify,
                    isFullWidth: true,
                    type: ButtonType.primary,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  String _formatDateTime(DateTime date) {
    return '${date.day}/${date.month}/${date.year} '
        '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
  }
}
