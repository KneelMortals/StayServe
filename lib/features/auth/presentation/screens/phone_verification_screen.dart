import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/auth/auth_service.dart';
import '../providers/auth_provider.dart';

/// The reason the Firebase phone screen is open.
enum PhoneVerificationMode {
  /// The user is not signed in. A successful phone credential creates or
  /// opens the corresponding Firebase account.
  signIn,

  /// The user is signed in and the verified number must be linked to the
  /// existing account before the student/owner service areas can be used.
  link,
}

/// Normalises a user-entered number into the E.164 form Firebase requires.
///
/// StayServe is an India-first service, so a bare ten-digit Indian mobile
/// number is interpreted as `+91…`. A country-coded Indian number is also
/// accepted. Every other international number must use a leading `+` (or the
/// international `00` prefix), because an unprefixed number cannot be split
/// reliably into a country code and subscriber number.
String? normalizeFirebasePhoneNumber(String input) {
  final trimmed = input.trim();
  if (trimmed.isEmpty) return null;

  final hadPlus = trimmed.startsWith('+');
  final digits = trimmed.replaceAll(RegExp(r'[^0-9]'), '');
  if (digits.isEmpty) return null;

  bool isValidInternational(String international) {
    if (international.length < 8 || international.length > 15) return false;
    // E.164 country codes never start with zero.
    if (international.startsWith('0')) return false;

    // Indian mobile numbers have ten digits and start with 6-9. Apply the
    // same check when the +91 country code is used.
    if (international.startsWith('91') && international.length == 12) {
      final subscriber = international.substring(2);
      return RegExp(r'^[6-9]\d{9}$').hasMatch(subscriber);
    }
    return true;
  }

  if (hadPlus) {
    if (!isValidInternational(digits)) return null;
    return '+$digits';
  }

  if (digits.startsWith('00')) {
    final international = digits.substring(2);
    if (!isValidInternational(international)) return null;
    return '+$international';
  }

  if (digits.length == 10) {
    if (!RegExp(r'^[6-9]\d{9}$').hasMatch(digits)) return null;
    return '+91$digits';
  }

  // `91` followed by an Indian mobile number is unambiguous even without a
  // plus sign. Other international numbers have to be explicitly prefixed.
  if (digits.length == 12 && digits.startsWith('91')) {
    final subscriber = digits.substring(2);
    if (!RegExp(r'^[6-9]\d{9}$').hasMatch(subscriber)) return null;
    return '+$digits';
  }

  return null;
}

/// Firebase SMS verification for both phone sign-in and phone linking.
///
/// The SMS is sent by Firebase Auth. The screen never writes the phone or
/// its verification flag to Firestore: after a successful link the client
/// refreshes the signed token and asks `syncAuthProfile` to copy the live
/// Firebase Auth facts into the server-owned profile.
class PhoneVerificationScreen extends ConsumerStatefulWidget {
  final PhoneVerificationMode mode;
  final String? initialPhoneNumber;

  const PhoneVerificationScreen({
    required this.mode,
    this.initialPhoneNumber,
    super.key,
  });

  @override
  ConsumerState<PhoneVerificationScreen> createState() =>
      _PhoneVerificationScreenState();
}

class _PhoneVerificationScreenState
    extends ConsumerState<PhoneVerificationScreen> {
  final _formKey = GlobalKey<FormState>();
  final _phoneController = TextEditingController();
  final _codeController = TextEditingController();

  String? _verificationId;
  int? _resendToken;
  String? _errorMessage;
  bool _codeSent = false;
  bool _isSending = false;
  bool _isVerifying = false;
  bool _isCompleting = false;
  int _resendCountdown = 0;
  Timer? _countdownTimer;

  bool get _isLinking => widget.mode == PhoneVerificationMode.link;

  @override
  void initState() {
    super.initState();
    _phoneController.text = widget.initialPhoneNumber ?? '';
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _phoneController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  String? _validatePhone(String? value) {
    final normalized = normalizeFirebasePhoneNumber(value ?? '');
    if (normalized == null) {
      return 'Use an international number, for example +919876543210';
    }
    return null;
  }

  Future<void> _sendCode({bool isResend = false}) async {
    if (!_formKey.currentState!.validate()) return;
    final normalized = normalizeFirebasePhoneNumber(_phoneController.text);
    if (normalized == null) return;

    setState(() {
      _isSending = true;
      _errorMessage = null;
      if (!isResend) {
        _codeSent = false;
        _verificationId = null;
      }
    });

    try {
      final authRepository = ref.read(authRepositoryProvider);
      await authRepository.startPhoneVerification(
        phoneNumber: normalized,
        forceResendingToken: isResend ? _resendToken : null,
        onVerificationCompleted: (credential) {
          unawaited(_completeCredential(credential, normalized));
        },
        onVerificationFailed: (error) {
          if (!mounted) return;
          setState(() {
            _isSending = false;
            _isVerifying = false;
            _errorMessage = _readableFirebaseError(error);
          });
        },
        onCodeSent: (verificationId, resendToken) {
          if (!mounted) return;
          setState(() {
            _verificationId = verificationId;
            _resendToken = resendToken;
            _codeSent = true;
            _isSending = false;
            _errorMessage = null;
          });
          _startCountdown();
        },
        onCodeAutoRetrievalTimeout: (_) {
          if (!mounted) return;
          setState(() {
            _isSending = false;
            _errorMessage =
                'The code was not read automatically. Enter it below.';
          });
        },
      );
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _isSending = false;
        _errorMessage = readableAuthError(error);
      });
    }
  }

  Future<void> _verifyCode() async {
    final verificationId = _verificationId;
    final code = _codeController.text.trim();
    if (verificationId == null || code.length < 4 || _isVerifying) return;

    final normalized = normalizeFirebasePhoneNumber(_phoneController.text);
    if (normalized == null) return;

    setState(() {
      _isVerifying = true;
      _errorMessage = null;
    });

    try {
      final credential = ref
          .read(authRepositoryProvider)
          .phoneCredential(verificationId: verificationId, smsCode: code);
      await _completeCredential(credential, normalized);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _isVerifying = false;
        _errorMessage = readableAuthError(error);
      });
    }
  }

  Future<void> _completeCredential(
    PhoneAuthCredential credential,
    String normalizedPhoneNumber,
  ) async {
    // Firebase may deliver the automatic-verification callback after this
    // screen has already been closed. Touching the state of a disposed
    // screen would crash the app, so the late callback is ignored.
    if (!mounted || _isCompleting) return;
    setState(() {
      _isCompleting = true;
      _isVerifying = true;
      _errorMessage = null;
    });

    final controller = ref.read(authControllerProvider.notifier);
    try {
      if (_isLinking) {
        await controller.linkPhoneCredential(
          credential,
          phoneNumber: normalizedPhoneNumber,
        );
      } else {
        await controller.signInWithPhoneCredential(credential);
      }
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _isCompleting = false;
        _isVerifying = false;
        _errorMessage = readableAuthError(error);
      });
      return;
    }

    if (!mounted) return;
    // Sign-in still uses the auth controller's general error state. Profile
    // links throw their own operation-specific error above and must never
    // inspect another operation's shared state.
    if (!_isLinking) {
      final error = ref.read(authControllerProvider).error;
      if (error != null) {
        setState(() {
          _isCompleting = false;
          _isVerifying = false;
          _errorMessage = readableAuthError(error);
        });
        return;
      }
    }

    setState(() {
      _isCompleting = false;
      _isVerifying = false;
    });

    if (_isLinking) {
      final role = ref.read(authSessionProvider).valueOrNull?.role;
      context.go(homeForRole(role));
    } else {
      // A new phone account completes role selection next. The router moves
      // an account with an existing completed profile straight to its home
      // area instead.
      context.go('/role-selection');
    }
  }

  void _startCountdown() {
    _countdownTimer?.cancel();
    setState(() => _resendCountdown = 30);
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      if (_resendCountdown <= 1) {
        setState(() => _resendCountdown = 0);
        timer.cancel();
      } else {
        setState(() => _resendCountdown--);
      }
    });
  }

  String _readableFirebaseError(FirebaseAuthException error) {
    switch (error.code) {
      case 'invalid-phone-number':
        return 'Enter a valid international phone number.';
      case 'phone-number-already-in-use':
        return 'This phone number is already connected to another account.';
      case 'invalid-verification-code':
        return 'That code is not correct. Please try again.';
      case 'invalid-verification-id':
        return 'This verification expired. Please request a new code.';
      case 'session-expired':
        return 'The verification session expired. Please request a new code.';
      case 'too-many-requests':
        return 'Too many attempts. Please try again later.';
      case 'operation-not-allowed':
        return 'Phone sign-in is not enabled for this app yet.';
      default:
        return error.message ?? 'Phone verification failed. Please try again.';
    }
  }

  String _maskedPhone() {
    final normalized = normalizeFirebasePhoneNumber(_phoneController.text);
    if (normalized == null || normalized.length < 5) return 'your phone';
    final visible = normalized.substring(normalized.length - 4);
    return '•••• $visible';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final authState = ref.watch(authControllerProvider);
    final profileBusy = ref.watch(profileMutationBusyProvider);
    final busy =
        authState.isLoading ||
        _isSending ||
        _isVerifying ||
        _isCompleting ||
        (_isLinking && profileBusy);

    return Scaffold(
      appBar: AppBar(
        title: Text(_isLinking ? 'Verify Phone Number' : 'Sign in with Phone'),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.xl),
          child: Form(
            key: _formKey,
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
                      Icons.phone_android_outlined,
                      size: 40,
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
                Text(
                  _isLinking
                      ? 'Verify your phone number'
                      : 'Use your phone number',
                  style: theme.textTheme.headlineSmall,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  _isLinking
                      ? 'Firebase will send an SMS code. A verified phone is '
                            'required before student or owner services can be used.'
                      : 'Firebase will send an SMS code. Phone-only accounts may '
                            'add a verified email later.',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpacing.xl),
                AppTextField(
                  controller: _phoneController,
                  label: 'Phone number',
                  hint: '+919876543210',
                  keyboardType: TextInputType.phone,
                  textInputAction: _codeSent
                      ? TextInputAction.next
                      : TextInputAction.done,
                  validator: _validatePhone,
                  prefixIcon: const Icon(Icons.phone_outlined),
                  enabled: !_codeSent && !busy,
                  onFieldSubmitted: (_) {
                    if (!_codeSent) _sendCode();
                  },
                ),
                const SizedBox(height: AppSpacing.md),
                if (!_codeSent)
                  AppButton(
                    label: 'Send SMS Code',
                    onPressed: busy ? null : _sendCode,
                    isLoading: _isSending,
                  ),
                if (_codeSent) ...[
                  Text(
                    'We sent a code to ${_maskedPhone()}.',
                    style: theme.textTheme.bodyMedium,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: AppSpacing.md),
                  TextField(
                    controller: _codeController,
                    keyboardType: TextInputType.number,
                    textAlign: TextAlign.center,
                    maxLength: 6,
                    enabled: !busy,
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
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(AppBorderRadius.lg),
                      ),
                      errorText: _errorMessage,
                    ),
                    onSubmitted: (_) => _verifyCode(),
                  ),
                  const SizedBox(height: AppSpacing.md),
                  AppButton(
                    label: 'Verify Number',
                    onPressed: busy ? null : _verifyCode,
                    isLoading: _isVerifying || _isCompleting,
                  ),
                  if (_resendCountdown == 0)
                    TextButton(
                      onPressed: busy ? null : () => _sendCode(isResend: true),
                      child: const Text('Resend code'),
                    )
                  else
                    Text(
                      'You can request another code in $_resendCountdown seconds.',
                      style: theme.textTheme.bodySmall,
                      textAlign: TextAlign.center,
                    ),
                ],
                if (_errorMessage != null && !_codeSent) ...[
                  const SizedBox(height: AppSpacing.sm),
                  Text(
                    _errorMessage!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.error,
                    ),
                    textAlign: TextAlign.center,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
