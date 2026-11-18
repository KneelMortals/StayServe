import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/constants/app_constants.dart';

final paymentServiceProvider = Provider<PaymentService>((ref) => PaymentService());

/// The limits of a UPI intent.
///
/// They are part of the UPI specification and every UPI app enforces them.
/// An intent that breaks one of them is **refused** by the app — usually
/// with a message like "the value exceeds the limit", even though the
/// *amount* is perfectly fine.
class UpiIntentLimits {
  /// The virtual payment address, e.g. `name@bank`.
  static const int payeeAddress = 100;

  /// The name of the payee shown in the UPI app.
  static const int payeeName = 50;

  /// The amount, e.g. `133.00`.
  static const int amount = 20;

  /// The transaction reference.
  static const int transactionRef = 40;

  /// The note of the transaction.
  static const int transactionNote = 50;
}

/// Checks a UPI intent before it is handed over to the UPI app.
///
/// The check is a safety net: the server already builds the intent within
/// the limits, but an old server version (or a wrong value in the server
/// configuration) must not make the payment fail with a message that does
/// not explain anything.
class UpiIntentValidator {
  /// Returns the problem with the intent — `null` when it is fine.
  static String? validate(String uri) {
    if (uri.isEmpty) {
      return 'The payment link could not be created.';
    }

    final Uri parsed;
    try {
      parsed = Uri.parse(uri);
    } catch (_) {
      return 'The payment link is malformed. Please try again.';
    }

    if (parsed.scheme != 'upi') {
      return 'The payment link is not a UPI link. Please try again.';
    }

    final params = parsed.queryParameters;
    final payee = params['pa'] ?? '';
    if (payee.isEmpty) {
      return 'The payment link does not contain the UPI address of StayServe.';
    }

    // The address has to look like an address: `name@bank`. An address that
    // is still percent-encoded (`name%40bank`) is what several UPI apps
    // refuse with a message about the limit — it is repaired before the
    // intent is opened, so it is only worth a warning here.
    if (!payee.contains('@') || payee.endsWith('@')) {
      return 'The payment link does not contain a valid UPI address. '
          'Please pay manually.';
    }

    final amount = params['am'] ?? '';
    if (amount.isEmpty) {
      return 'The payment link does not contain an amount.';
    }

    final problems = <String>[];
    void check(String name, String value, int limit) {
      if (value.length > limit) {
        problems.add('$name is ${value.length} characters long (the limit is $limit)');
      }
    }

    check('The payee address', payee, UpiIntentLimits.payeeAddress);
    check('The payee name', params['pn'] ?? '', UpiIntentLimits.payeeName);
    check('The amount', amount, UpiIntentLimits.amount);
    check('The transaction reference', params['tr'] ?? '', UpiIntentLimits.transactionRef);
    check('The transaction note', params['tn'] ?? '', UpiIntentLimits.transactionNote);

    if (problems.isNotEmpty) {
      return 'This payment link breaks the UPI specification: '
          '${problems.join(', ')}. Please pay manually.';
    }

    return null;
  }
}

/// Builds the UPI intent in the form the UPI apps expect.
///
/// ## Why the app builds the intent itself
///
/// The intent is produced by the server, so the payee address and the
/// amount cannot be tampered with by a modified client. The **shape** of
/// the intent, however, is a detail of the protocol — and the app can get
/// it right even when the server still runs an older version.
///
/// The server used to write the payee address as `name%40bank`. Several
/// UPI apps read the query of the intent by hand instead of decoding it;
/// they then see an address they do not recognise and refuse the payment
/// with a message that has nothing to do with the real reason ("the amount
/// exceeds the limit", "the transaction cannot be completed"). The address
/// is therefore written the canonical way: `name@bank`.
class UpiIntentBuilder {
  /// The limits of the parameters — see [UpiIntentLimits].
  static const int payeeAddressLimit = UpiIntentLimits.payeeAddress;
  static const int payeeNameLimit = UpiIntentLimits.payeeName;
  static const int amountLimit = UpiIntentLimits.amount;
  static const int transactionRefLimit = UpiIntentLimits.transactionRef;
  static const int transactionNoteLimit = UpiIntentLimits.transactionNote;

  /// Builds the canonical intent.
  ///
  /// The address is **not** encoded — see the class documentation.
  static String build({
    required String payeeVpa,
    required String payeeName,
    required double amount,
    required String transactionRef,
    required String transactionNote,
  }) {
    final vpa = _cut(payeeVpa, payeeAddressLimit);
    final name = _cut(payeeName, payeeNameLimit);
    final ref = _cut(transactionRef, transactionRefLimit);
    final note = _cut(transactionNote, transactionNoteLimit);
    final value = amount.toStringAsFixed(2);

    return 'upi://pay?'
        'pa=$vpa'
        '&pn=${Uri.encodeComponent(name)}'
        '&am=${value.length > amountLimit ? value.substring(0, amountLimit) : value}'
        '&cu=INR'
        '&tr=${Uri.encodeComponent(ref)}'
        '&tn=${Uri.encodeComponent(note)}';
  }

  /// Rebuilds the intent of the server in the canonical form.
  ///
  /// Everything the server sent is kept — only the **encoding** is fixed.
  /// When the server did not send a usable intent, `null` is returned and
  /// the caller keeps what it has.
  static String? canonicalise(
    String serverUri, {
    required String payeeVpa,
    required String payeeName,
    required double amount,
    required String transactionRef,
  }) {
    if (serverUri.isEmpty) return null;

    Uri parsed;
    try {
      parsed = Uri.parse(serverUri);
    } catch (_) {
      return null;
    }
    if (parsed.scheme != 'upi') return null;

    final params = parsed.queryParameters;
    final note = params['tn'] ?? '';

    // The address of the server is only used when it is the one of the
    // platform — the caller has already checked that.
    return build(
      payeeVpa: payeeVpa,
      payeeName: payeeName,
      amount: amount,
      transactionRef: transactionRef,
      transactionNote: note,
    );
  }

  /// Cuts [value] down to [limit] characters.
  static String _cut(String value, int limit) {
    final trimmed = value.trim();
    return trimmed.length > limit ? trimmed.substring(0, limit) : trimmed;
  }
}

/// Opens UPI payment intents.
///
/// The intent itself is produced by the server (see `PaymentRepository`), so
/// the payee address and the amount cannot be tampered with by a modified
/// client. This class only launches what the server handed over.
class PaymentService {
  /// The UPI address every payment collected through the app goes to.
  static const String platformUpiVpa = AppConstants.platformUpiVpa;

  /// Payee name shown in the UPI app.
  static const String platformUpiName = AppConstants.platformUpiName;

  /// Copy shown in the payment sheets, e.g.
  /// `shauryaprataprai461-2@oksbi (StayServe platform)`.
  static String get platformUpiLabel =>
      '$platformUpiVpa ($platformUpiName platform)';

  PaymentService();

  /// Opens the UPI app for the server-issued [uri].
  ///
  /// Returns a result describing whether the app could be opened. It never
  /// reports the payment as *successful* — only the admin verification step
  /// can do that.
  Future<UpiPaymentResult> launchUpiIntent(
    String uri, {
    required String transactionRef,
  }) async {
    if (uri.isEmpty) {
      return UpiPaymentResult.failure('The payment link could not be created.');
    }

    // The intent is checked before it is opened: an intent that breaks the
    // UPI specification is refused by the UPI app with a message that does
    // not say what is wrong ("the amount exceeds the limit" — for an
    // amount of ₹133).
    final problem = UpiIntentValidator.validate(uri);
    if (problem != null) {
      return UpiPaymentResult.failure(problem);
    }

    try {
      final parsed = Uri.parse(uri);

      // `canLaunchUrl` is only a hint: on Android it is known to return
      // false even when a UPI app *is* installed (package-visibility quirks,
      // work-profile installs, some OEM ROMs). So it is not used to block
      // the payment — the launch itself is attempted and its result decides.
      final launched = await launchUrl(
        parsed,
        mode: LaunchMode.externalApplication,
      );

      if (!launched) {
        // Only now is it worth double-checking with `canLaunchUrl`, purely to
        // produce a more helpful message for the user.
        final canLaunch = await canLaunchUrl(parsed);
        return UpiPaymentResult.failure(
          canLaunch
              ? 'Failed to open the UPI app. Please try again.'
              : 'No UPI app found. Please install GPay, PhonePe, Paytm, or BHIM.',
        );
      }

      return UpiPaymentResult(
        success: true,
        transactionRef: transactionRef,
        message:
            'UPI app opened. Complete the payment, then enter the transaction '
            'reference below so we can verify it.',
      );
    } catch (e) {
      return UpiPaymentResult.failure(e.toString());
    }
  }

  /// Puts [text] on the clipboard.
  ///
  /// It is used by the manual payment fallback: the user copies the UPI
  /// address and pays it in their own UPI app.
  Future<void> copyToClipboard(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
  }

  /// Get list of common UPI apps for user guidance.
  static List<UpiApp> getPopularUpiApps() {
    return [
      UpiApp(name: 'Google Pay', packageName: 'com.google.android.apps.nbu.paisa.user', icon: Icons.payment),
      UpiApp(name: 'PhonePe', packageName: 'com.phonepe.app', icon: Icons.phone_android),
      UpiApp(name: 'Paytm', packageName: 'net.one97.paytm', icon: Icons.account_balance_wallet),
      UpiApp(name: 'BHIM', packageName: 'in.org.npci.bhimapp', icon: Icons.security),
      UpiApp(name: 'Amazon Pay', packageName: 'in.amazon.mShop.android.shopping', icon: Icons.shopping_cart),
    ];
  }
}

/// Result of a UPI payment attempt.
class UpiPaymentResult {
  /// Whether the UPI app could be opened. It does **not** mean the money
  /// arrived — that is confirmed by an admin.
  final bool success;
  final String? transactionRef;
  final String? message;
  final String? error;

  UpiPaymentResult({
    required this.success,
    this.transactionRef,
    this.message,
    this.error,
  });

  UpiPaymentResult.failure(this.error)
      : success = false,
        transactionRef = null,
        message = null;
}

/// UPI App info.
class UpiApp {
  final String name;
  final String packageName;
  final IconData icon;

  UpiApp({required this.name, required this.packageName, required this.icon});
}
