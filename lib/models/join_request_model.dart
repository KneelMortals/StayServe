import 'package:cloud_firestore/cloud_firestore.dart';
import '../../core/constants/enums.dart';

// Helper functions to parse enum strings (avoiding extension method issues)
JoinRequestStatus _parseJoinRequestStatus(String value) {
  // Accepts the enum name (`ownerConfirmed`) as well as the legacy
  // snake_case value (`owner_confirmed`) that older documents may contain.
  const legacyValues = {
    'student_confirmed': JoinRequestStatus.studentConfirmed,
    'owner_confirmed': JoinRequestStatus.ownerConfirmed,
    'admin_reviewed': JoinRequestStatus.adminReviewed,
  };

  return JoinRequestStatus.values.firstWhere(
    (e) => e.name == value,
    orElse: () => legacyValues[value] ?? JoinRequestStatus.pending,
  );
}

InvoiceStatus _parseInvoiceStatus(String value) {
  return InvoiceStatus.values.firstWhere(
    (e) => e.name == value,
    orElse: () => InvoiceStatus.pending,
  );
}

String _stringOr(dynamic value, String fallback) {
  return value is String ? value : fallback;
}

String? _optionalString(dynamic value) {
  return value is String ? value : null;
}

double _doubleOr(dynamic value, double fallback) {
  return value is num ? value.toDouble() : fallback;
}

double? _optionalDouble(dynamic value) {
  return value is num ? value.toDouble() : null;
}

bool _boolOr(dynamic value, bool fallback) {
  return value is bool ? value : fallback;
}

class JoinRequestModel {
  final String requestId;
  final String roomId;
  final String studentId;
  final String ownerId;
  final JoinRequestStatus status;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? studentConfirmedAt;
  final DateTime? ownerConfirmedAt;
  final DateTime? adminReviewedAt;
  final DateTime? rejectedAt;
  final String? rejectionReason;
  final double monthlyRentAtJoin;
  final double commissionPercentageAtJoin;
  final String? invoiceId;
  final bool advancePaid;
  final double? advanceAmount;
  final String? advancePaymentReference;
  final String? advancePaymentMethod;
  final String? advanceUpiTransactionId;
  final DateTime? advancePaidAt;

  /// State of the platform-fee payment for this request.
  ///
  /// `null` means no payment was submitted yet. Only the server can move
  /// this to [PaymentStatus.verified].
  final PaymentStatus? advancePaymentStatus;

  /// Whether the platform has already taken its cut for this booking.
  ///
  /// The cut belongs to the **first** payment of a booking. Once it has
  /// been taken, every later payment goes straight from the student to the
  /// room owner — the platform does not take a percentage any more.
  ///
  /// Only the server writes this field.
  final bool platformCutTaken;

  /// Who settles the platform fee — `student` or `owner`.
  ///
  /// Only the server writes this field.
  final String platformFeePayer;

  JoinRequestModel({
    required this.requestId,
    required this.roomId,
    required this.studentId,
    required this.ownerId,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.studentConfirmedAt,
    this.ownerConfirmedAt,
    this.adminReviewedAt,
    this.rejectedAt,
    this.rejectionReason,
    required this.monthlyRentAtJoin,
    required this.commissionPercentageAtJoin,
    this.invoiceId,
    this.advancePaid = false,
    this.advanceAmount,
    this.advancePaymentReference,
    this.advancePaymentMethod,
    this.advanceUpiTransactionId,
    this.advancePaidAt,
    this.advancePaymentStatus,
    this.platformCutTaken = false,
    this.platformFeePayer = 'owner',
  });

  factory JoinRequestModel.fromJson(Map<String, dynamic> json) {
    return JoinRequestModel(
      requestId: _stringOr(json['requestId'], ''),
      roomId: _stringOr(json['roomId'], ''),
      studentId: _stringOr(json['studentId'], ''),
      ownerId: _stringOr(json['ownerId'], ''),
      status: _parseJoinRequestStatus(
        json['status'] is String ? json['status'] as String : '',
      ),
      createdAt: _toDate(json['createdAt']),
      updatedAt: _toDate(json['updatedAt']),
      studentConfirmedAt: _toDateOrNull(json['studentConfirmedAt']),
      ownerConfirmedAt: _toDateOrNull(json['ownerConfirmedAt']),
      adminReviewedAt: _toDateOrNull(json['adminReviewedAt']),
      rejectedAt: _toDateOrNull(json['rejectedAt']),
      rejectionReason: _optionalString(json['rejectionReason']),
      monthlyRentAtJoin: _doubleOr(json['monthlyRentAtJoin'], 0),
      commissionPercentageAtJoin: _doubleOr(
        json['commissionPercentageAtJoin'],
        0,
      ),
      invoiceId: _optionalString(json['invoiceId']),
      advancePaid: _boolOr(json['advancePaid'], false),
      advanceAmount: _optionalDouble(json['advanceAmount']),
      advancePaymentReference: _optionalString(json['advancePaymentReference']),
      advancePaymentMethod: _optionalString(json['advancePaymentMethod']),
      advanceUpiTransactionId: _optionalString(json['advanceUpiTransactionId']),
      advancePaidAt: _toDateOrNull(json['advancePaidAt']),
      advancePaymentStatus: json['advancePaymentStatus'] is String
          ? PaymentStatusX.fromString(json['advancePaymentStatus'] as String)
          : null,
      platformCutTaken: _boolOr(json['platformCutTaken'], false),
      platformFeePayer: _stringOr(json['platformFeePayer'], 'owner'),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'requestId': requestId,
      'roomId': roomId,
      'studentId': studentId,
      'ownerId': ownerId,
      'status': status.value,
      'createdAt': Timestamp.fromDate(createdAt),
      'updatedAt': Timestamp.fromDate(updatedAt),
      'studentConfirmedAt': studentConfirmedAt != null
          ? Timestamp.fromDate(studentConfirmedAt!)
          : null,
      'ownerConfirmedAt': ownerConfirmedAt != null
          ? Timestamp.fromDate(ownerConfirmedAt!)
          : null,
      'adminReviewedAt': adminReviewedAt != null
          ? Timestamp.fromDate(adminReviewedAt!)
          : null,
      'rejectedAt': rejectedAt != null ? Timestamp.fromDate(rejectedAt!) : null,
      'rejectionReason': rejectionReason,
      'monthlyRentAtJoin': monthlyRentAtJoin,
      'commissionPercentageAtJoin': commissionPercentageAtJoin,
      'invoiceId': invoiceId,
      'advancePaid': advancePaid,
      'advanceAmount': advanceAmount,
      'advancePaymentReference': advancePaymentReference,
      'advancePaymentMethod': advancePaymentMethod,
      'advanceUpiTransactionId': advanceUpiTransactionId,
      'advancePaidAt': advancePaidAt != null
          ? Timestamp.fromDate(advancePaidAt!)
          : null,
      'advancePaymentStatus': advancePaymentStatus?.value,
      'platformCutTaken': platformCutTaken,
      'platformFeePayer': platformFeePayer,
    };
  }

  JoinRequestModel copyWith({
    String? requestId,
    String? roomId,
    String? studentId,
    String? ownerId,
    JoinRequestStatus? status,
    DateTime? createdAt,
    DateTime? updatedAt,
    DateTime? studentConfirmedAt,
    DateTime? ownerConfirmedAt,
    DateTime? adminReviewedAt,
    DateTime? rejectedAt,
    String? rejectionReason,
    double? monthlyRentAtJoin,
    double? commissionPercentageAtJoin,
    String? invoiceId,
    bool? advancePaid,
    double? advanceAmount,
    String? advancePaymentReference,
    String? advancePaymentMethod,
    String? advanceUpiTransactionId,
    DateTime? advancePaidAt,
    PaymentStatus? advancePaymentStatus,
    bool? platformCutTaken,
    String? platformFeePayer,
  }) {
    return JoinRequestModel(
      requestId: requestId ?? this.requestId,
      roomId: roomId ?? this.roomId,
      studentId: studentId ?? this.studentId,
      ownerId: ownerId ?? this.ownerId,
      status: status ?? this.status,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      studentConfirmedAt: studentConfirmedAt ?? this.studentConfirmedAt,
      ownerConfirmedAt: ownerConfirmedAt ?? this.ownerConfirmedAt,
      adminReviewedAt: adminReviewedAt ?? this.adminReviewedAt,
      rejectedAt: rejectedAt ?? this.rejectedAt,
      rejectionReason: rejectionReason ?? this.rejectionReason,
      monthlyRentAtJoin: monthlyRentAtJoin ?? this.monthlyRentAtJoin,
      commissionPercentageAtJoin:
          commissionPercentageAtJoin ?? this.commissionPercentageAtJoin,
      invoiceId: invoiceId ?? this.invoiceId,
      advancePaid: advancePaid ?? this.advancePaid,
      advanceAmount: advanceAmount ?? this.advanceAmount,
      advancePaymentReference:
          advancePaymentReference ?? this.advancePaymentReference,
      advancePaymentMethod: advancePaymentMethod ?? this.advancePaymentMethod,
      advanceUpiTransactionId:
          advanceUpiTransactionId ?? this.advanceUpiTransactionId,
      advancePaidAt: advancePaidAt ?? this.advancePaidAt,
      advancePaymentStatus: advancePaymentStatus ?? this.advancePaymentStatus,
      platformCutTaken: platformCutTaken ?? this.platformCutTaken,
      platformFeePayer: platformFeePayer ?? this.platformFeePayer,
    );
  }

  bool get isPending => status == JoinRequestStatus.pending;
  bool get isStudentConfirmed => status == JoinRequestStatus.studentConfirmed;
  bool get isOwnerConfirmed => status == JoinRequestStatus.ownerConfirmed;
  bool get isAdminReviewed => status == JoinRequestStatus.adminReviewed;
  bool get isRejected => status == JoinRequestStatus.rejected;
  bool get isCancelled => status == JoinRequestStatus.cancelled;
  bool get isCompleted => isAdminReviewed;

  /// Whether the **owner has accepted** this request.
  ///
  /// The owner accepts a request by moving it to `ownerConfirmed`; the
  /// student then confirms it (`studentConfirmed`) and admin payment
  /// verification activates the booking (`adminReviewed`). All three mean the
  /// same thing for the
  /// features that are built on top of the acceptance:
  ///
  ///  - the student may **review** the room, and
  ///  - the student may see **where** the room is.
  ///
  /// The server makes the very same check (see `OWNER_ACCEPTED_STATUSES` in
  /// `functions/src/bookingAccess.ts`), so the app and the server can never
  /// disagree about who is allowed to do what.
  bool get isOwnerAccepted =>
      status == JoinRequestStatus.ownerConfirmed ||
      status == JoinRequestStatus.studentConfirmed ||
      status == JoinRequestStatus.adminReviewed;

  /// Whether the booking can still be walked away from.
  ///
  /// A booking may only be cancelled while **nothing was paid** for it —
  /// otherwise the platform would have to give the money back and the room
  /// would have to give the slot back.
  ///
  /// This is why the request can still be cancelled after the owner
  /// accepted it: the acceptance alone is not a payment.
  ///
  /// A **rejected** request is over as well — it was declined, so there is
  /// nothing left to cancel. The server makes the very same check.
  bool get canBeCancelled =>
      !isAdminReviewed &&
      !isCancelled &&
      !isRejected &&
      !advancePaid &&
      !platformCutTaken &&
      advancePaymentStatus != PaymentStatus.submitted &&
      advancePaymentStatus != PaymentStatus.verified;

  double get commissionAmount =>
      monthlyRentAtJoin * commissionPercentageAtJoin / 100;

  JoinRequestModel copyWithUpdatedAt() => copyWith(updatedAt: DateTime.now());
}

class CommissionInvoiceModel {
  final String invoiceId;
  final String roomId;
  final String ownerId;
  final String tenantId;
  final String joinRequestId;
  final double monthlyRent;
  final double commissionPercentage;
  final double commissionAmount;
  final InvoiceStatus status;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? paidAt;
  final String? paymentReference;
  final String? paymentMethod;
  final String? upiTransactionId;

  CommissionInvoiceModel({
    required this.invoiceId,
    required this.roomId,
    required this.ownerId,
    required this.tenantId,
    required this.joinRequestId,
    required this.monthlyRent,
    required this.commissionPercentage,
    required this.commissionAmount,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.paidAt,
    this.paymentReference,
    this.paymentMethod,
    this.upiTransactionId,
  });

  factory CommissionInvoiceModel.fromJson(Map<String, dynamic> json) {
    return CommissionInvoiceModel(
      invoiceId: _stringOr(json['invoiceId'], ''),
      roomId: _stringOr(json['roomId'], ''),
      ownerId: _stringOr(json['ownerId'], ''),
      tenantId: _stringOr(json['tenantId'], ''),
      joinRequestId: _stringOr(json['joinRequestId'], ''),
      monthlyRent: _doubleOr(json['monthlyRent'], 0),
      commissionPercentage: _doubleOr(json['commissionPercentage'], 0),
      commissionAmount: _doubleOr(json['commissionAmount'], 0),
      status: _parseInvoiceStatus(
        json['status'] is String ? json['status'] as String : '',
      ),
      createdAt: _toDate(json['createdAt']),
      updatedAt: _toDate(json['updatedAt']),
      paidAt: _toDateOrNull(json['paidAt']),
      paymentReference: _optionalString(json['paymentReference']),
      paymentMethod: _optionalString(json['paymentMethod']),
      upiTransactionId: _optionalString(json['upiTransactionId']),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'invoiceId': invoiceId,
      'roomId': roomId,
      'ownerId': ownerId,
      'tenantId': tenantId,
      'joinRequestId': joinRequestId,
      'monthlyRent': monthlyRent,
      'commissionPercentage': commissionPercentage,
      'commissionAmount': commissionAmount,
      'status': status.value,
      'createdAt': Timestamp.fromDate(createdAt),
      'updatedAt': Timestamp.fromDate(updatedAt),
      'paidAt': paidAt != null ? Timestamp.fromDate(paidAt!) : null,
      'paymentReference': paymentReference,
      'paymentMethod': paymentMethod,
      'upiTransactionId': upiTransactionId,
    };
  }

  CommissionInvoiceModel copyWith({
    String? invoiceId,
    String? roomId,
    String? ownerId,
    String? tenantId,
    String? joinRequestId,
    double? monthlyRent,
    double? commissionPercentage,
    double? commissionAmount,
    InvoiceStatus? status,
    DateTime? createdAt,
    DateTime? updatedAt,
    DateTime? paidAt,
    String? paymentReference,
    String? paymentMethod,
    String? upiTransactionId,
  }) {
    return CommissionInvoiceModel(
      invoiceId: invoiceId ?? this.invoiceId,
      roomId: roomId ?? this.roomId,
      ownerId: ownerId ?? this.ownerId,
      tenantId: tenantId ?? this.tenantId,
      joinRequestId: joinRequestId ?? this.joinRequestId,
      monthlyRent: monthlyRent ?? this.monthlyRent,
      commissionPercentage: commissionPercentage ?? this.commissionPercentage,
      commissionAmount: commissionAmount ?? this.commissionAmount,
      status: status ?? this.status,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      paidAt: paidAt ?? this.paidAt,
      paymentReference: paymentReference ?? this.paymentReference,
      paymentMethod: paymentMethod ?? this.paymentMethod,
      upiTransactionId: upiTransactionId ?? this.upiTransactionId,
    );
  }

  bool get isPending => status == InvoiceStatus.pending;
  bool get isPaid => status == InvoiceStatus.paid;
  bool get isOverdue => status == InvoiceStatus.overdue;
  bool get isCancelled => status == InvoiceStatus.cancelled;

  CommissionInvoiceModel copyWithUpdatedAt() =>
      copyWith(updatedAt: DateTime.now());
}

class TimestampConverter {
  const TimestampConverter();

  DateTime fromJson(Timestamp timestamp) => timestamp.toDate();
  Timestamp toJson(DateTime date) => Timestamp.fromDate(date);
}

class TimestampConverterNullable {
  const TimestampConverterNullable();

  DateTime? fromJson(Timestamp? timestamp) => timestamp?.toDate();
  Timestamp? toJson(DateTime? date) =>
      date != null ? Timestamp.fromDate(date) : null;
}

/// Reads a Firestore timestamp (or ISO string) into a [DateTime] without
/// throwing when the field is missing or stored in a different format.
///
/// A single malformed document must never take a whole list down — the admin
/// screens used to show "Could not load" because of one bad row.
DateTime _toDate(dynamic value) {
  if (value is Timestamp) return value.toDate();
  if (value is DateTime) return value;
  if (value is String) {
    final parsed = DateTime.tryParse(value);
    if (parsed != null) return parsed;
  }
  return DateTime.fromMillisecondsSinceEpoch(0);
}

/// The nullable variant of [_toDate].
DateTime? _toDateOrNull(dynamic value) {
  if (value == null) return null;
  if (value is Timestamp) return value.toDate();
  if (value is DateTime) return value;
  if (value is String) return DateTime.tryParse(value);
  return null;
}
