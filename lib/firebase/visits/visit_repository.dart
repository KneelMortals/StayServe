import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../functions/functions_service.dart';

final visitRepositoryProvider = Provider<VisitRepository>((ref) {
  return VisitRepository(functions: ref.watch(functionsServiceProvider));
});

/// Where a room is — the address the student has to go to.
class RoomVisitDetails {
  final String roomId;
  final String title;
  final String address;
  final String city;
  final String state;
  final String pincode;
  final double? latitude;
  final double? longitude;
  final String ownerId;
  final String ownerName;

  /// The address as one line.
  final String fullAddress;

  const RoomVisitDetails({
    required this.roomId,
    required this.title,
    required this.address,
    required this.city,
    required this.state,
    required this.pincode,
    required this.latitude,
    required this.longitude,
    required this.ownerId,
    required this.ownerName,
    required this.fullAddress,
  });

  factory RoomVisitDetails.fromData(Map<String, dynamic> data) {
    double? coordinate(String key) {
      final value = data[key];
      if (value is num && value.isFinite) return value.toDouble();
      return null;
    }

    final address = data['address'] as String? ?? '';
    final city = data['city'] as String? ?? '';
    final state = data['state'] as String? ?? '';
    final pincode = data['pincode'] as String? ?? '';

    return RoomVisitDetails(
      roomId: data['roomId'] as String? ?? '',
      title: data['title'] as String? ?? 'The room',
      address: address,
      city: city,
      state: state,
      pincode: pincode,
      latitude: coordinate('latitude'),
      longitude: coordinate('longitude'),
      ownerId: data['ownerId'] as String? ?? '',
      ownerName: data['ownerName'] as String? ?? '',
      fullAddress: (data['fullAddress'] as String? ?? '').trim().isNotEmpty
          ? data['fullAddress'] as String
          : [address, city, state, pincode]
              .map((part) => part.trim())
              .where((part) => part.isNotEmpty)
              .join(', '),
    );
  }

  /// Whether the room has a position that can be shown on a map.
  bool get hasCoordinates => latitude != null && longitude != null;
}

/// The visit details of a room.
///
/// The address is only handed out by the **server** — and only to the
/// students whose booking request the owner accepted. The app never shows
/// the address of a room that the owner did not approve the student for.
class VisitRepository {
  final FunctionsService _functions;

  VisitRepository({required this._functions});

  /// Asks the server where the room is.
  ///
  /// It fails with the message of the server when the owner has not accepted
  /// the request yet.
  Future<RoomVisitDetails> getVisitDetails(String roomId) async {
    final result = await _functions.callFunction(
      'getRoomVisitDetails',
      parameters: {'roomId': roomId},
    );

    return RoomVisitDetails.fromData(
      Map<String, dynamic>.from(result.data as Map),
    );
  }
}
