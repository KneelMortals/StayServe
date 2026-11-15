import 'package:cloud_firestore/cloud_firestore.dart';
import '../../core/constants/enums.dart';

class UserModel {
  final String uid;
  final String name;
  final String email;
  final String? phone;
  final UserRole role;
  final String? profileImage;
  final String? fcmToken;
  final bool isActive;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<String> savedRooms;
  final BankDetails? bankDetails;
  final String? banReason;
  final DateTime? bannedAt;
  final String? pincode;

  /// Whether the deletion of this account has been scheduled.
  ///
  /// The account is not deleted right away: the admin gets **seven days**
  /// before the account is really removed, and the deletion can still be
  /// cancelled in the meantime.
  final bool deletionScheduled;

  /// When the account was scheduled for deletion.
  final DateTime? deletionScheduledAt;

  /// When the account is really deleted — seven days after the scheduling.
  final DateTime? deleteAfter;

  UserModel({
    required this.uid,
    required this.name,
    required this.email,
    this.phone,
    required this.role,
    this.profileImage,
    this.fcmToken,
    this.isActive = true,
    required this.createdAt,
    required this.updatedAt,
    this.savedRooms = const [],
    this.bankDetails,
    this.banReason,
    this.bannedAt,
    this.pincode,
    this.deletionScheduled = false,
    this.deletionScheduledAt,
    this.deleteAfter,
  });

  factory UserModel.fromJson(Map<String, dynamic> json) {
    return UserModel(
      // Every field is read defensively. A profile document that is missing
      // a field — or that holds it with the wrong type — used to throw a
      // `TypeError` right here, which killed the session stream and sent the
      // user back to the login screen with an "auth" error even though
      // Firebase Authentication had worked perfectly.
      uid: _asString(json['uid']),
      name: _asString(json['name']),
      email: _asString(json['email']),
      phone: _asNullableString(json['phone']),
      role: UserRole.values.firstWhere(
        (e) => e.name == json['role'],
        orElse: () => UserRole.student,
      ),
      profileImage: _asNullableString(json['profileImage']),
      fcmToken: _asNullableString(json['fcmToken']),
      isActive: json['isActive'] is bool ? json['isActive'] as bool : true,
      createdAt: _toDate(json['createdAt']),
      updatedAt: _toDate(json['updatedAt']),
      savedRooms: _asStringList(json['savedRooms']),
      bankDetails: _asBankDetails(json['bankDetails']),
      banReason: _asNullableString(json['banReason']),
      bannedAt: json['bannedAt'] != null ? _toDate(json['bannedAt']) : null,
      pincode: _asNullableString(json['pincode']),
      deletionScheduled: json['deletionScheduled'] is bool
          ? json['deletionScheduled'] as bool
          : false,
      deletionScheduledAt: json['deletionScheduledAt'] != null
          ? _toDate(json['deletionScheduledAt'])
          : null,
      deleteAfter:
          json['deleteAfter'] != null ? _toDate(json['deleteAfter']) : null,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'uid': uid,
      'name': name,
      'email': email,
      'phone': phone,
      'role': role.name,
      'profileImage': profileImage,
      'fcmToken': fcmToken,
      'isActive': isActive,
      'createdAt': Timestamp.fromDate(createdAt),
      'updatedAt': Timestamp.fromDate(updatedAt),
      'savedRooms': savedRooms,
      'bankDetails': bankDetails?.toJson(),
      'banReason': banReason,
      'bannedAt': bannedAt != null ? Timestamp.fromDate(bannedAt!) : null,
      'pincode': pincode,
      'deletionScheduled': deletionScheduled,
      'deletionScheduledAt': deletionScheduledAt != null
          ? Timestamp.fromDate(deletionScheduledAt!)
          : null,
      'deleteAfter':
          deleteAfter != null ? Timestamp.fromDate(deleteAfter!) : null,
    };
  }

  UserModel copyWith({
    String? uid,
    String? name,
    String? email,
    String? phone,
    UserRole? role,
    String? profileImage,
    String? fcmToken,
    bool? isActive,
    DateTime? createdAt,
    DateTime? updatedAt,
    List<String>? savedRooms,
    BankDetails? bankDetails,
    String? banReason,
    DateTime? bannedAt,
    String? pincode,
    bool? deletionScheduled,
    DateTime? deletionScheduledAt,
    DateTime? deleteAfter,
  }) {
    return UserModel(
      uid: uid ?? this.uid,
      name: name ?? this.name,
      email: email ?? this.email,
      phone: phone ?? this.phone,
      role: role ?? this.role,
      profileImage: profileImage ?? this.profileImage,
      fcmToken: fcmToken ?? this.fcmToken,
      isActive: isActive ?? this.isActive,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      savedRooms: savedRooms ?? this.savedRooms,
      bankDetails: bankDetails ?? this.bankDetails,
      banReason: banReason ?? this.banReason,
      bannedAt: bannedAt ?? this.bannedAt,
      pincode: pincode ?? this.pincode,
      deletionScheduled: deletionScheduled ?? this.deletionScheduled,
      deletionScheduledAt: deletionScheduledAt ?? this.deletionScheduledAt,
      deleteAfter: deleteAfter ?? this.deleteAfter,
    );
  }

  String get displayName => name;

  /// The initials shown in the avatar.
  ///
  /// The old implementation did `name.trim().split(' ').map((e) => e[0])`,
  /// which threw a `RangeError` for an empty name (a user whose profile has
  /// no name yet) or for a name made only of spaces.
  String get initials {
    final parts =
        name.trim().split(RegExp(r'\s+')).where((part) => part.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
    return '${parts[0].substring(0, 1)}${parts[1].substring(0, 1)}'
        .toUpperCase();
  }

  bool get isStudent => role == UserRole.student;
  bool get isOwner => role == UserRole.owner;
  bool get isAdmin => role == UserRole.admin;

  UserModel copyWithUpdatedAt() => copyWith(updatedAt: DateTime.now());
}

class BankDetails {
  final String upiId;
  final String accountHolderName;
  final String? bankName;
  final String? accountNumber;
  final String? ifscCode;

  BankDetails({
    required this.upiId,
    required this.accountHolderName,
    this.bankName,
    this.accountNumber,
    this.ifscCode,
  });

  factory BankDetails.fromJson(Map<String, dynamic> json) {
    return BankDetails(
      upiId: _asString(json['upiId']),
      accountHolderName: _asString(json['accountHolderName']),
      bankName: _asNullableString(json['bankName']),
      accountNumber: _asNullableString(json['accountNumber']),
      ifscCode: _asNullableString(json['ifscCode']),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'upiId': upiId,
      'accountHolderName': accountHolderName,
      'bankName': bankName,
      'accountNumber': accountNumber,
      'ifscCode': ifscCode,
    };
  }

  BankDetails copyWith({
    String? upiId,
    String? accountHolderName,
    String? bankName,
    String? accountNumber,
    String? ifscCode,
  }) {
    return BankDetails(
      upiId: upiId ?? this.upiId,
      accountHolderName: accountHolderName ?? this.accountHolderName,
      bankName: bankName ?? this.bankName,
      accountNumber: accountNumber ?? this.accountNumber,
      ifscCode: ifscCode ?? this.ifscCode,
    );
  }
}

class TimestampConverter {
  const TimestampConverter();
  DateTime fromJson(Timestamp timestamp) => timestamp.toDate();
  Timestamp toJson(DateTime date) => Timestamp.fromDate(date);
}

class TimestampConverterNullable {
  const TimestampConverterNullable();
  DateTime? fromJson(Timestamp? timestamp) => timestamp?.toDate();
  Timestamp? toJson(DateTime? date) => date != null ? Timestamp.fromDate(date) : null;
}

/// Reads a Firestore timestamp (or ISO string) into a [DateTime].
///
/// Firestore documents may be missing these fields or may hold them as a
/// plain [String] depending on which client wrote the document, so parsing
/// must never throw.
DateTime _toDate(dynamic value) {
  if (value is Timestamp) return value.toDate();
  if (value is DateTime) return value;
  if (value is String) {
    final parsed = DateTime.tryParse(value);
    if (parsed != null) return parsed;
  }
  return DateTime.fromMillisecondsSinceEpoch(0);
}

/// Reads a string field without ever throwing.
///
/// Firestore does not enforce a schema: a document written by an older
/// version of the app (or by the console) may be missing the field or may
/// hold a number where a string was expected. A hard `as String` cast turns
/// such a document into a `TypeError` that tears down the whole session.
String _asString(dynamic value) {
  if (value is String) return value;
  if (value is num || value is bool) return value.toString();
  return '';
}

/// Reads an optional string field without ever throwing.
String? _asNullableString(dynamic value) {
  if (value == null) return null;
  if (value is String) return value;
  if (value is num || value is bool) return value.toString();
  return null;
}

/// Reads a list of strings without ever throwing.
///
/// The saved-room ids may be stored as a list of strings, but a document
/// that was edited by hand can hold anything at all.
List<String> _asStringList(dynamic value) {
  if (value is! List) return const <String>[];
  return value.whereType<String>().toList();
}

/// Reads the bank details without ever throwing.
///
/// A half-written bank block must not stop the profile from loading.
BankDetails? _asBankDetails(dynamic value) {
  if (value is! Map) return null;
  try {
    final map = value.map((k, v) => MapEntry(k.toString(), v));
    if (_asString(map['upiId']).isNotEmpty &&
        _asString(map['accountHolderName']).isNotEmpty) {
      return BankDetails.fromJson(map);
    }
  } catch (_) {
    return null;
  }
  return null;
}