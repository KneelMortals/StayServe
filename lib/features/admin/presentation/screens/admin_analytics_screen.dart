import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:fl_chart/fl_chart.dart';

import '../../../../core/index.dart';
import '../../../../firebase/admin/admin_repository.dart';
import '../../../../models/join_request_model.dart';
import '../providers/admin_providers.dart';
import '../widgets/admin_scaffold.dart';

class AdminAnalyticsScreen extends ConsumerWidget {
  const AdminAnalyticsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final statsAsync = ref.watch(adminStatsProvider);
    final invoicesAsync = ref.watch(adminInvoicesProvider(null));

    return AdminScaffold(
      title: 'Revenue Analytics',
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          statsAsync.when(
            data: (stats) => _buildRevenueOverview(
              context,
              stats,
              invoicesAsync.valueOrNull ?? const <CommissionInvoiceModel>[],
            ),
            loading: () => _buildRevenueOverviewSkeleton(context),
            error: (_, _) => _buildRevenueOverviewError(context),
          ),
          const SizedBox(height: AppSpacing.lg),
          invoicesAsync.when(
            data: (invoices) => _buildRevenueChart(context, invoices),
            loading: () => _buildChartSkeleton(context),
            error: (_, _) => _buildChartError(context),
          ),
          const SizedBox(height: AppSpacing.lg),
          invoicesAsync.when(
            data: (invoices) => _buildMonthlyBreakdown(context, invoices),
            loading: () => const SizedBox(),
            error: (_, _) => const SizedBox(),
          ),
          const SizedBox(height: AppSpacing.lg),
          statsAsync.when(
            data: (stats) => _buildKeyMetrics(
              context,
              stats,
              invoicesAsync.valueOrNull ?? const <CommissionInvoiceModel>[],
            ),
            loading: () => const SizedBox(),
            error: (_, _) => const SizedBox(),
          ),
        ],
      ),
    );
  }

  Widget _buildRevenueOverview(
    BuildContext context,
    AdminStats stats,
    List<CommissionInvoiceModel> invoices,
  ) {
    final theme = Theme.of(context);

    final paidInvoices = invoices
        .where((invoice) => invoice.status == InvoiceStatus.paid)
        .toList();
    final outstanding = invoices
        .where((invoice) =>
            invoice.status != InvoiceStatus.paid &&
            invoice.status != InvoiceStatus.cancelled)
        .fold<double>(
          0,
          (sum, invoice) => sum + invoice.commissionAmount,
        );
    final averageCommission = paidInvoices.isEmpty
        ? 0
        : (stats.totalRevenue / paidInvoices.length).round();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Revenue Overview', style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            // The metrics are in a `Wrap` and not in a `Row` of three
            // columns: on a narrow phone the labels did not fit and were
            // pushed into each other.
            Wrap(
              spacing: AppSpacing.md,
              runSpacing: AppSpacing.md,
              children: [
                _MetricItem(
                  label: 'Total Revenue',
                  value: '₹${_formatNumber(stats.totalRevenue)}',
                ),
                _MetricItem(
                  label: 'Paid Commission',
                  value: '₹${_formatNumber(stats.totalRevenue)}',
                ),
                _MetricItem(
                  label: 'Outstanding',
                  value: '₹${_formatNumber(outstanding.round())}',
                ),
                _MetricItem(
                  label: 'Paid Invoices',
                  value: paidInvoices.length.toString(),
                ),
                _MetricItem(
                  label: 'Pending Invoices',
                  value: stats.pendingInvoices.toString(),
                ),
                _MetricItem(
                  label: 'Avg. Commission',
                  value: '₹${_formatNumber(averageCommission)}',
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRevenueOverviewSkeleton(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Revenue Overview', style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            Row(
              children: List.generate(3, (_) => Expanded(child: _SkeletonLine())),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildRevenueOverviewError(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Text('Error loading revenue data', style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.red)),
      ),
    );
  }

  Widget _buildRevenueChart(BuildContext context, List<CommissionInvoiceModel> invoices) {
    final monthlyData = _calculateMonthlyRevenue(invoices);
    final maxY = monthlyData.values.isNotEmpty
        ? (monthlyData.values.reduce((a, b) => a > b ? a : b) * 1.2).ceilToDouble()
        : 10000.0;

    // The label of every bar comes from the very same key the bar is built
    // from. The old code printed `Jan … Jun` for the last six months no
    // matter which months they actually were.
    final monthKeys = monthlyData.keys.toList()..sort();
    final monthLabels = monthKeys.map(_formatMonthShort).toList();

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Monthly Revenue (Last 6 Months)', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            SizedBox(
              height: 250,
              child: BarChart(
                BarChartData(
                  alignment: BarChartAlignment.spaceAround,
                  maxY: maxY,
                  barGroups: monthlyData.entries.map((entry) {
                    final index = _monthToIndex(entry.key);
                    return _BarChartGroup(index, entry.value);
                  }).toList(),
                  titlesData: FlTitlesData(
                    show: true,
                    bottomTitles: AxisTitles(
                      sideTitles: SideTitles(
                        showTitles: true,
                        getTitlesWidget: (value, meta) {
                          final index = value.toInt();
                          if (index >= 0 && index < monthLabels.length) {
                            return Text(monthLabels[index],
                                style: const TextStyle(fontSize: 10));
                          }
                          return const Text('');
                        },
                      ),
                    ),
                    leftTitles: AxisTitles(
                      sideTitles: SideTitles(
                        showTitles: true,
                        reservedSize: 40,
                        getTitlesWidget: (value, meta) {
                          if (value == 0) return const Text('0');
                          return Text('₹${(value / 1000).toInt()}k', style: const TextStyle(fontSize: 10));
                        },
                      ),
                    ),
                    topTitles: AxisTitles(sideTitles: SideTitles(showTitles: false)),
                    rightTitles: AxisTitles(sideTitles: SideTitles(showTitles: false)),
                  ),
                  borderData: FlBorderData(show: false),
                  gridData: FlGridData(show: true, drawVerticalLine: false),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildChartSkeleton(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Monthly Revenue', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            SizedBox(height: 250, child: Center(child: CircularProgressIndicator())),
          ],
        ),
      ),
    );
  }

  Widget _buildChartError(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Text('Error loading chart data', style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.red)),
      ),
    );
  }

  Widget _buildMonthlyBreakdown(BuildContext context, List<CommissionInvoiceModel> invoices) {
    final monthlyData = _calculateMonthlyRevenue(invoices);
    final sortedEntries = monthlyData.entries.toList()
      ..sort((a, b) => _monthToSortKey(b.key).compareTo(_monthToSortKey(a.key)));

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Monthly Breakdown', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            ...sortedEntries.take(6).map((entry) => _BreakdownRow(
              month: _formatMonth(entry.key),
              revenue: entry.value.toInt(),
              invoices: _countInvoicesForMonth(invoices, entry.key),
            )),
          ],
        ),
      ),
    );
  }

  Widget _buildKeyMetrics(
    BuildContext context,
    AdminStats stats,
    List<CommissionInvoiceModel> invoices,
  ) {
    final theme = Theme.of(context);
    // The number of paid invoices is counted from the invoices themselves.
    // The old code divided the revenue by a hard-coded ₹7 500, which made
    // every metric on this screen wrong by a factor of two or three.
    final paidInvoices = invoices.where((i) => i.isPaid).length;
    final totalInvoices = paidInvoices + stats.pendingInvoices;
    final paymentRate =
        totalInvoices > 0 ? (paidInvoices / totalInvoices * 100).toStringAsFixed(0) : '0';

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Key Metrics', style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            _MetricRow(label: 'Total Rooms', value: stats.totalRooms.toString()),
            _MetricRow(label: 'Available Rooms', value: stats.availableRooms.toString()),
            _MetricRow(label: 'Active Students', value: stats.totalStudents.toString()),
            _MetricRow(label: 'Active Owners', value: stats.totalOwners.toString()),
            _MetricRow(label: 'Join Requests Pending Review', value: stats.pendingConfirmations.toString()),
            _MetricRow(label: 'Invoice Payment Rate', value: '$paymentRate%'),
            _MetricRow(
              label: 'Avg. Commission per Invoice',
              value: paidInvoices > 0
                  ? '₹${_formatNumber((stats.totalRevenue / paidInvoices).round())}'
                  : '₹0',
            ),
          ],
        ),
      ),
    );
  }

  Map<String, double> _calculateMonthlyRevenue(List<CommissionInvoiceModel> invoices) {
    final monthlyData = <String, double>{};
    final now = DateTime.now();

    for (int i = 5; i >= 0; i--) {
      final date = DateTime(now.year, now.month - i, 1);
      final key = '${date.year}-${date.month.toString().padLeft(2, '0')}';
      monthlyData[key] = 0.0;
    }

    for (final invoice in invoices) {
      if (invoice.isPaid && invoice.paidAt != null) {
        final key = '${invoice.paidAt!.year}-${invoice.paidAt!.month.toString().padLeft(2, '0')}';
        if (monthlyData.containsKey(key)) {
          monthlyData[key] = (monthlyData[key] ?? 0) + invoice.commissionAmount;
        }
      }
    }

    return monthlyData;
  }

  int _monthToIndex(String key) {
    final parts = key.split('-');
    final year = int.parse(parts[0]);
    final month = int.parse(parts[1]);
    final now = DateTime.now();
    return (year - now.year) * 12 + (month - now.month) + 5;
  }

  int _monthToSortKey(String key) {
    final parts = key.split('-');
    return int.parse(parts[0]) * 100 + int.parse(parts[1]);
  }

  String _formatMonth(String key) {
    final parts = key.split('-');
    final month = int.parse(parts[1]);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${months[month - 1]} ${parts[0]}';
  }

  /// The short month name of a `year-month` key, e.g. `Nov`.
  String _formatMonthShort(String key) {
    final parts = key.split('-');
    final month = int.parse(parts[1]);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (month < 1 || month > 12) return '';
    return months[month - 1];
  }

  int _countInvoicesForMonth(List<CommissionInvoiceModel> invoices, String key) {
    return invoices.where((inv) {
      if (!inv.isPaid || inv.paidAt == null) return false;
      final invKey = '${inv.paidAt!.year}-${inv.paidAt!.month.toString().padLeft(2, '0')}';
      return invKey == key;
    }).length;
  }

  String _formatNumber(int number) {
    if (number >= 100000) {
      return '${(number / 100000).toStringAsFixed(1)}L';
    } else if (number >= 1000) {
      return '${(number / 1000).toStringAsFixed(1)}K';
    }
    return number.toString();
  }
}

class _MetricItem extends StatelessWidget {
  final String label;
  final String value;

  const _MetricItem({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ConstrainedBox(
      // The metric keeps a sensible width, but it never gets wider than
      // a third of the screen — that keeps three of them on a row and
      // stops the text from running into its neighbour.
      constraints: const BoxConstraints(minWidth: 120, maxWidth: 220),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: theme.textTheme.bodySmall,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            value,
            style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}

class _SkeletonLine extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.all(AppSpacing.xs),
      height: 20,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(4),
      ),
    );
  }
}

class _BarChartGroup extends BarChartGroupData {
  _BarChartGroup(int x, double y) : super(
    x: x,
    barRods: [
      BarChartRodData(
        toY: y,
        color: const Color(0xFF2E7D32),
        width: 20,
        borderRadius: BorderRadius.circular(4),
      ),
    ],
  );
}

class _BreakdownRow extends StatelessWidget {
  final String month;
  final int revenue;
  final int invoices;

  const _BreakdownRow({required this.month, required this.revenue, required this.invoices});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
      child: Row(
        children: [
          SizedBox(
            width: 80,
            child: Text(
              month,
              style: theme.textTheme.bodyMedium,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          Expanded(
            child: Text(
              '₹${_formatNumber(revenue)}',
              style: theme.textTheme.bodyMedium,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          Text(
            '$invoices invoices',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }

  String _formatNumber(int number) {
    if (number >= 100000) {
      return '${(number / 100000).toStringAsFixed(1)}L';
    } else if (number >= 1000) {
      return '${(number / 1000).toStringAsFixed(1)}K';
    }
    return number.toString();
  }
}

class _MetricRow extends StatelessWidget {
  final String label;
  final String value;

  const _MetricRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
      child: Row(
        children: [
          // The label takes the space it needs — the long ones used to
          // push the value off the screen.
          Expanded(
            flex: 3,
            child: Text(
              label,
              style: theme.textTheme.bodyMedium,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            flex: 2,
            child: Text(
              value,
              style: theme.textTheme.bodyMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
              textAlign: TextAlign.end,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}