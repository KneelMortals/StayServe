import 'package:cloud_firestore/cloud_firestore.dart';
import '../../core/constants/enums.dart';
import '../../core/utils/distance.dart';

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

  factory RoomModel.fromJson(Map<String, dynamic> json) {
    final location = Location.fromJson(
      (json['location'] as Map<dynamic, dynamic>?)?.cast<String, dynamic>() ??
          const <String, dynamic>{},
    );

    return RoomModel(
      roomId: json['roomId'] as String? ?? '',
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
      amenities:
          (json['amenities'] as List<dynamic>?)?.whereType<String>().toList() ??
          const [],
      occupancy: (json['occupancy'] as num?)?.toInt() ?? 1,
      currentOccupancy: (json['currentOccupancy'] as num?)?.toInt() ?? 0,
      genderPreference: GenderPreference.values.firstWhere(
        (e) => e.name == json['genderPreference'],
        orElse: () => GenderPreference.any,
      ),
      images:
          (json['images'] as List<dynamic>?)?.whereType<String>().toList() ??
          const [],
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
      // The coordinates live in the `location` sub-map; the flat fields are
      // kept for backwards compatibility with the older documents.
      latitude: (json['latitude'] as num?)?.toDouble() ?? location.latitude,
      longitude: (json['longitude'] as num?)?.toDouble() ?? location.longitude,
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
      'homeId': homeId,
      'homeName': homeName,
    };
  }

  /// The payload used when an owner publishes a **new** listing.
  ///
  /// `status` and `currentOccupancy` are the **initial** values of a fresh
  /// listing — `available` and `0`. Both fields are server-owned from the
  /// moment the listing exists: `setRoomListingAvailability` /
  /// `adminSetRoomListingStatus` change the status and the booking state
  /// machine changes the occupancy counter.
  ///
  /// The Firestore rules only accept exactly these two values on the
  /// create, so a client can neither publish a listing as occupied nor
  /// pretend that it already has tenants. The fields must not be left out
  /// either: a Firestore equality query (`status == available`) never
  /// matches a document that does not have the field, so a listing without
  /// a status would be invisible in the student search.
  Map<String, dynamic> toCreateJson() {
    return toJson();
  }

  /// The owner-editable fields of an existing listing.
  ///
  /// This is used with an update (not a full `set`) so a stale edit can
  /// never overwrite a server-owned value that changed in the meantime —
  /// for example the occupancy counter after a booking was verified.
  Map<String, dynamic> toOwnerUpdateJson() {
    return {
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
      'genderPreference': genderPreference.name,
      'images': images,
      'updatedAt': Timestamp.fromDate(updatedAt),
      'latitude': latitude,
      'longitude': longitude,
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
    if (location.address.isNotEmpty) return location.address;
    if (location.city.isNotEmpty) return location.city;
    return 'Other listings';
  }

  /// The distance between this room and the given position, in kilometres.
  ///
  /// Returns `null` when the room has no coordinates.
  double? distanceFrom({double? latitude, double? longitude}) {
    return DistanceUtils.haversineKm(
      fromLat: latitude,
      fromLng: longitude,
      toLat: this.latitude ?? location.latitude,
      toLng: this.longitude ?? location.longitude,
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

class Location {
  final String address;
  final String city;
  final String state;
  final String pincode;
  final double? latitude;
  final double? longitude;

  const Location({
    required this.address,
    required this.city,
    required this.state,
    required this.pincode,
    this.latitude,
    this.longitude,
  });

  factory Location.fromJson(Map<String, dynamic> json) {
    return Location(
      address: json['address'] as String? ?? '',
      city: json['city'] as String? ?? '',
      state: json['state'] as String? ?? '',
      pincode: json['pincode'] as String? ?? '',
      latitude: (json['latitude'] as num?)?.toDouble(),
      longitude: (json['longitude'] as num?)?.toDouble(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'address': address,
      'city': city,
      'state': state,
      'pincode': pincode,
      'latitude': latitude,
      'longitude': longitude,
    };
  }

  /// The address as one line.
  ///
  /// The parts that are empty are left out — otherwise a room without a
  /// street address would show ", Bengaluru, Karnataka - 560001".
  String get fullAddress => [
    address,
    city,
    state,
    pincode,
  ].map((part) => part.trim()).where((part) => part.isNotEmpty).join(', ');

  /// The rough area of the room — what everybody may see.
  String get shortAddress {
    final parts = [
      city,
      state,
    ].map((part) => part.trim()).where((part) => part.isNotEmpty).join(', ');
    return parts.isEmpty ? address.trim() : parts;
  }
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
      date != null ? Timestamp.fromDate(date) : null;
}
