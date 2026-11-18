import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/constants/room_location_privacy.dart';
import 'package:stayserve/models/owned_room_model.dart';
import 'package:stayserve/models/room_model.dart';
import 'package:stayserve/models/room_private_location.dart';

Map<String, dynamic> _legacyRoomJson() {
  return {
    'roomId': 'room-1',
    'ownerId': 'owner-1',
    'title': 'A room',
    'description': 'A comfortable room.',
    'monthlyRent': 5000,
    'securityDeposit': 10000,
    'location': {
      'address': '42 Exact Street',
      'city': 'Bengaluru',
      'state': 'Karnataka',
      'pincode': '560001',
      'latitude': 12.9716,
      'longitude': 77.5946,
    },
    'latitude': 12.9716,
    'longitude': 77.5946,
    'roomType': 'single',
    'furnishing': 'unfurnished',
    'availableFrom': DateTime(2026),
    'occupancy': 2,
    'currentOccupancy': 0,
    'genderPreference': 'any',
    'images': <String>[],
    'status': 'available',
    'createdAt': DateTime(2026),
    'updatedAt': DateTime(2026),
  };
}

void main() {
  group('the public room model', () {
    test('does not expose the exact address or coordinates', () {
      final room = RoomModel.fromJson(_legacyRoomJson(), documentId: 'room-1');

      expect(room.location.toJson(), {
        'city': 'Bengaluru',
        'state': 'Karnataka',
      });
      expect(room.latitude, 12.97);
      expect(room.longitude, 77.59);
    });

    test('uses the Firestore document id as the canonical room id', () {
      final json = _legacyRoomJson()..['roomId'] = 'stale-embedded-room-id';

      final room = RoomModel.fromJson(json, documentId: 'canonical-room-id');

      expect(room.roomId, 'canonical-room-id');
      expect(
        () => RoomModel.fromJson(json, documentId: ' '),
        throwsArgumentError,
      );
    });

    test('uses the server geo cell when one is available', () {
      final json = _legacyRoomJson()
        ..remove('latitude')
        ..remove('longitude');
      final location = json['location'] as Map<String, dynamic>;
      location.remove('latitude');
      location.remove('longitude');
      json['geoCell'] = '12.97,77.59';

      final room = RoomModel.fromJson(json, documentId: 'room-1');
      expect(room.latitude, 12.97);
      expect(room.longitude, 77.59);
    });

    test('never sends exact location fields when a listing is created', () {
      final room = RoomModel.fromJson(_legacyRoomJson(), documentId: 'room-1');
      final payload = room.toCreateJson();

      expect(payload['location'], {'city': 'Bengaluru', 'state': 'Karnataka'});
      expect(payload.containsKey('latitude'), isFalse);
      expect(payload.containsKey('longitude'), isFalse);
      expect(payload.containsKey('geoCell'), isFalse);
      expect(payload.containsKey('address'), isFalse);
      expect(payload.containsKey('pincode'), isFalse);
    });

    test('never sends location fields in an owner listing update', () {
      final room = RoomModel.fromJson(_legacyRoomJson(), documentId: 'room-1');
      final payload = room.toOwnerUpdateJson();

      expect(payload.containsKey('location'), isFalse);
      expect(payload.containsKey('latitude'), isFalse);
      expect(payload.containsKey('longitude'), isFalse);
      expect(payload.containsKey('geoCell'), isFalse);
    });
  });

  group('the public coordinate rounding contract', () {
    test('rounds half-cent boundaries away from zero', () {
      expect(RoomLocationPrivacy.coarseCoordinate(1.005), 1.01);
      expect(RoomLocationPrivacy.coarseCoordinate(-12.975), -12.98);
      expect(RoomLocationPrivacy.coarseCoordinate(12.9716), 12.97);
      expect(RoomLocationPrivacy.coarseCoordinate(-12.9716), -12.97);
    });

    test('uses the same tie rule for the public geo cell', () {
      expect(
        RoomLocationPrivacy.geoCell(latitude: 1.005, longitude: -12.975),
        '1.01,-12.98',
      );
    });
  });

  group('the private room-location model', () {
    test('can recover the owner-only legacy values for an edit form', () {
      final privateLocation = RoomPrivateLocation.fromLegacyRoomJson(
        _legacyRoomJson(),
        roomId: 'room-1',
        ownerId: 'owner-1',
      );

      expect(privateLocation.address, '42 Exact Street');
      expect(privateLocation.pincode, '560001');
      expect(privateLocation.latitude, 12.9716);
      expect(privateLocation.longitude, 77.5946);
    });

    test('stays separate from the public listing', () {
      final listing = RoomModel.fromJson(
        _legacyRoomJson(),
        documentId: 'room-1',
      );
      final owned = OwnedRoomModel(
        listing: listing,
        privateLocation: RoomPrivateLocation(
          roomId: 'room-1',
          ownerId: 'owner-1',
          address: '42 Exact Street',
          city: 'Bengaluru',
          state: 'Karnataka',
          pincode: '560001',
          latitude: 12.9716,
          longitude: 77.5946,
        ),
      );

      expect(owned.location.toJson(), {
        'city': 'Bengaluru',
        'state': 'Karnataka',
      });
      expect(owned.privateLocation?.address, '42 Exact Street');
      expect(owned.status, RoomStatus.available);
    });
  });
}
