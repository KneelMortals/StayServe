import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/app_constants.dart';
import '../../../core/constants/enums.dart';
import '../../../core/utils/app_logger.dart';
import '../../../core/utils/safe_document_parser.dart';
import '../../../models/payment_model.dart';
import '../../../services/payment_service.dart';
import '../auth/auth_service.dart';
import '../functions/functions_service.dart';

final paymentRepositoryProvider = Provider<PaymentRepository>((ref) {
  return PaymentRepository(
    firestore: ref.watch(firestoreProvider),
    auth: ref.watch(firebaseAuthProvider),
    functions: ref.watch(functionsServiceProvider),
  );
});

/// A UPI payment intent produced by the server.
///
/// Both the [amount] and the [payeeVpa] are decided server side so that a
/// tampered client can neither redirect the money nor underpay the fee.
class UpiPaymentIntent {
  final String uri;
  final double amount;
  final double feePercentage;
  final String payeeVpa;
  final String payeeName;
  final String transactionRef;

  /// Who settles the platform fee — `student`, `owner` or `none`.
  final String payer;

  /// Whether the **student** has to open the UPI app.
  ///
  /// It is `false` when the room owner pays the fee, and when the cut has
  /// already been taken for this booking.
  final bool studentPays;

  /// Whether **this caller** has to open the UPI app.
  ///
  /// The payment option is offered on **both** sides of a booking: the
  /// student sees it in their request list, the owner sees it in theirs.
  /// This flag says whether the party that is looking at the sheet is the
  /// one that has to pay — the other one only sees an explanation of who
  /// settles the fee.
  final bool youPay;

  /// Whether the platform fee of this booking has already been collected.
  ///
  /// The cut is taken only once — from the second payment on, the rent goes
  /// straight from the student to the room owner.
  final bool alreadySettled;

  /// Whether the platform fee is **waived** (the admin set the percentage
  /// to 0 %).
  ///
  /// There is nothing to pay in that case: no UPI app is opened and no
  /// transaction reference is entered. The booking is still submitted for
  /// admin verification before it becomes a joined room.
  final bool feeWaived;

  /// A message from the server that explains the state of the payment.
  final String message;

  const UpiPaymentIntent({
    required this.uri,
    required this.amount,
    required this.feePercentage,
    required this.payeeVpa,
    required this.payeeName,
    required this.transactionRef,
    this.payer = 'student',
    this.studentPays = true,
    this.youPay = true,
    this.alreadySettled = false,
    this.feeWaived = false,
    this.message = '',
  });

  factory UpiPaymentIntent.fromData(Map<String, dynamic> data) {
    return UpiPaymentIntent(
      uri: data['uri'] as String? ?? '',
      amount: (data['amount'] as num?)?.toDouble() ?? 0,
      feePercentage: (data['feePercentage'] as num?)?.toDouble() ?? 0,
      payeeVpa: data['payeeVpa'] as String? ?? '',
      payeeName: data['payeeName'] as String? ?? '',
      transactionRef: data['transactionRef'] as String? ?? '',
      payer: data['payer'] as String? ?? 'student',
      studentPays: data['studentPays'] as bool? ?? true,
      // The server answers with `youPay`. When it does not (an older
      // server version) the student is assumed to pay — that was the only
      // possibility before.
      youPay: data['youPay'] as bool? ?? (data['studentPays'] as bool? ?? true),
      alreadySettled: data['alreadySettled'] as bool? ?? false,
      feeWaived: data['feeWaived'] as bool? ?? false,
      message: data['message'] as String? ?? '',
    );
  }
}

/// Data access for platform-fee payments.
///
/// Every state transition goes through a Cloud Function, so the client can
/// never mark a payment as paid on its own.
class PaymentRepository {
  final FirebaseFirestore _firestore;
  final FirebaseAuth _auth;
  final FunctionsService _functions;

  PaymentRepository({
    required this._firestore,
    required this._auth,
    required this._functions,
  });

  String? get _uid => _auth.currentUser?.uid;

  /// Asks the server for a UPI intent for the given join request.
  ///
  /// The server recomputes the fee from the rent it has on file and signs the
  /// intent with the platform VPA. The returned VPA is checked against
  /// [AppConstants.platformUpiVpa] so a misconfigured server fails loudly
  /// instead of silently redirecting the money.
  ///
  /// The intent is then rebuilt in the **canonical** form (see
  /// [UpiIntentBuilder]): the server used to write the payee address as
  /// `name%40bank`, and several UPI apps read the query by hand instead of
  /// decoding it — they did not recognise the address and refused the
  /// payment with a message about the limit. The app fixes the shape of the
  /// intent itself, so it works even when the server still runs the older
  /// version.
  Future<UpiPaymentIntent> createPaymentIntent({
    required String requestId,
  }) async {
    final result = await _functions.callFunction(
      'createUpiPayment',
      parameters: {'joinRequestId': requestId},
    );
    final intent = UpiPaymentIntent.fromData(
      Map<String, dynamic>.from(result.data as Map),
    );

    if (intent.payeeVpa != AppConstants.platformUpiVpa) {
      throw Exception(
        'Payment payee mismatch. Expected ${AppConstants.platformUpiVpa} but the '
        'server returned ${intent.payeeVpa}. Payment was not started.',
      );
    }

    final canonical = UpiIntentBuilder.canonicalise(
      intent.uri,
      payeeVpa: intent.payeeVpa,
      payeeName: intent.payeeName,
      amount: intent.amount,
      transactionRef: intent.transactionRef,
    );

    if (canonical == null) return intent;

    return UpiPaymentIntent(
      uri: canonical,
      amount: intent.amount,
      feePercentage: intent.feePercentage,
      payeeVpa: intent.payeeVpa,
      payeeName: intent.payeeName,
      transactionRef: intent.transactionRef,
      payer: intent.payer,
      studentPays: intent.studentPays,
      youPay: intent.youPay,
      alreadySettled: intent.alreadySettled,
      feeWaived: intent.feeWaived,
      message: intent.message,
    );
  }

  /// Records the reference that was paid with.
  ///
  /// A submission is **not** an activated booking. The request and payment
  /// stay in the `submitted` state; no invoice is created and no occupancy
  /// is changed. An admin verifies the payment separately, and only that
  /// verification moves the request to `adminReviewed` and makes it a joined
  /// room. A rejection restores the payable state.
  Future<void> submitPayment({
    required String requestId,
    required String reference,
    String method = 'upi',
  }) async {
    await _functions.callFunction(
      'submitPayment',
      parameters: {
        'requestId': requestId,
        'reference': reference.trim(),
        'method': method,
      },
    );
  }

  /// Admin-only: confirms or rejects a submitted payment.
  Future<void> verifyPayment({
    required String requestId,
    required bool approve,
    String? note,
  }) async {
    await _functions.callFunction(
      'verifyPayment',
      parameters: {
        'requestId': requestId,
        'approve': approve,
        'note': note?.trim(),
      },
    );
  }

  /// All payments, optionally filtered by status. Admin only.
  Stream<List<PaymentModel>> watchPayments({PaymentStatus? status}) {
    Query<Map<String, dynamic>> query = _firestore.collection('payments');
    if (status != null) {
      query = query.where('status', isEqualTo: status.value);
    }
    return query
        .orderBy('submittedAt', descending: true)
        .snapshots()
        .map(_toPayments);
  }

  /// Payments the current student has submitted.
  Stream<List<PaymentModel>> watchStudentPayments() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);
    return _firestore
        .collection('payments')
        .where('studentId', isEqualTo: uid)
        .orderBy('submittedAt', descending: true)
        .snapshots()
        .map(_toPayments);
  }

  /// Payments made towards the current owner's rooms.
  Stream<List<PaymentModel>> watchOwnerPayments() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);
    return _firestore
        .collection('payments')
        .where('ownerId', isEqualTo: uid)
        .orderBy('submittedAt', descending: true)
        .snapshots()
        .map(_toPayments);
  }

  List<PaymentModel> _toPayments(QuerySnapshot<Map<String, dynamic>> snapshot) {
    return parseDocumentsSafely(
      snapshot.docs.map((doc) => (id: doc.id, data: doc.data())),
      (id, data) => PaymentModel.fromJson(data, id),
      onError: (id, error) =>
          AppLogger.warning('Could not read the payment $id', error: error),
    );
  }
}
