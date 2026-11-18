import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/index.dart';
import '../../../../../models/join_request_model.dart';
import '../providers/invoice_providers.dart';

class InvoiceDetailScreen extends ConsumerWidget {
  final String invoiceId;

  const InvoiceDetailScreen({required this.invoiceId, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final invoiceAsync = ref.watch(invoiceProvider(invoiceId));

    return Scaffold(
      appBar: AppBar(title: Text('Invoice $invoiceId')),
      body: invoiceAsync.when(
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
              const Text('Could not load this invoice'),
              const SizedBox(height: AppSpacing.md),
              TextButton(
                onPressed: () => ref.invalidate(invoiceProvider(invoiceId)),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
        data: (invoice) {
          if (invoice == null) {
            return const EmptyState(
              icon: Icons.receipt_outlined,
              title: 'Invoice Not Found',
              message: 'This invoice may have been removed.',
            );
          }
          return _InvoiceBody(invoice: invoice);
        },
      ),
    );
  }
}

class _InvoiceBody extends ConsumerWidget {
  final CommissionInvoiceModel invoice;

  const _InvoiceBody({required this.invoice});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final statusColor = switch (invoice.status) {
      InvoiceStatus.pending => Colors.orange,
      InvoiceStatus.paid => Colors.green,
      InvoiceStatus.overdue => Colors.red,
      InvoiceStatus.cancelled => Colors.grey,
    };

    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        Card(
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpacing.lg),
            decoration: BoxDecoration(
              color: statusColor.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(AppBorderRadius.lg),
            ),
            child: Column(
              children: [
                Icon(
                  invoice.status == InvoiceStatus.paid
                      ? Icons.check_circle
                      : Icons.pending,
                  size: 48,
                  color: statusColor,
                ),
                const SizedBox(height: AppSpacing.md),
                Text(
                  invoice.status.label,
                  style: theme.textTheme.headlineSmall?.copyWith(
                    color: statusColor,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  'Commission: ${AppFormatters.formatCurrency(invoice.commissionAmount)}',
                  style: theme.textTheme.titleLarge?.copyWith(
                    color: theme.colorScheme.primary,
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: AppSpacing.lg),
        _buildSection(
          context,
          'Invoice Details',
          [
            _row(context, 'Invoice ID', invoice.invoiceId),
            _row(context, 'Created', AppFormatters.formatDateTime(invoice.createdAt)),
            _row(context, 'Monthly Rent', AppFormatters.formatCurrency(invoice.monthlyRent)),
            _row(
              context,
              'Commission (${invoice.commissionPercentage.toStringAsFixed(0)}%)',
              AppFormatters.formatCurrency(invoice.commissionAmount),
            ),
            _row(context, 'Room ID', invoice.roomId),
            _row(context, 'Join Request', invoice.joinRequestId),
          ],
        ),
        if (invoice.status == InvoiceStatus.paid) ...[
          const SizedBox(height: AppSpacing.lg),
          _buildSection(
            context,
            'Payment',
            [
              // `paidAt` was force-unwrapped here, which crashed the screen
              // for a paid invoice whose `paidAt` was missing (older
              // documents, or an invoice marked as paid without a
              // timestamp).
              _row(
                context,
                'Paid At',
                invoice.paidAt == null
                    ? 'Not recorded'
                    : AppFormatters.formatDateTime(invoice.paidAt!),
              ),
              if (invoice.paymentReference != null)
                _row(context, 'Reference', invoice.paymentReference!),
              if (invoice.upiTransactionId != null)
                _row(context, 'UPI Transaction', invoice.upiTransactionId!),
            ],
          ),
        ],
        const SizedBox(height: AppSpacing.lg),
        _buildParties(context),
      ],
    );
  }

  Widget _buildSection(
    BuildContext context,
    String title,
    List<Widget> children,
  ) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            ...children,
          ],
        ),
      ),
    );
  }

  Widget _row(BuildContext context, String label, String value) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 2,
            child: Text(label, style: theme.textTheme.bodyMedium),
          ),
          Expanded(
            flex: 3,
            child: Text(
              value,
              style: theme.textTheme.bodyMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
              textAlign: TextAlign.right,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildParties(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Parties', style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            Text('Owner ID', style: theme.textTheme.bodySmall),
            Text(invoice.ownerId, style: theme.textTheme.bodyMedium),
            const SizedBox(height: AppSpacing.md),
            Text('Tenant ID', style: theme.textTheme.bodySmall),
            Text(invoice.tenantId, style: theme.textTheme.bodyMedium),
          ],
        ),
      ),
    );
  }
}
