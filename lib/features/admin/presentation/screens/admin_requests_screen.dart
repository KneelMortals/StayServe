import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../models/join_request_model.dart';
import '../providers/admin_providers.dart';
import '../widgets/admin_scaffold.dart';

class AdminRequestsScreen extends ConsumerStatefulWidget {
  const AdminRequestsScreen({super.key});

  @override
  ConsumerState<AdminRequestsScreen> createState() =>
      _AdminRequestsScreenState();
}

class _AdminRequestsScreenState extends ConsumerState<AdminRequestsScreen> {
  /// Currently applied status filter. `null` means "all statuses".
  JoinRequestStatus? _statusFilter;

  @override
  Widget build(BuildContext context) {
    final requestsAsync = ref.watch(adminJoinRequestsProvider(_statusFilter));

    return AdminScaffold(
      title: 'Join Requests',
      actions: [
        IconButton(
          icon: const Icon(Icons.filter_list),
          tooltip: 'Filter by status',
          onPressed: () => _showStatusFilter(context),
        ),
      ],
      body: requestsAsync.when(
        data: (requests) {
          if (requests.isEmpty) {
            return const Center(child: Text('No join requests found'));
          }
          return RefreshIndicator(
            onRefresh: () async {
              // The indicator has to wait for the **new** data —
              // `invalidate` returns nothing, so the spinner disappeared
              // while the list was still loading.
              final _ = await ref.refresh(
                adminJoinRequestsProvider(_statusFilter).future,
              );
            },
            child: ListView.builder(
              padding: const EdgeInsets.all(AppSpacing.md),
              itemCount: requests.length,
              itemBuilder: (context, index) => _AdminRequestCard(
                request: requests[index],
                onOpenPayments: () => context.go('/admin/payments'),
              ),
            ),
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(child: Text('Error: $error')),
      ),
    );
  }

  Future<void> _showStatusFilter(BuildContext context) async {
    final selected = await RadioFilterSheet.show<JoinRequestStatus>(
      context,
      title: 'Filter by Status',
      options: JoinRequestStatus.values,
      labelBuilder: (status) => status.label,
      allLabel: 'All Statuses',
      initialValue: _statusFilter,
    );
    if (!mounted) return;
    setState(() => _statusFilter = selected);
  }
}

class _AdminRequestCard extends StatelessWidget {
  final JoinRequestModel request;
  final VoidCallback onOpenPayments;

  const _AdminRequestCard({
    required this.request,
    required this.onOpenPayments,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    Color statusColor;
    switch (request.status) {
      case JoinRequestStatus.pending:
        statusColor = Colors.orange;
        break;
      case JoinRequestStatus.studentConfirmed:
        statusColor = Colors.blue;
        break;
      case JoinRequestStatus.ownerConfirmed:
        statusColor = Colors.green;
        break;
      case JoinRequestStatus.adminReviewed:
        statusColor = Colors.purple;
        break;
      case JoinRequestStatus.rejected:
        statusColor = Colors.red;
        break;
      case JoinRequestStatus.cancelled:
        statusColor = Colors.grey;
        break;
    }

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
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
                      // `substring(0, 8)` threw a `RangeError` for a request
                      // id shorter than eight characters.
                      Text(
                        'Request #${request.requestId.length > 8 ? request.requestId.substring(0, 8) : request.requestId}',
                        style: theme.textTheme.titleMedium,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      Text(
                        'Room: ${request.roomId} • Student: ${request.studentId} • Owner: ${request.ownerId}',
                        style: theme.textTheme.bodySmall,
                        maxLines: 2,
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
                    request.status.label,
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
            // The rent and the commission are in a `Wrap` — side by side in
            // a `Row` they did not fit on a narrow phone and the two
            // numbers ran into each other.
            Wrap(
              spacing: AppSpacing.xl,
              runSpacing: AppSpacing.sm,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Monthly Rent', style: theme.textTheme.bodySmall),
                    Text(
                      '₹${request.monthlyRentAtJoin.toInt()}',
                      style: theme.textTheme.titleMedium,
                    ),
                  ],
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Commission (${request.commissionPercentageAtJoin.toInt()}%)',
                      style: theme.textTheme.bodySmall,
                    ),
                    Text(
                      '₹${request.commissionAmount.toInt()}',
                      style: theme.textTheme.titleMedium?.copyWith(
                        color: theme.colorScheme.primary,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            if (request.rejectionReason != null) ...[
              const SizedBox(height: AppSpacing.md),
              Container(
                padding: const EdgeInsets.all(AppSpacing.sm),
                decoration: BoxDecoration(
                  color: Colors.red.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(AppBorderRadius.md),
                ),
                child: Row(
                  children: [
                    Icon(Icons.info_outline, size: 16, color: Colors.red),
                    const SizedBox(width: AppSpacing.sm),
                    Expanded(
                      child: Text(
                        'Rejection: ${request.rejectionReason}',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: Colors.red,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: AppSpacing.md),
            _buildReviewGuidance(theme),
            if (request.advancePaymentStatus == PaymentStatus.submitted) ...[
              const SizedBox(height: AppSpacing.md),
              SizedBox(
                width: 220,
                child: AppButton(
                  label: 'Payments → Verify Payment',
                  onPressed: onOpenPayments,
                  isFullWidth: true,
                  type: ButtonType.primary,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// Describes the request state without offering a second activation path.
  ///
  /// The only action that verifies a payment and activates a booking lives on
  /// the Payments screen.
  Widget _buildReviewGuidance(ThemeData theme) {
    late final IconData icon;
    late final Color color;
    late final String title;
    late final String message;

    if (request.status == JoinRequestStatus.adminReviewed) {
      icon = Icons.task_alt;
      color = Colors.teal;
      title = 'Payment verified — booking activated';
      message =
          'The request is Admin Reviewed and the room is active for the '
          'student.';
    } else if (request.advancePaymentStatus == PaymentStatus.submitted) {
      icon = Icons.hourglass_top;
      color = Colors.blue;
      title = 'Payment submitted — awaiting verification';
      message =
          'Use Payments → Verify Payment. Verification activates the booking '
          'and moves the request to Admin Reviewed.';
    } else if (request.advancePaymentStatus == PaymentStatus.rejected) {
      icon = Icons.error_outline;
      color = Colors.red;
      if (request.status == JoinRequestStatus.ownerConfirmed) {
        title = 'Payment rejected — awaiting student confirmation';
        message =
            'The request was returned to the owner-confirmed state and is '
            'awaiting student confirmation before payment.';
      } else {
        title = 'Payment rejected — booking payable again';
        message =
            'The request was rolled back to a payable state and is awaiting '
            'another submission and verification.';
      }
    } else if (request.advancePaid ||
        request.advancePaymentStatus == PaymentStatus.verified) {
      icon = Icons.verified;
      color = Colors.green;
      title = 'Payment verified — awaiting booking activation';
      message =
          'This request is not Admin Reviewed yet, so it is not active. Use '
          'the Payments verification flow to keep the states consistent.';
    } else {
      switch (request.status) {
        case JoinRequestStatus.pending:
          icon = Icons.schedule;
          color = Colors.orange;
          title = 'Waiting for owner approval';
          message = 'The owner must approve the request before it can advance.';
          break;
        case JoinRequestStatus.ownerConfirmed:
          icon = Icons.check_circle_outline;
          color = Colors.green;
          title = 'Owner accepted — awaiting student confirmation';
          message =
              'The student must confirm next. The platform fee is not payable '
              'before that.';
          break;
        case JoinRequestStatus.studentConfirmed:
          icon = Icons.info_outline;
          color = Colors.blue;
          title = 'Student confirmed — awaiting platform fee';
          message =
              'Waiting for the platform fee to be submitted. Once submitted, '
              'verify it from Payments.';
          break;
        case JoinRequestStatus.adminReviewed:
          icon = Icons.task_alt;
          color = Colors.teal;
          title = 'Booking activated';
          message = 'The room is active for the student.';
          break;
        case JoinRequestStatus.rejected:
          icon = Icons.cancel_outlined;
          color = Colors.grey;
          title = 'Request rejected';
          message = 'This request is closed.';
          break;
        case JoinRequestStatus.cancelled:
          icon = Icons.cancel_outlined;
          color = Colors.grey;
          title = 'Request cancelled';
          message = 'This request is closed.';
          break;
      }
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: color,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 2),
                Text(message, style: theme.textTheme.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
