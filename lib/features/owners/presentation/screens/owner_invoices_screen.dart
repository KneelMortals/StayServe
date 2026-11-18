import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../models/join_request_model.dart';
import '../providers/owner_providers.dart';

class OwnerInvoicesScreen extends ConsumerStatefulWidget {
  const OwnerInvoicesScreen({super.key});

  @override
  ConsumerState<OwnerInvoicesScreen> createState() => _OwnerInvoicesScreenState();
}

class _OwnerInvoicesScreenState extends ConsumerState<OwnerInvoicesScreen> {
  @override
  Widget build(BuildContext context) {
    final invoicesAsync = ref.watch(myInvoicesProvider);

    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Invoices'),
          bottom: const TabBar(
            tabs: [
              Tab(text: 'Pending'),
              Tab(text: 'Paid'),
              Tab(text: 'Other'),
            ],
          ),
        ),
        body: invoicesAsync.when(
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
                const Text('Could not load invoices'),
                const SizedBox(height: AppSpacing.md),
                TextButton(
                  onPressed: () => ref.invalidate(myInvoicesProvider),
                  child: const Text('Retry'),
                ),
              ],
            ),
          ),
          data: (invoices) {
            // The "Pending" tab really only holds the *pending* invoices.
            // The old filter (`status != paid`) also put the overdue and the
            // cancelled ones in there, which did not match the label.
            final pending = invoices
                .where((i) => i.status == InvoiceStatus.pending)
                .toList();
            final paid = invoices
                .where((i) => i.status == InvoiceStatus.paid)
                .toList();

            // The overdue and the cancelled invoices used to be nowhere —
            // they were fetched, but no tab showed them. They are simply
            // invisible to the owner: a booking that was cancelled or that
            // was never paid could not be looked at any more.
            final other = invoices
                .where(
                  (i) =>
                      i.status == InvoiceStatus.overdue ||
                      i.status == InvoiceStatus.cancelled,
                )
                .toList();

            return TabBarView(
              children: [
                _buildList(pending, 'No Pending Invoices'),
                _buildList(paid, 'No Paid Invoices'),
                _buildList(other, 'No Other Invoices'),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildList(List<CommissionInvoiceModel> invoices, String emptyTitle) {
    if (invoices.isEmpty) {
      return EmptyState(
        icon: Icons.receipt_outlined,
        title: emptyTitle,
        message: 'Commission invoices appear here once a student joins a room.',
      );
    }

    return RefreshIndicator(
      onRefresh: () async {
              // The indicator has to wait for the **new** data —
              // `invalidate` returns nothing, so the spinner
              // disappeared while the list was still loading.
              final _ = await ref.refresh(myInvoicesProvider.future);
            },
      child: ListView.builder(
        padding: const EdgeInsets.all(AppSpacing.md),
        itemCount: invoices.length,
        itemBuilder: (context, index) => Padding(
          padding: const EdgeInsets.only(bottom: AppSpacing.md),
          child: _InvoiceCard(
            invoice: invoices[index],
            onTap: () => context.push('/invoice/${invoices[index].invoiceId}'),
          ),
        ),
      ),
    );
  }
}

class _InvoiceCard extends StatelessWidget {
  final CommissionInvoiceModel invoice;
  final VoidCallback onTap;

  const _InvoiceCard({required this.invoice, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return AppCard(
      margin: EdgeInsets.zero,
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
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
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      AppFormatters.formatCurrency(invoice.monthlyRent),
                      style: theme.textTheme.titleMedium,
                    ),
                    Text(
                      'Room ${invoice.roomId}',
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              _StatusBadge(status: invoice.status),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Divider(color: theme.colorScheme.outlineVariant, height: 1),
          const SizedBox(height: AppSpacing.md),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              // Both halves are flexible: the labels are long enough to
              // run into each other on a narrow phone.
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Monthly Rent',
                      style: theme.textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      AppFormatters.formatCurrency(invoice.monthlyRent),
                      style: theme.textTheme.titleMedium,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      'Commission (${invoice.commissionPercentage.toStringAsFixed(0)}%)',
                      style: theme.textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      AppFormatters.formatCurrency(invoice.commissionAmount),
                      style: theme.textTheme.titleMedium?.copyWith(
                        color: theme.colorScheme.primary,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _StatusBadge extends StatelessWidget {
  final InvoiceStatus status;

  const _StatusBadge({required this.status});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = switch (status) {
      InvoiceStatus.pending => Colors.orange,
      InvoiceStatus.paid => Colors.green,
      InvoiceStatus.overdue => Colors.red,
      InvoiceStatus.cancelled => Colors.grey,
    };

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
        status.label,
        style: theme.textTheme.labelSmall?.copyWith(color: color),
      ),
    );
  }
}
