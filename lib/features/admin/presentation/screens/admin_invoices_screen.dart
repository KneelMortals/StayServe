import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../models/join_request_model.dart';
import '../providers/admin_providers.dart';
import '../widgets/admin_scaffold.dart';

class AdminInvoicesScreen extends ConsumerWidget {
  const AdminInvoicesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return DefaultTabController(
      length: 3,
      child: AdminScaffold(
        title: 'All Invoices',
        bottom: const TabBar(
          tabs: [
            Tab(text: 'Pending'),
            Tab(text: 'Paid'),
            Tab(text: 'Overdue'),
          ],
        ),
        body: const TabBarView(
          children: [
            _AdminInvoicesTab(status: InvoiceStatus.pending),
            _AdminInvoicesTab(status: InvoiceStatus.paid),
            _AdminInvoicesTab(status: InvoiceStatus.overdue),
          ],
        ),
      ),
    );
  }
}

class _AdminInvoicesTab extends ConsumerWidget {
  final InvoiceStatus status;

  const _AdminInvoicesTab({required this.status});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final invoicesAsync = ref.watch(adminInvoicesProvider(status));

    return invoicesAsync.when(
      data: (invoices) {
        if (invoices.isEmpty) {
          return Center(child: Text('No ${status.label.toLowerCase()} invoices'));
        }
        return ListView.builder(
          padding: const EdgeInsets.all(AppSpacing.md),
          itemCount: invoices.length,
          itemBuilder: (context, index) => _AdminInvoiceCard(
            invoice: invoices[index],
            onMarkPaid: () => _showMarkPaidDialog(context, ref, invoices[index]),
            onCancel: () => _confirmCancelInvoice(context, ref, invoices[index]),
            onTap: () => context.push('/invoice/${invoices[index].invoiceId}'),
          ),
        );
      },
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, stack) => Center(child: Text('Error: $error')),
    );
  }

  void _showMarkPaidDialog(BuildContext context, WidgetRef ref, CommissionInvoiceModel invoice) {
    final screenContext = context;

    showDialog<_InvoicePayment>(
      context: context,
      builder: (dialogContext) => _MarkInvoicePaidDialog(invoice: invoice),
    ).then((payment) async {
      if (payment == null || !screenContext.mounted) return;
      final error = await ref
          .read(adminControllerProvider.notifier)
          .markInvoicePaid(
            invoice.invoiceId,
            paymentReference: payment.reference.isNotEmpty ? payment.reference : null,
            paymentMethod: payment.method.isNotEmpty ? payment.method : null,
            upiTransactionId: payment.upiTransactionId.isNotEmpty ? payment.upiTransactionId : null,
          );
      if (!screenContext.mounted) return;
      if (screenContext.showErrorIfAny(error)) return;
      screenContext.showSuccessSnackBar('Invoice marked as paid');
    });
  }

  void _confirmCancelInvoice(BuildContext context, WidgetRef ref, CommissionInvoiceModel invoice) {
    final screenContext = context;

    showDialog<bool>(
      context: context,
      builder: (dialogContext) => _ConfirmCancelInvoiceDialog(invoice: invoice),
    ).then((confirmed) async {
      if (confirmed != true || !screenContext.mounted) return;
      final error = await ref
          .read(adminControllerProvider.notifier)
          .cancelInvoice(invoice.invoiceId);
      if (!screenContext.mounted) return;
      if (screenContext.showErrorIfAny(error)) return;
      screenContext.showSuccessSnackBar('Invoice cancelled');
    });
  }
}

/// The payment details of an invoice that is marked as paid.
class _InvoicePayment {
  final String reference;
  final String method;
  final String upiTransactionId;

  const _InvoicePayment({
    required this.reference,
    required this.method,
    required this.upiTransactionId,
  });
}

/// The dialog that asks how an invoice was paid.
///
/// The three controllers belong to the dialog — controllers that are
/// created in the caller leak one controller every time the dialog is
/// opened.
class _MarkInvoicePaidDialog extends StatefulWidget {
  final CommissionInvoiceModel invoice;

  const _MarkInvoicePaidDialog({required this.invoice});

  @override
  State<_MarkInvoicePaidDialog> createState() => _MarkInvoicePaidDialogState();
}

class _MarkInvoicePaidDialogState extends State<_MarkInvoicePaidDialog> {
  final _paymentRefController = TextEditingController();
  final _paymentMethodController = TextEditingController();
  final _upiTxnController = TextEditingController();

  @override
  void dispose() {
    _paymentRefController.dispose();
    _paymentMethodController.dispose();
    _upiTxnController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final invoice = widget.invoice;

    return AlertDialog(
      title: const Text('Mark as Paid'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Invoice: ${invoice.invoiceId}', style: theme.textTheme.titleSmall),
            Text(
              'Amount: ₹${invoice.commissionAmount.toInt()}',
              style: theme.textTheme.titleMedium?.copyWith(color: theme.colorScheme.primary),
            ),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: _paymentRefController,
              decoration: const InputDecoration(
                labelText: 'Payment Reference',
                hintText: 'Optional',
              ),
            ),
            TextField(
              controller: _paymentMethodController,
              decoration: const InputDecoration(
                labelText: 'Payment Method',
                hintText: 'e.g., UPI, Bank Transfer',
              ),
            ),
            TextField(
              controller: _upiTxnController,
              decoration: const InputDecoration(
                labelText: 'UPI Transaction ID',
                hintText: 'Optional',
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(
            context,
            _InvoicePayment(
              reference: _paymentRefController.text.trim(),
              method: _paymentMethodController.text.trim(),
              upiTransactionId: _upiTxnController.text.trim(),
            ),
          ),
          child: const Text('Mark Paid'),
        ),
      ],
    );
  }
}

/// The dialog that asks why an invoice is cancelled.
class _ConfirmCancelInvoiceDialog extends StatelessWidget {
  final CommissionInvoiceModel invoice;

  const _ConfirmCancelInvoiceDialog({required this.invoice});

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Cancel Invoice'),
      content: Text('Are you sure you want to cancel invoice ${invoice.invoiceId}?'),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, true),
          style: TextButton.styleFrom(foregroundColor: Colors.red),
          child: const Text('Cancel Invoice'),
        ),
      ],
    );
  }
}

class _AdminInvoiceCard extends StatelessWidget {
  final CommissionInvoiceModel invoice;
  final VoidCallback onMarkPaid;
  final VoidCallback onCancel;
  final VoidCallback onTap;

  const _AdminInvoiceCard({
    required this.invoice,
    required this.onMarkPaid,
    required this.onCancel,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    Color statusColor;
    switch (invoice.status) {
      case InvoiceStatus.pending:
        statusColor = Colors.orange;
        break;
      case InvoiceStatus.paid:
        statusColor = Colors.green;
        break;
      case InvoiceStatus.overdue:
        statusColor = Colors.red;
        break;
      case InvoiceStatus.cancelled:
        statusColor = Colors.grey;
        break;
    }

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppBorderRadius.lg),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
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
                          invoice.invoiceId,
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: theme.colorScheme.primary,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          'Room: ${invoice.roomId}',
                          style: theme.textTheme.titleMedium,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          'Owner: ${invoice.ownerId} • Tenant: ${invoice.tenantId}',
                          style: theme.textTheme.bodySmall,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
                    decoration: BoxDecoration(
                      color: statusColor.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(AppBorderRadius.full),
                    ),
                    child: Text(
                      invoice.status.label,
                      style: theme.textTheme.labelSmall?.copyWith(color: statusColor),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.md),
              Divider(color: theme.colorScheme.outlineVariant),
              const SizedBox(height: AppSpacing.md),
              // The rent and the commission are in a `Wrap` — side by side
              // in a `Row` they did not fit on a narrow phone.
              Wrap(
                spacing: AppSpacing.xl,
                runSpacing: AppSpacing.sm,
                children: [
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Monthly Rent', style: theme.textTheme.bodySmall),
                      Text(
                        '₹${invoice.monthlyRent.toInt()}',
                        style: theme.textTheme.titleMedium,
                      ),
                    ],
                  ),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Commission (${invoice.commissionPercentage.toInt()}%)',
                        style: theme.textTheme.bodySmall,
                      ),
                      Text(
                        '₹${invoice.commissionAmount.toInt()}',
                        style: theme.textTheme.titleMedium?.copyWith(
                          color: theme.colorScheme.primary,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
              if (invoice.paidAt != null) ...[
                const SizedBox(height: AppSpacing.sm),
                Text('Paid on: ${_formatDate(invoice.paidAt!)}', style: theme.textTheme.bodySmall?.copyWith(color: Colors.green)),
                if (invoice.paymentReference != null)
                  Text('Ref: ${invoice.paymentReference}', style: theme.textTheme.bodySmall),
              ],
              if (invoice.status == InvoiceStatus.pending) ...[
                const SizedBox(height: AppSpacing.md),
                Row(
                  children: [
                    Expanded(
                      child: AppButton(
                        label: 'Mark as Paid',
                        onPressed: onMarkPaid,
                        type: ButtonType.primary,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.md),
                    Expanded(
                      child: AppButton(
                        label: 'Cancel',
                        onPressed: onCancel,
                        type: ButtonType.danger,
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  String _formatDate(DateTime date) {
    return '${date.day}/${date.month}/${date.year} ${date.hour}:${date.minute.toString().padLeft(2, '0')}';
  }
}