enum UserRole { student, owner, admin }

extension UserRoleX on UserRole {
  String get value => name;
  String get displayName => switch (this) {
    UserRole.student => 'Student',
    UserRole.owner => 'Owner',
    UserRole.admin => 'Admin',
  };
  static UserRole fromString(String value) => UserRole.values.firstWhere(
    (e) => e.name == value,
    orElse: () => UserRole.student,
  );
}

enum RoomType { single, double, triple, shared }

enum FurnishingType { unfurnished, semi, fully }

enum GenderPreference { male, female, any }

/// The publication state of a room listing.
///
/// A [RoomStatus.draft] listing is an **unfinished** listing. It lives in
/// the owner-only `roomDrafts` collection and is never offered to a student.
/// The server moves it into the public `rooms` collection once it is
/// complete.
enum RoomStatus { available, occupied, inactive, draft }

enum JoinRequestStatus {
  pending,
  ownerConfirmed,
  studentConfirmed,
  adminReviewed,
  rejected,
  cancelled,
}

enum InvoiceStatus { pending, paid, overdue, cancelled }

/// Lifecycle of a platform-fee payment.
///
/// A payment is only ever marked [PaymentStatus.verified] by the server after
/// an admin has confirmed that the money actually arrived. The client can
/// submit a reference but can never mark itself as paid.
enum PaymentStatus { submitted, verified, rejected }

enum MessageType { text, image, contactShare }

enum NotificationType {
  newMessage,
  joinRequest,
  joinConfirmed,
  invoiceCreated,
  invoicePaid,
  adminReview,

  /// The account of the user changed — the deletion was scheduled or
  /// cancelled.
  account,

  /// A student wrote a review for a room.
  review,

  /// Anything the server could not classify.
  general,
}

extension RoomTypeX on RoomType {
  String get value => name;
  String get label => switch (this) {
    RoomType.single => 'Single Occupancy',
    RoomType.double => 'Double Occupancy',
    RoomType.triple => 'Triple Occupancy',
    RoomType.shared => 'Shared Room',
  };
  static RoomType fromString(String value) => RoomType.values.firstWhere(
    (e) => e.name == value,
    orElse: () => RoomType.single,
  );
}

extension FurnishingTypeX on FurnishingType {
  String get value => name;
  String get label => switch (this) {
    FurnishingType.unfurnished => 'Unfurnished',
    FurnishingType.semi => 'Semi Furnished',
    FurnishingType.fully => 'Fully Furnished',
  };
  static FurnishingType fromString(String value) =>
      FurnishingType.values.firstWhere(
        (e) => e.name == value,
        orElse: () => FurnishingType.unfurnished,
      );
}

extension GenderPreferenceX on GenderPreference {
  String get value => name;
  String get label => switch (this) {
    GenderPreference.male => 'Male Only',
    GenderPreference.female => 'Female Only',
    GenderPreference.any => 'Any',
  };
  static GenderPreference fromString(String value) => GenderPreference.values
      .firstWhere((e) => e.name == value, orElse: () => GenderPreference.any);
}

extension RoomStatusX on RoomStatus {
  String get value => name;
  String get label => switch (this) {
    RoomStatus.available => 'Available',
    RoomStatus.occupied => 'Occupied',
    RoomStatus.inactive => 'Inactive',
    RoomStatus.draft => 'Draft',
  };
  static RoomStatus fromString(String value) => RoomStatus.values.firstWhere(
    (e) => e.name == value,
    orElse: () => RoomStatus.available,
  );
}

extension JoinRequestStatusX on JoinRequestStatus {
  String get value => name;
  String get label => switch (this) {
    JoinRequestStatus.pending => 'Pending',
    JoinRequestStatus.studentConfirmed => 'Student Confirmed',
    JoinRequestStatus.ownerConfirmed => 'Owner Confirmed',
    JoinRequestStatus.adminReviewed => 'Admin Reviewed',
    JoinRequestStatus.rejected => 'Rejected',
    JoinRequestStatus.cancelled => 'Cancelled',
  };
  static JoinRequestStatus fromString(String value) =>
      JoinRequestStatus.values.firstWhere(
        (e) => e.name == value,
        orElse: () => JoinRequestStatus.pending,
      );
}

extension InvoiceStatusX on InvoiceStatus {
  String get value => name;
  String get label => switch (this) {
    InvoiceStatus.pending => 'Pending',
    InvoiceStatus.paid => 'Paid',
    InvoiceStatus.overdue => 'Overdue',
    InvoiceStatus.cancelled => 'Cancelled',
  };
  static InvoiceStatus fromString(String value) => InvoiceStatus.values
      .firstWhere((e) => e.name == value, orElse: () => InvoiceStatus.pending);
}

extension PaymentStatusX on PaymentStatus {
  String get value => name;
  String get label => switch (this) {
    PaymentStatus.submitted => 'Awaiting Verification',
    PaymentStatus.verified => 'Verified',
    PaymentStatus.rejected => 'Rejected',
  };
  static PaymentStatus fromString(String value) =>
      PaymentStatus.values.firstWhere(
        (e) => e.name == value,
        orElse: () => PaymentStatus.submitted,
      );
}
