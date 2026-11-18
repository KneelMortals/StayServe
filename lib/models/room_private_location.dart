import 'package:cloud_firestore/cloud_firestore.dart';

/// The exact location of a room.
///
/// This value is stored in the server-owned `roomPrivate` collection. It is
/// never serialized into the public `rooms` document in the final privacy
/// mode.
class RoomPrivateLocation {
  final String roomId;
  final String ownerId;
  final String address;
  final String city;
  final String state;
  final String pincode;
  final double? latitude;
  final double? longitude;
  final DateTime? updatedAt;

  const RoomPrivateLocation({
    required this.roomId,
    required this.ownerId,
    required this.address,
    required this.city,
    required this.state,
    required this.pincode,
    this.latitude,
    this.longitude,
    this.updatedAt,
  });

  factory RoomPrivateLocation.fromJson(Map<String, dynamic> json) {
    return RoomPrivateLocation(
      roomId: (json['roomId'] as String? ?? '').trim(),
      ownerId: (json['ownerId'] as String? ?? '').trim(),
      address: (json['address'] as String? ?? '').trim(),
      city: (json['city'] as String? ?? '').trim(),
      state: (json['state'] as String? ?? '').trim(),
      pincode: (json['pincode'] as String? ?? '').trim(),
      latitude: (json['latitude'] as num?)?.toDouble(),
      longitude: (json['longitude'] as num?)?.toDouble(),
      updatedAt: _dateFromJson(json['updatedAt']),
    );
  }

  /// Reads the exact location from a legacy public room document.
  ///
  /// This is used only in the owner-facing view while the staged migration is
  /// still running. The public [RoomModel] never exposes these values to a
  /// student, and the owner writes them back through the server-owned
  /// private-location callable.
  factory RoomPrivateLocation.fromLegacyRoomJson(
    Map<String, dynamic> json, {
    required String roomId,
    required String ownerId,
  }) {
    final nested =
        (json['location'] as Map<dynamic, dynamic>?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};

    double? coordinate(dynamic nestedValue, dynamic flatValue) {
      final value = nestedValue is num
          ? nestedValue.toDouble()
          : flatValue is num
          ? flatValue.toDouble()
          : null;
      if (value == null || !value.isFinite) return null;
      return value;
    }

    return RoomPrivateLocation(
      roomId: roomId,
      ownerId: ownerId,
      address:
          (nested['address'] as String? ?? json['address'] as String? ?? '')
              .trim(),
      city: (nested['city'] as String? ?? json['city'] as String? ?? '').trim(),
      state: (nested['state'] as String? ?? json['state'] as String? ?? '')
          .trim(),
      pincode:
          (nested['pincode'] as String? ?? json['pincode'] as String? ?? '')
              .trim(),
      latitude: coordinate(nested['latitude'], json['latitude']),
      longitude: coordinate(nested['longitude'], json['longitude']),
      updatedAt: _dateFromJson(json['locationUpdatedAt']),
    );
  }

  /// The payload accepted by the owner-only location callable.
  Map<String, dynamic> toCallablePayload() {
    return {
      'address': address,
      'city': city,
      'state': state,
      'pincode': pincode,
      'latitude': latitude,
      'longitude': longitude,
    };
  }

  static DateTime? _dateFromJson(dynamic value) {
    if (value is Timestamp) return value.toDate();
    if (value is DateTime) return value;
    if (value is num) {
      return DateTime.fromMillisecondsSinceEpoch(value.toInt());
    }
    return null;
  }
}
