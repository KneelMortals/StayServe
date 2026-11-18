import 'dart:async';

import 'package:cloud_functions/cloud_functions.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/otp/otp_service.dart';

/// Screen that asks the user for a 6 digit code sent to their email address
/// or mobile number.
///
/// It returns the **challenge** of the verification through [Navigator.pop]
/// once the code has been verified — the challenge is what the registration
/// needs, and it may be used only once.
class OtpVerificationScreen extends ConsumerStatefulWidget {
  final OtpChannel channel;
  final String identifier;

  /// Called after the code has been verified.
  final VoidCallback? onVerified;

  const OtpVerificationScreen({
    required this.channel,
    required this.identifier,
    this.onVerified,
    super.key,
  });

  @override
  ConsumerState<OtpVerificationScreen> createState() => _OtpVerificationScreenState();
}

class _OtpVerificationScreenState extends ConsumerState<OtpVerificationScreen> {
  final _codeController = TextEditingController();
  final _focusNode = FocusNode();

  bool _isVerifying = false;
  bool _isSending = false;
  bool _codeSent = false;

  /// Set when the backend accepted the request but could not actually
  /// deliver the code (no provider configured, provider rejected the
  /// message, invalid number, ...).
  ///
  /// The server answers with `success: true` in that case, so without this
  /// flag the UI would claim "we sent you a code" while the user waits for
  /// a mail/SMS that will never arrive.
  bool _deliveryFailed = false;

  /// Whether the listener of the code field is switched off.
  ///
  /// The field is cleared when the verification failed — and the listener
  /// wiped the error message that had just been set, so the user never saw
  /// **why** the code was wrong.
  bool _suppressCodeListener = false;

  /// The code that was in the field the last time the listener ran.
  ///
  /// It tells a real change of the text apart from the framework writing
  /// the value of the field back into the controller.
  String _lastCode = '';

  String? _errorMessage;

  int _resendCountdown = 0;
  Timer? _countdownTimer;

  @override
  void initState() {
    super.initState();
    _codeController.addListener(_onCodeChanged);
    _sendCode(isResend: false);
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _codeController.removeListener(_onCodeChanged);
    _codeController.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  void _onCodeChanged() {
    // The listener is switched off while the field is cleared on purpose —
    // otherwise it wiped the error message that had just been set.
    if (_suppressCodeListener) return;

    final text = _codeController.text;

    // ---------------------------------------------------------------------
    // The listener is called even when the text did **not** change.
    //
    // The framework writes the value of the field back into the controller
    // (with the same text) every time the field is rebuilt. The error
    // message was wiped by that call — the user never saw **why** the code
    // was refused.
    //
    // Only a real change of the text (the user is typing) hides the old
    // error.
    // ---------------------------------------------------------------------
    final changed = text != _lastCode;
    _lastCode = text;

    if (text.length == 6 && !_isVerifying) {
      _verifyCode();
    } else if (changed && text.isNotEmpty) {
      setState(() => _errorMessage = null);
    }
  }

  /// Clears the code field — without wiping the error message.
  void _clearCode() {
    _suppressCodeListener = true;
    _codeController.clear();
    _suppressCodeListener = false;
    _lastCode = '';
  }

  Future<void> _sendCode({required bool isResend}) async {
    setState(() {
      _isSending = true;
      _errorMessage = null;
      _deliveryFailed = false;
    });

    try {
      final result = await ref.read(otpServiceProvider).sendOtp(
            channel: widget.channel,
            identifier: widget.identifier,
          );

      if (!mounted) return;
      setState(() {
        _isSending = false;
        _codeSent = true;
        _deliveryFailed = !result.delivered;
        _resendCountdown = result.resendAfterSeconds;
      });
      _startCountdown();
    } on FirebaseFunctionsException catch (e) {
      if (!mounted) return;
      setState(() {
        _isSending = false;
        // The code was **not** sent — the screen must not claim that it
        // was. Without this the user waited for a mail that never came.
        _codeSent = false;
        _deliveryFailed = true;
        _errorMessage = _readableError(e);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isSending = false;
        _codeSent = false;
        _deliveryFailed = true;
        _errorMessage = 'Could not send the code. Please try again.';
      });
    }
  }

  Future<void> _verifyCode() async {
    final code = _codeController.text.trim();
    if (code.length != 6 || _isVerifying) return;

    setState(() {
      _isVerifying = true;
      _errorMessage = null;
    });

    try {
      final result = await ref.read(otpServiceProvider).verifyOtp(
            channel: widget.channel,
            identifier: widget.identifier,
            otp: code,
          );

      if (!mounted) return;
      if (result.verified) {
        // The challenge is the proof that *this* client entered the code.
        //
        // It is empty when the address had already been verified by somebody
        // else — the challenge is then not handed out a second time, and
        // the user has to request a new code.
        if (result.challenge.isEmpty) {
          setState(() {
            _isVerifying = false;
            _errorMessage = result.alreadyVerified
                ? 'This address was verified in another session. Please '
                    'request a new code.'
                : 'The verification could not be completed. Please request a '
                    'new code.';
            _clearCode();
          });
          return;
        }

        widget.onVerified?.call();
        context.pop(result.challenge);
      } else {
        setState(() {
          _isVerifying = false;
          _errorMessage = 'That code is not correct. Please try again.';
          _clearCode();
        });
      }
    } on FirebaseFunctionsException catch (e) {
      if (!mounted) return;
      setState(() {
        _isVerifying = false;
        _errorMessage = _readableError(e);
        _clearCode();
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isVerifying = false;
        _errorMessage = 'Could not verify the code. Please try again.';
        _clearCode();
      });
    }
  }

  void _startCountdown() {
    _countdownTimer?.cancel();
    if (_resendCountdown <= 0) return;
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      setState(() => _resendCountdown--);
      if (_resendCountdown <= 0) timer.cancel();
    });
  }

  String _readableError(FirebaseFunctionsException e) {
    final message = e.message;
    if (message == null || message.isEmpty) return 'Something went wrong. Please try again.';
    return message;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final masked = _maskIdentifier(widget.identifier);

    return Scaffold(
      appBar: AppBar(
        title: Text('Verify ${widget.channel == OtpChannel.email ? 'Email' : 'Mobile'}'),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.xl),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: AppSpacing.lg),
              Center(
                child: Container(
                  width: 80,
                  height: 80,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.primaryContainer,
                    borderRadius: BorderRadius.circular(AppBorderRadius.xl),
                  ),
                  child: Icon(
                    widget.channel == OtpChannel.email
                        ? Icons.mark_email_read_outlined
                        : Icons.smartphone_outlined,
                    size: 40,
                    color: theme.colorScheme.primary,
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(
                'Enter the verification code',
                style: theme.textTheme.headlineSmall,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                _deliveryFailed
                    ? 'We could not send a code to $masked'
                    : 'We sent a 6-digit code to $masked',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: _deliveryFailed
                      ? theme.colorScheme.error
                      : theme.colorScheme.onSurfaceVariant,
                ),
                textAlign: TextAlign.center,
              ),
              if (_deliveryFailed) ...[
                const SizedBox(height: AppSpacing.md),
                _DeliveryWarning(
                  channel: widget.channel,
                  onRetry: _isSending ? null : () => _sendCode(isResend: true),
                ),
              ],
              const SizedBox(height: AppSpacing.xl),
              if (!_codeSent && _isSending)
                const Center(child: CircularProgressIndicator())
              else
                TextField(
                  controller: _codeController,
                  focusNode: _focusNode,
                  keyboardType: TextInputType.number,
                  textAlign: TextAlign.center,
                  maxLength: 6,
                  autofocus: true,
                  enabled: !_isVerifying,
                  inputFormatters: [
                    FilteringTextInputFormatter.digitsOnly,
                    LengthLimitingTextInputFormatter(6),
                  ],
                  style: theme.textTheme.headlineMedium?.copyWith(
                    letterSpacing: 8,
                    fontWeight: FontWeight.w700,
                  ),
                  decoration: InputDecoration(
                    counterText: '',
                    hintText: '••••••',
                    hintStyle: theme.textTheme.headlineMedium?.copyWith(
                      letterSpacing: 8,
                      color: theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.4),
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(AppBorderRadius.lg),
                    ),
                    errorText: _errorMessage,
                  ),
                  onSubmitted: (_) => _verifyCode(),
                ),
              const SizedBox(height: AppSpacing.lg),
              AppButton(
                label: _isVerifying ? 'Verifying...' : 'Verify',
                onPressed: _isVerifying ? null : _verifyCode,
                isLoading: _isVerifying,
              ),
              const SizedBox(height: AppSpacing.md),
              TextButton(
                onPressed: (_resendCountdown > 0 || _isSending)
                    ? null
                    : () => _sendCode(isResend: true),
                child: Text(
                  _resendCountdown > 0
                      ? 'Resend code in ${_resendCountdown}s'
                      : 'Resend code',
                ),
              ),
              const SizedBox(height: AppSpacing.md),
              Text(
                'The code expires in 5 minutes.',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _maskIdentifier(String identifier) {
    if (widget.channel == OtpChannel.email) {
      final parts = identifier.split('@');
      if (parts.length != 2) return identifier;
      final name = parts[0];
      final visible = name.length <= 2 ? name : '${name.substring(0, 2)}***';
      return '$visible@${parts[1]}';
    }
    final digits = identifier.replaceAll(RegExp(r'[^0-9]'), '');
    if (digits.length <= 4) return identifier;
    return '••••• ${digits.substring(digits.length - 4)}';
  }
}

/// Shown when the backend accepted the OTP request but could not deliver it.
///
/// Without this the user is told "we sent you a code" and then waits for a
/// mail/SMS that never arrives, with no idea what went wrong.
class _DeliveryWarning extends StatelessWidget {
  final OtpChannel channel;
  final VoidCallback? onRetry;

  const _DeliveryWarning({required this.channel, this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isEmail = channel == OtpChannel.email;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(AppBorderRadius.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.warning_amber_rounded,
                size: 20,
                color: theme.colorScheme.onErrorContainer,
              ),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Text(
                  isEmail
                      ? 'We could not deliver the email. Check the address and try again.'
                      : 'We could not deliver the SMS. Check the mobile number '
                          '(including the country code) and try again.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onErrorContainer,
                  ),
                ),
              ),
            ],
          ),
          if (onRetry != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: onRetry,
                child: const Text('Try again'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
