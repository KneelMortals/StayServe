import 'package:cloud_firestore/cloud_firestore.dart';

import '../../core/constants/enums.dart';
import '../../core/constants/room_location_privacy.dart';
import '../../core/utils/distance.dart';

/// Reads a list of strings without letting one malformed field hide the
/// whole room from the student.
List<String> _stringList(dynamic value) {
  if (value is! List) return const <String>[];
  final result = <String>[];
  for (final item in value) {
    if (item is! String) continue;
    final trimmed = item.trim();
    if (trimmed.isEmpty || result.contains(trimmed)) continue;
    result.add(trimmed);
  }
  return result;
}

/// The location which is safe to publish in a public room document.
///
/// The exact street address, pincode and coordinates are deliberately not
/// part of this type. They live in the separate `RoomPrivateLocation` model
/// and are released only to the owner or to an accepted student through a
/// server-checked path.
class Location {
  final String city;
  final String state;

  const Location({required this.city, required this.state});

  factory Location.fromJson(Map<String, dynamic> json) {
    return Location(
      city: json['city'] as String? ?? '',
      state: json['state'] as String? ?? '',
    );
  }

  Map<String, dynamic> toJson() {
    return {'city': city, 'state': state};
  }

  /// The rough area of the room — what everybody may see.
  String get shortAddress {
    final parts = [
      city,
      state,
    ].map((part) => part.trim()).where((part) => part.isNotEmpty).join(', ');
    return parts.isEmpty ? 'Location not published' : parts;
  }
}

class RoomModel {
  final String roomId;
  final String ownerId;
  final String title;
  final String description;
  final double monthlyRent;
  final double securityDeposit;
  final Location location;
  final RoomType roomType;
  final FurnishingType furnishing;
  final DateTime availableFrom;
  final List<String> amenities;
  final int occupancy;
  final int currentOccupancy;
  final GenderPreference genderPreference;
  final List<String> images;
  final RoomStatus status;
  final DateTime createdAt;
  final DateTime updatedAt;

  /// The deliberately coarse public coordinate used for distance hints.
  ///
  /// It is parsed from `geoCell` whenever that field exists. The exact
  /// coordinate is not represented by this public model.
  final double? latitude;
  final double? longitude;

  /// The home (building / property) this room belongs to.
  ///
  /// An owner often rents out more than one room in the same house. Grouping
  /// the listings by `homeId` lets the app show them together and lets the
  /// owner publish another room for an existing home without typing the
  /// address again.
  final String? homeId;

  /// The name of the home (e.g. "Sunrise Apartments" or "Flat 3B").
  final String? homeName;

  RoomModel({
    required this.roomId,
    required this.ownerId,
    required this.title,
    required this.description,
    required this.monthlyRent,
    required this.securityDeposit,
    required this.location,
    required this.roomType,
    required this.furnishing,
    required this.availableFrom,
    this.amenities = const [],
    required this.occupancy,
    this.currentOccupancy = 0,
    required this.genderPreference,
    this.images = const [],
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.latitude,
    this.longitude,
    this.homeId,
    this.homeName,
  });

  factory RoomModel.fromJson(
    Map<String, dynamic> json, {
    required String documentId,
  }) {
    final canonicalDocumentId = documentId.trim();
    if (canonicalDocumentId.isEmpty) {
      throw ArgumentError.value(documentId, 'documentId', 'Must not be empty');
    }
    final rawLocation =
        (json['location'] as Map<dynamic, dynamic>?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    final location = Location.fromJson(rawLocation);
    final geoCell = RoomLocationPrivacy.parseGeoCell(
      json['geoCell'] as String?,
    );

    // Transitional fallback for a listing which has not been migrated yet.
    // As soon as the server writes `geoCell`, the rounded public coordinate
    // wins over the legacy exact flat fields.
    final legacyLatitude =
        (json['latitude'] as num?)?.toDouble() ??
        (rawLocation['latitude'] as num?)?.toDouble();
    final legacyLongitude =
        (json['longitude'] as num?)?.toDouble() ??
        (rawLocation['longitude'] as num?)?.toDouble();

    return RoomModel(
      roomId: canonicalDocumentId,
      ownerId: json['ownerId'] as String? ?? '',
      title: json['title'] as String? ?? '',
      description: json['description'] as String? ?? '',
      monthlyRent: (json['monthlyRent'] as num?)?.toDouble() ?? 0,
      securityDeposit: (json['securityDeposit'] as num?)?.toDouble() ?? 0,
      location: location,
      roomType: RoomType.values.firstWhere(
        (e) => e.name == json['roomType'],
        orElse: () => RoomType.single,
      ),
      furnishing: FurnishingType.values.firstWhere(
        (e) => e.name == json['furnishing'],
        orElse: () => FurnishingType.unfurnished,
      ),
      availableFrom: _toDate(json['availableFrom']),
      amenities: _stringList(json['amenities']),
      occupancy: (json['occupancy'] as num?)?.toInt() ?? 1,
      currentOccupancy: (json['currentOccupancy'] as num?)?.toInt() ?? 0,
      genderPreference: GenderPreference.values.firstWhere(
        (e) => e.name == json['genderPreference'],
        orElse: () => GenderPreference.any,
      ),
      images: _stringList(json['images']),
      // An **unknown** status is not treated as "available" any more — a
      // room whose state the app does not understand must not be offered to
      // students. A *missing* status still falls back to `available`, which
      // is what the very first listings look like.
      status: json['status'] == null
          ? RoomStatus.available
          : RoomStatus.values.firstWhere(
              (e) => e.name == json['status'],
              orElse: () => RoomStatus.inactive,
            ),
      createdAt: _toDate(json['createdAt']),
      updatedAt: _toDate(json['updatedAt']),
      latitude:
          geoCell?.latitude ??
          RoomLocationPrivacy.coarseCoordinate(legacyLatitude),
      longitude:
          geoCell?.longitude ??
          RoomLocationPrivacy.coarseCoordinate(
            legacyLongitude,
            minimum: -180,
            maximum: 180,
          ),
      homeId: (json['homeId'] as String?)?.trim().isEmpty ?? true
          ? null
          : (json['homeId'] as String).trim(),
      homeName: (json['homeName'] as String?)?.trim().isEmpty ?? true
          ? null
          : (json['homeName'] as String).trim(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'roomId': roomId,
      'ownerId': ownerId,
      'title': title,
      'description': description,
      'monthlyRent': monthlyRent,
      'securityDeposit': securityDeposit,
      'location': location.toJson(),
      'roomType': roomType.name,
      'furnishing': furnishing.name,
      'availableFrom': Timestamp.fromDate(availableFrom),
      'amenities': amenities,
      'occupancy': occupancy,
      'currentOccupancy': currentOccupancy,
      'genderPreference': genderPreference.name,
      'images': images,
      'status': status.name,
      'createdAt': Timestamp.fromDate(createdAt),
      'updatedAt': Timestamp.fromDate(updatedAt),
      'latitude': latitude,
      'longitude': longitude,
      'geoCell': RoomLocationPrivacy.geoCell(
        latitude: latitude,
        longitude: longitude,
      ),
      'homeId': homeId,
      'homeName': homeName,
    };
  }

  /// The payload used when an owner publishes a **new** listing.
  ///
  /// The exact location is not part of this payload. The owner repository
  /// writes it through `setRoomPrivateLocation`, which stores the private
  /// copy and the public compatibility fields in one server transaction.
  ///
  /// `status` and `currentOccupancy` are the **initial** values of a fresh
  /// listing — `available` and `0`. Both fields are server-owned from the
  /// moment the listing exists: `setRoomListingAvailability` /
  /// `adminSetRoomListingStatus` change the status, an explicit availability
  /// release also clears the occupancy, and the booking state machine changes
  /// the counter during activation and rollback.
  Map<String, dynamic> toCreateJson() {
    final payload = toJson();
    // The server writes the rounded geocell after the private location has
    // been accepted. A client must not be able to forge that field.
    payload.remove('latitude');
    payload.remove('longitude');
    payload.remove('geoCell');
    return payload;
  }

  /// The owner-editable fields of an existing listing.
  ///
  /// This is used with an update (not a full `set`) so a stale edit can
  /// never overwrite a server-owned value that changed in the meantime —
  /// for example the occupancy counter after a booking was verified.
  ///
  /// Location fields are also server-owned: the owner calls
  /// `setRoomPrivateLocation` before this update is committed.
  Map<String, dynamic> toOwnerUpdateJson() {
    return {
      'title': title,
      'description': description,
      'monthlyRent': monthlyRent,
      'securityDeposit': securityDeposit,
      'roomType': roomType.name,
      'furnishing': furnishing.name,
      'availableFrom': Timestamp.fromDate(availableFrom),
      'amenities': amenities,
      'occupancy': occupancy,
      'genderPreference': genderPreference.name,
      'images': images,
      'updatedAt': Timestamp.fromDate(updatedAt),
      'homeId': homeId,
      'homeName': homeName,
    };
  }

  String get primaryImage => images.isNotEmpty ? images.first : '';
  bool get hasImages => images.isNotEmpty;
  bool get isAvailable =>
      status == RoomStatus.available && currentOccupancy < occupancy;
  int get availableSlots => occupancy - currentOccupancy;

  /// Whether the owner has marked this room as occupied.
  bool get isOccupied => status == RoomStatus.occupied;

  /// The id of the home this room belongs to.
  ///
  /// Rooms that were published before the "homes" feature existed do not
  /// have one — they are grouped under [legacyHomeId] so they still show up
  /// in the owner's list.
  String get resolvedHomeId =>
      homeId?.isNotEmpty == true ? homeId! : legacyHomeId;

  /// The group id used for the listings that have no home yet.
  static const String legacyHomeId = '__other__';

  /// The display name of the home.
  String get resolvedHomeName {
    if (homeName != null && homeName!.isNotEmpty) return homeName!;
    if (location.city.isNotEmpty) return location.city;
    return 'Other listings';
  }

  /// The distance between this room and the given position, in kilometres.
  ///
  /// Returns `null` when the room has no public coordinate.
  double? distanceFrom({double? latitude, double? longitude}) {
    return DistanceUtils.haversineKm(
      fromLat: latitude,
      fromLng: longitude,
      toLat: this.latitude,
      toLng: this.longitude,
    );
  }

  RoomModel copyWith({
    String? roomId,
    String? ownerId,
    String? title,
    String? description,
    double? monthlyRent,
    double? securityDeposit,
    Location? location,
    RoomType? roomType,
    FurnishingType? furnishing,
    DateTime? availableFrom,
    List<String>? amenities,
    int? occupancy,
    int? currentOccupancy,
    GenderPreference? genderPreference,
    List<String>? images,
    RoomStatus? status,
    DateTime? createdAt,
    DateTime? updatedAt,
    double? latitude,
    double? longitude,
    String? homeId,
    String? homeName,
  }) {
    return RoomModel(
      roomId: roomId ?? this.roomId,
      ownerId: ownerId ?? this.ownerId,
      title: title ?? this.title,
      description: description ?? this.description,
      monthlyRent: monthlyRent ?? this.monthlyRent,
      securityDeposit: securityDeposit ?? this.securityDeposit,
      location: location ?? this.location,
      roomType: roomType ?? this.roomType,
      furnishing: furnishing ?? this.furnishing,
      availableFrom: availableFrom ?? this.availableFrom,
      amenities: amenities ?? this.amenities,
      occupancy: occupancy ?? this.occupancy,
      currentOccupancy: currentOccupancy ?? this.currentOccupancy,
      genderPreference: genderPreference ?? this.genderPreference,
      images: images ?? this.images,
      status: status ?? this.status,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      latitude: latitude ?? this.latitude,
      longitude: longitude ?? this.longitude,
      homeId: homeId ?? this.homeId,
      homeName: homeName ?? this.homeName,
    );
  }

  RoomModel copyWithUpdatedAt() => copyWith(updatedAt: DateTime.now());
}

class TimestampConverter {
  const TimestampConverter();
  DateTime fromJson(Timestamp timestamp) => timestamp.toDate();
  Timestamp toJson(DateTime date) => Timestamp.fromDate(date);
}

/// Reads a Firestore timestamp (or ISO string) into a [DateTime] without
/// throwing when the field is missing or stored in a different format.
DateTime _toDate(dynamic value) {
  if (value is Timestamp) return value.toDate();
  if (value is DateTime) return value;
  if (value is String) {
    final parsed = DateTime.tryParse(value);
    if (parsed != null) return parsed;
  }
  return DateTime.fromMillisecondsSinceEpoch(0);
}

class TimestampConverterNullable {
  const TimestampConverterNullable();
  DateTime? fromJson(Timestamp? timestamp) => timestamp?.toDate();
  Timestamp? toJson(DateTime? date) =>
      date == null ? null : Timestamp.fromDate(date);
}
