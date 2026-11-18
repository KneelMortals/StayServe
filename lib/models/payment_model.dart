import 'package:cloud_firestore/cloud_firestore.dart';

import '../core/constants/enums.dart';

String _stringOr(dynamic value, String fallback) {
  return value is String ? value : fallback;
}

String? _optionalString(dynamic value) {
  return value is String ? value : null;
}

double _doubleOr(dynamic value, double fallback) {
  return value is num ? value.toDouble() : fallback;
}

/// A platform-fee payment attached to a join request.
///
/// The amount and the payee are decided by the server, never by the client,
/// so a modified app cannot redirect or underpay a fee.
class PaymentModel {
  final String paymentId;
  final String requestId;
  final String studentId;
  final String ownerId;
  final String roomId;

  /// Amount that was charged, in rupees.
  final double amount;

  /// The platform-fee percentage the server charged the amount with.
  final double feePercentage;

  /// The UTR / transaction reference the student paid with.
  final String reference;

  /// Payment instrument, e.g. `upi`.
  final String method;

  /// UPI address the money was sent to.
  final String payeeVpa;

  final PaymentStatus status;
  final DateTime submittedAt;
  final DateTime? verifiedAt;

  /// Uid of the admin that verified or rejected the payment.
  final String? verifiedBy;

  /// Optional note left by the reviewer.
  final String? note;

  const PaymentModel({
    required this.paymentId,
    required this.requestId,
    required this.studentId,
    required this.ownerId,
    required this.roomId,
    required this.amount,
    required this.feePercentage,
    required this.reference,
    required this.method,
    required this.payeeVpa,
    required this.status,
    required this.submittedAt,
    this.verifiedAt,
    this.verifiedBy,
    this.note,
  });

  factory PaymentModel.fromJson(Map<String, dynamic> json, String paymentId) {
    return PaymentModel(
      paymentId: paymentId,
      requestId: _stringOr(json['requestId'], ''),
      studentId: _stringOr(json['studentId'], ''),
      ownerId: _stringOr(json['ownerId'], ''),
      roomId: _stringOr(json['roomId'], ''),
      amount: _doubleOr(json['amount'], 0),
      feePercentage: _doubleOr(json['feePercentage'], 0),
      reference: _stringOr(json['reference'], ''),
      method: _stringOr(json['method'], 'upi'),
      payeeVpa: _stringOr(json['payeeVpa'], ''),
      status: PaymentStatusX.fromString(
        json['status'] is String ? json['status'] as String : 'submitted',
      ),
      submittedAt: _toDate(json['submittedAt']) ?? DateTime.now(),
      verifiedAt: _toDate(json['verifiedAt']),
      verifiedBy: _optionalString(json['verifiedBy']),
      note: _optionalString(json['note']),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'requestId': requestId,
      'studentId': studentId,
      'ownerId': ownerId,
      'roomId': roomId,
      'amount': amount,
      'feePercentage': feePercentage,
      'reference': reference,
      'method': method,
      'payeeVpa': payeeVpa,
      'status': status.value,
      'submittedAt': Timestamp.fromDate(submittedAt),
      'verifiedAt': verifiedAt != null ? Timestamp.fromDate(verifiedAt!) : null,
      'verifiedBy': verifiedBy,
      'note': note,
    };
  }

  /// Whether the money has been confirmed by an admin.
  bool get isVerified => status == PaymentStatus.verified;

  /// Whether the payment is waiting for an admin to look at it.
  bool get isAwaitingVerification => status == PaymentStatus.submitted;

  bool get isRejected => status == PaymentStatus.rejected;
}

/// Reads a Firestore timestamp defensively — a missing or malformed value
/// must never crash the payments list.
DateTime? _toDate(Object? value) {
  if (value is Timestamp) return value.toDate();
  if (value is DateTime) return value;
  if (value is String) return DateTime.tryParse(value);
  return null;
}
