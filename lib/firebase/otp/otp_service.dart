import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../functions/functions_service.dart';

/// The kind of contact a verification code was sent to.
enum OtpChannel { email, mobile }

extension OtpChannelX on OtpChannel {
  String get wireValue => name;

  String get label => this == OtpChannel.email ? 'email address' : 'mobile number';

  static OtpChannel fromWire(String value) {
    return value == OtpChannel.mobile.name ? OtpChannel.mobile : OtpChannel.email;
  }
}

/// Result of requesting a verification code.
class OtpSendResult {
  final bool success;
  final bool delivered;
  final int expiresInSeconds;
  final int resendAfterSeconds;

  const OtpSendResult({
    required this.success,
    required this.delivered,
    required this.expiresInSeconds,
    required this.resendAfterSeconds,
  });
}

/// Result of verifying a code.
class OtpVerifyResult {
  /// Whether the code was accepted.
  final bool verified;

  /// The one-time challenge of the verification.
  ///
  /// It proves that **this** client really entered the code, and it is what
  /// the registration needs. It may be used only once.
  ///
  /// It is empty when the address had already been verified by somebody
  /// else — the challenge is then not handed out a second time.
  final String challenge;

  /// Whether the address had already been verified before.
  final bool alreadyVerified;

  const OtpVerifyResult({
    required this.verified,
    this.challenge = '',
    this.alreadyVerified = false,
  });
}

final otpServiceProvider = Provider<OtpService>((ref) {
  return OtpService(ref.watch(functionsServiceProvider));
});

/// Client for the `sendOtp` / `verifyOtp` cloud functions.
class OtpService {
  final FunctionsService _functions;

  OtpService(this._functions);

  /// Requests a verification code for [identifier].
  Future<OtpSendResult> sendOtp({
    required OtpChannel channel,
    required String identifier,
  }) async {
    final result = await _functions.callFunction(
      'sendOtp',
      parameters: {
        'channel': channel.wireValue,
        'identifier': identifier.trim(),
      },
    );

    final data = Map<String, dynamic>.from(result.data as Map);
    return OtpSendResult(
      success: data['success'] as bool? ?? true,
      delivered: data['delivered'] as bool? ?? false,
      expiresInSeconds: data['expiresInSeconds'] as int? ?? 300,
      resendAfterSeconds: data['resendAfterSeconds'] as int? ?? 30,
    );
  }

  /// Verifies the code the user typed in.
  ///
  /// Throws a [FirebaseFunctionsException] carrying the server message when
  /// the code is wrong, expired or the attempt limit is reached.
  ///
  /// The answer carries the one-time **challenge** of the verification — the
  /// proof that this client really entered the code. The registration needs
  /// it, and it may be used only once.
  Future<OtpVerifyResult> verifyOtp({
    required OtpChannel channel,
    required String identifier,
    required String otp,
  }) async {
    final result = await _functions.callFunction(
      'verifyOtp',
      parameters: {
        'channel': channel.wireValue,
        'identifier': identifier.trim(),
        'otp': otp.trim(),
      },
    );

    final data = Map<String, dynamic>.from(result.data as Map);
    return OtpVerifyResult(
      verified: data['verified'] as bool? ?? false,
      challenge: data['challenge'] as String? ?? '',
      alreadyVerified: data['alreadyVerified'] as bool? ?? false,
    );
  }

  /// Claims the role for the signed-in user once their email is verified.
  Future<void> registerUserRole({required String role}) async {
    await _functions.callFunction(
      'registerUserRole',
      parameters: {'role': role},
    );
  }

  /// Completes the sign-up.
  ///
  /// The server re-checks that the email address has been verified with an
  /// OTP and then writes the profile itself, so a modified client cannot
  /// skip the verification.
  ///
  /// The [challenge] is the proof that **this** client really entered the
  /// code — it may be used only once, for one registration.
  ///
  /// The [phone] is optional contact information. While SMS verification is
  /// disabled on the server it is not verified at all; when phone
  /// verification is switched on the server requires a verified number and
  /// rejects this call without one.
  Future<void> completeRegistration({
    required String name,
    required String role,
    required String challenge,
    String? phone,
    String? phoneChallenge,
    String? pincode,
  }) async {
    final trimmedPhone = phone?.trim() ?? '';
    await _functions.callFunction(
      'completeRegistration',
      parameters: {
        'name': name.trim(),
        'phone': trimmedPhone,
        'role': role,
        'challenge': challenge,
        'phoneChallenge': phoneChallenge,
        'pincode': pincode,
      },
    );
  }
}
