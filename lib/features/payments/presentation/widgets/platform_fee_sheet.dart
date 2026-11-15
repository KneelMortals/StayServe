import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/index.dart';
import '../../../../firebase/payments/payment_repository.dart';
import '../../../../models/join_request_model.dart';
import '../../../../services/payment_service.dart';

/// Shows the platform-fee sheet.
///
/// Returns `true` when a payment was submitted for verification. Submission
/// does not activate the booking; an admin must verify the payment first.
Future<bool> showPlatformFeeSheet(
  BuildContext context,
  JoinRequestModel request, {
  String title = 'Pay Platform Fee',
}) async {
  final submitted = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (sheetContext) => PlatformFeeSheet(request: request, title: title),
  );
  return submitted == true;
}

/// The platform-fee sheet.
///
/// The amount and the payee are fetched from the server — the client never
/// decides how much to pay or where the money goes.
///
/// The sheet handles the three states of the payment model:
///
///  * the **student** pays the fee to the platform UPI,
///  * the **room owner** pays the fee to the platform UPI,
///  * the cut has **already been taken** — from the second payment on the
///    rent goes straight from the student to the room owner.
///
/// ### The payment option appears on both sides
///
/// The sheet is opened from the request list of the student **and** from the
/// request list of the room owner. The server says whether *this* caller has
/// to pay (`youPay`); the party that does gets the real UPI button, the
/// other one gets an explanation of who settles the fee.
///
/// ### Submission does not activate the room
///
/// Submitting the reference records the payment as `submitted` only. The
/// request remains `studentConfirmed` until an admin verifies the payment;
/// verification creates the commission invoice, activates the room and moves
/// the request to `adminReviewed`.
class PlatformFeeSheet extends ConsumerStatefulWidget {
  final JoinRequestModel request;
  final String title;

  const PlatformFeeSheet({
    required this.request,
    this.title = 'Pay Platform Fee',
    super.key,
  });

  @override
  ConsumerState<PlatformFeeSheet> createState() => _PlatformFeeSheetState();
}

class _PlatformFeeSheetState extends ConsumerState<PlatformFeeSheet> {
  final _referenceController = TextEditingController();

  UpiPaymentIntent? _intent;
  bool _loadingIntent = true;
  bool _busy = false;
  bool _upiLaunched = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadIntent();
  }

  @override
  void dispose() {
    _referenceController.dispose();
    super.dispose();
  }

  Future<void> _loadIntent() async {
    try {
      final intent = await ref
          .read(paymentRepositoryProvider)
          .createPaymentIntent(requestId: widget.request.requestId);
      if (!mounted) return;
      setState(() {
        _intent = intent;
        _loadingIntent = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loadingIntent = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  Future<void> _launchUpi() async {
    final intent = _intent;
    if (intent == null) return;

    setState(() => _busy = true);
    try {
      final result = await ref
          .read(paymentServiceProvider)
          .launchUpiIntent(intent.uri, transactionRef: intent.transactionRef);
      if (!mounted) return;

      if (result.success) {
        setState(() {
          _upiLaunched = true;
          _error = null;
        });
      } else {
        setState(() => _error = result.error ?? 'Could not open the UPI app');
      }
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submitReference() async {
    final reference = _referenceController.text.trim();
    if (reference.length < 4) {
      setState(
        () => _error = 'Enter the transaction reference from your UPI app',
      );
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(paymentRepositoryProvider)
          .submitPayment(
            requestId: widget.request.requestId,
            reference: reference,
          );
      if (!mounted) return;
      Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Submits a request whose platform fee is **waived** (0 %).
  ///
  /// There is no money to pay and no UPI transaction to enter. The request is
  /// still submitted for admin verification before the room is activated.
  Future<void> _submitWaivedRequest() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(paymentRepositoryProvider)
          .submitPayment(requestId: widget.request.requestId, reference: '');
      if (!mounted) return;
      Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Puts the UPI address of the platform on the clipboard.
  ///
  /// It is the way out for every UPI app that refuses the intent: the user
  /// opens their own UPI app, pays the address and enters the reference
  /// here. Without this the payment was impossible for those users.
  Future<void> _copyUpiId(String vpa) async {
    await ref.read(paymentServiceProvider).copyToClipboard(vpa);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Copied $vpa — pay this amount in your UPI app')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final intent = _intent;

    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
      ),
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom + 24,
        top: 24,
        left: 24,
        right: 24,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: theme.colorScheme.onSurfaceVariant.withValues(
                    alpha: 0.3,
                  ),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 24),
            Text(widget.title, style: theme.textTheme.headlineSmall),
            const SizedBox(height: 8),

            if (_loadingIntent)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: AppSpacing.xl),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (intent == null) ...[
              Text(
                _error ?? 'The payment link could not be created.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              AppButton(
                label: 'Try again',
                onPressed: () {
                  setState(() {
                    _loadingIntent = true;
                    _error = null;
                  });
                  _loadIntent();
                },
                isFullWidth: true,
              ),
            ] else if (intent.feeWaived) ...[
              // ---------------------------------------------------------
              // The platform fee is waived (0 %) — there is nothing to pay.
              //
              // The request still has to be submitted for admin verification:
              // no UPI app is opened and no transaction reference is asked
              // for, but submission alone does not activate the room.
              // ---------------------------------------------------------
              _buildNotice(
                theme,
                Icons.info_outline,
                'No platform fee is due for this request. Submit it for admin '
                'verification; the room is activated only after the '
                'request is verified.',
              ),
              const SizedBox(height: AppSpacing.lg),
              if (_error != null) ...[
                Text(
                  _error!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.error,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
              ],
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _busy ? null : _submitWaivedRequest,
                  child: _busy
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Submit for verification'),
                ),
              ),
            ] else if (intent.alreadySettled) ...[
              // ---------------------------------------------------------
              // The cut is taken only once, on the first payment.
              //
              // When it has already been collected there is nothing to pay
              // any more — the rent is settled directly with the owner.
              // ---------------------------------------------------------
              _buildNotice(
                theme,
                Icons.check_circle_outline,
                intent.message.isNotEmpty
                    ? intent.message
                    : 'The platform fee for this booking has already been '
                          'paid. The rent is settled directly with the room '
                          'owner.',
              ),
              const SizedBox(height: AppSpacing.lg),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Close'),
                ),
              ),
            ] else if (!intent.youPay) ...[
              // The other party settles the platform fee.
              _buildNotice(
                theme,
                Icons.info_outline,
                'The StayServe platform fee for this request is the '
                'responsibility of the '
                '${intent.payer == 'owner' ? 'room owner' : 'student'}. '
                'They must submit it for verification before the room is '
                'activated.',
              ),
              const SizedBox(height: AppSpacing.md),
              Text(
                'Platform fee: ${AppFormatters.formatCurrency(intent.amount)}'
                ' (${intent.feePercentage.toStringAsFixed(0)}%)',
                style: theme.textTheme.bodyMedium,
              ),
              const SizedBox(height: AppSpacing.lg),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Close'),
                ),
              ),
            ] else ...[
              Text(
                'Amount: ${AppFormatters.formatCurrency(intent.amount)}',
                style: theme.textTheme.titleLarge?.copyWith(
                  color: theme.colorScheme.primary,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'Pay to ${intent.payeeName} · ${intent.payeeVpa}',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.lg),

              Container(
                padding: const EdgeInsets.all(AppSpacing.md),
                decoration: BoxDecoration(
                  color: theme.colorScheme.primaryContainer,
                  borderRadius: BorderRadius.circular(AppBorderRadius.md),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('How it works', style: theme.textTheme.labelLarge),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      '1. Tap "Open UPI app" and pay ${AppFormatters.formatCurrency(intent.amount)}',
                      style: theme.textTheme.bodySmall,
                    ),
                    Text(
                      '2. Come back and enter the transaction reference (UTR)',
                      style: theme.textTheme.bodySmall,
                    ),
                    Text(
                      '3. Submit the reference for verification. The room is '
                      'activated only after an admin verifies the payment',
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.lg),

              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _busy ? null : _launchUpi,
                  icon: _busy
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Icon(Icons.payment),
                  label: Text(
                    _upiLaunched ? 'Open UPI app again' : 'Open UPI app to pay',
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.sm),

              // -----------------------------------------------------------------
              // The way out for every UPI app that refuses the intent.
              //
              // Some apps refuse a payment link that breaks the UPI
              // specification and only say "the value exceeds the limit" —
              // which is completely misleading, because the *amount* was
              // fine. The user can always copy the UPI address and pay it
              // in their own UPI app.
              // -----------------------------------------------------------------
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: _busy ? null : () => _copyUpiId(intent.payeeVpa),
                  icon: const Icon(Icons.copy, size: 18),
                  label: const Text('Copy UPI ID and pay manually'),
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                'Pay ₹${AppFormatters.formatCurrencyWithDecimals(intent.amount)} to '
                '${intent.payeeVpa} in your own UPI app, then enter the '
                'transaction reference below.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: AppSpacing.lg),

              TextField(
                controller: _referenceController,
                textInputAction: TextInputAction.done,
                decoration: InputDecoration(
                  labelText: 'Transaction reference (UTR)',
                  hintText: 'e.g. 425781234567',
                  helperText: 'Find this in your UPI app under the transaction',
                  border: const OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: AppSpacing.md),

              if (_error != null) ...[
                Text(
                  _error!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.error,
                  ),
                ),
                const SizedBox(height: AppSpacing.sm),
              ],

              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: _busy ? null : _submitReference,
                  child: _busy
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Text('Submit payment for verification'),
                ),
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                'The payment will be submitted for verification. The room is '
                'activated only after an admin verifies the payment.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// A short explanation inside the payment sheet.
  Widget _buildNotice(ThemeData theme, IconData icon, String message) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: theme.colorScheme.primaryContainer,
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: theme.colorScheme.onPrimaryContainer),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              message,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onPrimaryContainer,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
