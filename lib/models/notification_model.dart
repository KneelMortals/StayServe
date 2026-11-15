import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import '../../core/constants/enums.dart';

class NotificationModel {
  final String notificationId;
  final String userId;
  final NotificationType type;
  final String title;
  final String body;
  final Map<String, dynamic> data;
  final DateTime createdAt;
  final DateTime? readAt;
  final bool sent;

  const NotificationModel({
    required this.notificationId,
    required this.userId,
    required this.type,
    required this.title,
    required this.body,
    required this.data,
    required this.createdAt,
    this.readAt,
    this.sent = false,
  });

  factory NotificationModel.fromJson(Map<String, dynamic> json) {
    return NotificationModel(
      notificationId: json['notificationId'] as String,
      userId: json['userId'] as String,
      type: NotificationType.values.firstWhere(
        (e) => e.name == json['type'],
        // An unknown type falls back to `general` — and **not** to
        // `newMessage`, which would open the conversation list for a
        // notification that has nothing to do with a message.
        orElse: () => NotificationType.general,
      ),
      title: json['title'] as String? ?? '',
      body: json['body'] as String? ?? '',
      data: (json['data'] as Map<String, dynamic>? ?? const {}),
      createdAt: _toDate(json['createdAt']),
      readAt: json['readAt'] == null ? null : _toDate(json['readAt']),
      sent: json['sent'] as bool? ?? false,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'notificationId': notificationId,
      'userId': userId,
      'type': type.name,
      'title': title,
      'body': body,
      'data': data,
      'createdAt': Timestamp.fromDate(createdAt),
      'readAt': readAt != null ? Timestamp.fromDate(readAt!) : null,
      'sent': sent,
    };
  }

  NotificationModel copyWith({
    String? notificationId,
    String? userId,
    NotificationType? type,
    String? title,
    String? body,
    Map<String, dynamic>? data,
    DateTime? createdAt,
    DateTime? readAt,
    bool? sent,
  }) {
    return NotificationModel(
      notificationId: notificationId ?? this.notificationId,
      userId: userId ?? this.userId,
      type: type ?? this.type,
      title: title ?? this.title,
      body: body ?? this.body,
      data: data ?? this.data,
      createdAt: createdAt ?? this.createdAt,
      readAt: readAt ?? this.readAt,
      sent: sent ?? this.sent,
    );
  }

  bool get isRead => readAt != null;

  /// The screen this notification leads to.
  ///
  /// The route depends on the **role** of the user: the same notification
  /// means something different for the student and for the room owner, and
  /// a route the user may not open looks exactly like "nothing happened"
  /// when the notification is tapped.
  ///
  /// See [notificationRouteFor] for the rules.
  String routeFor(UserRole? role) =>
      notificationRouteFor(type: type.name, data: data, role: role);

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is NotificationModel &&
            runtimeType == other.runtimeType &&
            notificationId == other.notificationId &&
            userId == other.userId &&
            type == other.type &&
            title == other.title &&
            body == other.body &&
            mapEquals(data, other.data) &&
            createdAt == other.createdAt &&
            readAt == other.readAt &&
            sent == other.sent;
  }

  @override
  int get hashCode => Object.hash(
    notificationId,
    userId,
    type,
    title,
    body,
    Object.hashAll(data.entries.map((e) => Object.hash(e.key, e.value))),
    createdAt,
    readAt,
    sent,
  );

  @override
  String toString() {
    return 'NotificationModel(notificationId: $notificationId, userId: $userId, '
        'type: $type, title: $title, body: $body, data: $data, '
        'createdAt: $createdAt, readAt: $readAt, sent: $sent)';
  }
}

class AdminSettingsModel {
  final int commissionPercentage;
  final double platformFeePercentage;
  final bool maintenanceMode;
  final DateTime updatedAt;
  final String updatedBy;

  const AdminSettingsModel({
    this.commissionPercentage = 30,
    this.platformFeePercentage = 0,
    this.maintenanceMode = false,
    required this.updatedAt,
    required this.updatedBy,
  });

  factory AdminSettingsModel.fromJson(Map<String, dynamic> json) {
    return AdminSettingsModel(
      commissionPercentage:
          (json['commissionPercentage'] as num?)?.toInt() ?? 30,
      platformFeePercentage:
          (json['platformFeePercentage'] as num?)?.toDouble() ?? 0,
      maintenanceMode: json['maintenanceMode'] as bool? ?? false,
      updatedAt: _toDate(json['updatedAt']),
      updatedBy: json['updatedBy'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'commissionPercentage': commissionPercentage,
      'platformFeePercentage': platformFeePercentage,
      'maintenanceMode': maintenanceMode,
      'updatedAt': Timestamp.fromDate(updatedAt),
      'updatedBy': updatedBy,
    };
  }

  AdminSettingsModel copyWith({
    int? commissionPercentage,
    double? platformFeePercentage,
    bool? maintenanceMode,
    DateTime? updatedAt,
    String? updatedBy,
  }) {
    return AdminSettingsModel(
      commissionPercentage: commissionPercentage ?? this.commissionPercentage,
      platformFeePercentage:
          platformFeePercentage ?? this.platformFeePercentage,
      maintenanceMode: maintenanceMode ?? this.maintenanceMode,
      updatedAt: updatedAt ?? this.updatedAt,
      updatedBy: updatedBy ?? this.updatedBy,
    );
  }

  static const int maxCommissionPercentage = 30;
  static const int minCommissionPercentage = 0;

  bool get isValidCommission =>
      commissionPercentage >= minCommissionPercentage &&
      commissionPercentage <= maxCommissionPercentage;

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is AdminSettingsModel &&
            runtimeType == other.runtimeType &&
            commissionPercentage == other.commissionPercentage &&
            platformFeePercentage == other.platformFeePercentage &&
            maintenanceMode == other.maintenanceMode &&
            updatedAt == other.updatedAt &&
            updatedBy == other.updatedBy;
  }

  @override
  int get hashCode => Object.hash(
    commissionPercentage,
    platformFeePercentage,
    maintenanceMode,
    updatedAt,
    updatedBy,
  );

  @override
  String toString() {
    return 'AdminSettingsModel(commissionPercentage: $commissionPercentage, '
        'platformFeePercentage: $platformFeePercentage, '
        'maintenanceMode: $maintenanceMode, updatedAt: $updatedAt, '
        'updatedBy: $updatedBy)';
  }
}

/// Reads a Firestore timestamp (or ISO string) into a [DateTime].
DateTime _toDate(dynamic value) {
  if (value is Timestamp) return value.toDate();
  if (value is DateTime) return value;
  if (value is String) {
    final parsed = DateTime.tryParse(value);
    if (parsed != null) return parsed;
  }
  return DateTime.fromMillisecondsSinceEpoch(0);
}

/// The screen a notification leads to.
///
/// ## Why the route depends on the role
///
/// A notification has to open the screen the event came **from** — and
/// that screen is not the same for everybody:
///
///  * a **join request** has to be answered by the room owner (their
///    request list) and is only *waited for* by the student (their request
///    list),
///  * an **accepted request** asks the student to confirm it and later to
///    submit the platform fee (their request list), while the owner sees the
///    request and its payment state in their own request list,
///  * an **invoice** belongs to the owner; a student has no invoice tab, so
///    the payment belongs to the booking and the request list is the right
///    place.
///
/// Before this the route was hard-wired to one role. A student who tapped
/// an invoice notification was sent to `/owner/invoices`, the router
/// bounced them back to their home — and the tap looked like it did
/// nothing at all.
///
/// The function is used by the notification list **and** by the push
/// handler, so a notification opens the same screen no matter how it was
/// opened.
String notificationRouteFor({
  required String type,
  required Map<String, dynamic> data,
  required UserRole? role,
}) {
  final conversationId = data['conversationId'];
  final invoiceId = data['invoiceId'];

  switch (type) {
    case 'newMessage':
      return conversationId != null
          ? '/chat/$conversationId'
          : '/conversations';

    case 'joinRequest':
    case 'joinConfirmed':
      switch (role) {
        case UserRole.owner:
          return '/owner/requests';
        case UserRole.admin:
          return '/admin/requests';
        case UserRole.student:
        case null:
          return '/student/requests';
      }

    case 'invoiceCreated':
    case 'invoicePaid':
      if (invoiceId != null) return '/invoice/$invoiceId';
      switch (role) {
        case UserRole.owner:
          return '/owner/invoices';
        case UserRole.admin:
          return '/admin/invoices';
        case UserRole.student:
        case null:
          // The student has no invoice tab — the payment belongs to the
          // booking, so the request list is the right place.
          return '/student/requests';
      }

    case 'adminReview':
      if (role == UserRole.admin) return '/admin/requests';
      // The booking was reviewed by the admin — the student and the owner
      // see it in their request list.
      return role == UserRole.owner ? '/owner/requests' : '/student/requests';

    case 'account':
      // The account itself changed — the profile of the user is the place
      // that shows it.
      switch (role) {
        case UserRole.owner:
          return '/owner/profile';
        case UserRole.admin:
          return '/admin/dashboard';
        case UserRole.student:
        case null:
          return '/student/profile';
      }

    case 'review':
      // A student reviewed one of the rooms of the owner — the reviews of
      // the room are where the owner reads it.
      final reviewRoomId = data['roomId'];
      if (reviewRoomId != null) return '/room/$reviewRoomId/reviews';
      switch (role) {
        case UserRole.owner:
          return '/owner/rooms';
        case UserRole.admin:
          return '/admin/rooms';
        case UserRole.student:
        case null:
          return '/student/home';
      }

    case 'general':
    default:
      // Nothing to open — the home screen of the role is the best guess.
      switch (role) {
        case UserRole.owner:
          return '/owner/dashboard';
        case UserRole.admin:
          return '/admin/dashboard';
        case UserRole.student:
        case null:
          return '/student/home';
      }
  }
}
