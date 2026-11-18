import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/utils/distance.dart';
import 'package:stayserve/models/launch_pincode_config.dart';
import 'package:stayserve/models/room_model.dart';

void main() {
  group('DistanceUtils', () {
    test('returns null when a coordinate is missing', () {
      expect(
        DistanceUtils.haversineKm(
          fromLat: 12.9716,
          fromLng: 77.5946,
          toLat: null,
          toLng: 77.6,
        ),
        isNull,
      );
      expect(
        DistanceUtils.haversineKm(
          fromLat: null,
          fromLng: null,
          toLat: 12.9716,
          toLng: 77.5946,
        ),
        isNull,
      );
    });

    test('is zero for the same point', () {
      final distance = DistanceUtils.haversineKm(
        fromLat: 12.9716,
        fromLng: 77.5946,
        toLat: 12.9716,
        toLng: 77.5946,
      );
      expect(distance, isNotNull);
      expect(distance!, closeTo(0, 0.001));
    });

    test('matches the known distance between two Bengaluru landmarks', () {
      // Majestic (12.9767, 77.5713) -> Koramangala (12.9352, 77.6245)
      final distance = DistanceUtils.haversineKm(
        fromLat: 12.9767,
        fromLng: 77.5713,
        toLat: 12.9352,
        toLng: 77.6245,
      );
      expect(distance, isNotNull);
      // About 7.2 km as the crow flies.
      expect(distance!, closeTo(7.2, 0.4));
    });

    test('rejects broken coordinates', () {
      expect(
        DistanceUtils.haversineKm(
          fromLat: 999,
          fromLng: 77.5946,
          toLat: 12.9716,
          toLng: 77.5946,
        ),
        isNull,
      );
    });

    test('formats the distance for the user', () {
      expect(DistanceUtils.formatDistance(0.45), '450 m away');
      expect(DistanceUtils.formatDistance(2.34), '2.3 km away');
      expect(DistanceUtils.formatDistance(12.6), '13 km away');
      expect(DistanceUtils.formatDistance(null), '');
    });
  });

  group('LaunchPincodeConfig', () {
    test('lets everybody in when nothing was configured', () {
      const config = LaunchPincodeConfig();
      expect(config.configured, isFalse);
      expect(config.allows('560001'), isTrue);
    });

    test('only allows the listed pincodes in whitelist mode', () {
      final config = LaunchPincodeConfig.fromJson({
        'mode': 'whitelist',
        'enabledPincodes': ['560001', '560002'],
      });
      expect(config.configured, isTrue);
      expect(config.allows('560001'), isTrue);
      expect(config.allows('560002'), isTrue);
      expect(config.allows('560003'), isFalse);
    });

    test('blocks only the listed pincodes in blacklist mode', () {
      final config = LaunchPincodeConfig.fromJson({
        'mode': 'blacklist',
        'disabledPincodes': ['560001'],
      });
      expect(config.allows('560001'), isFalse);
      expect(config.allows('560002'), isTrue);
    });

    test('ignores spaces and dashes in the pincode', () {
      final config = LaunchPincodeConfig.fromJson({
        'mode': 'whitelist',
        'enabledPincodes': ['560 001'],
      });
      expect(config.allows('560001'), isTrue);
      expect(config.allows('560-001'), isTrue);
    });

    test('survives a malformed list', () {
      final config = LaunchPincodeConfig.fromJson({
        'mode': 'whitelist',
        'enabledPincodes': ['560001', 42, null],
      });
      expect(config.enabledPincodes, ['560001', '42']);
    });

    test('an empty whitelist closes the app down', () {
      final config = LaunchPincodeConfig.fromJson({
        'mode': 'whitelist',
        'enabledPincodes': <String>[],
      });
      expect(config.allows('560001'), isFalse);
    });
  });

  group('RoomModel', () {
    RoomModel build({
      double? latitude,
      double? longitude,
      String? homeId,
      String? homeName,
      int occupancy = 1,
      int currentOccupancy = 0,
      String status = 'available',
    }) {
      return RoomModel(
        roomId: 'RM-1',
        ownerId: 'owner-1',
        title: 'A room',
        description: 'A nice room',
        monthlyRent: 5000,
        securityDeposit: 10000,
        location: const Location(city: 'Bengaluru', state: 'Karnataka'),
        roomType: RoomType.single,
        furnishing: FurnishingType.unfurnished,
        availableFrom: DateTime(2026),
        occupancy: occupancy,
        currentOccupancy: currentOccupancy,
        genderPreference: GenderPreference.any,
        status: RoomStatus.values.firstWhere(
          (e) => e.name == status,
          orElse: () => RoomStatus.available,
        ),
        createdAt: DateTime(2026),
        updatedAt: DateTime(2026),
        latitude: latitude,
        longitude: longitude,
        homeId: homeId,
        homeName: homeName,
      );
    }

    test(
      'reads only a coarse public coordinate from a legacy location map',
      () {
        final room = RoomModel.fromJson({
          'roomId': 'RM-1',
          'ownerId': 'owner-1',
          'title': 'A room',
          'description': 'A nice room',
          'monthlyRent': 5000,
          'securityDeposit': 10000,
          'location': {
            'address': 'Some street',
            'city': 'Bengaluru',
            'state': 'Karnataka',
            'pincode': '560001',
            'latitude': 12.9716,
            'longitude': 77.5946,
          },
          'roomType': 'single',
          'furnishing': 'unfurnished',
          'availableFrom': null,
          'occupancy': 1,
          'currentOccupancy': 0,
          'genderPreference': 'any',
          'images': <String>[],
          'status': 'available',
          'createdAt': null,
          'updatedAt': null,
        }, documentId: 'RM-1');

        expect(room.latitude, 12.97);
        expect(room.longitude, 77.59);
      },
    );

    test('calculates the distance to the user', () {
      final room = build(latitude: 12.9352, longitude: 77.6245);
      final distance = room.distanceFrom(latitude: 12.9767, longitude: 77.5713);
      expect(distance, isNotNull);
      expect(distance!, closeTo(7.2, 0.4));
    });

    test('has no distance when the room has no coordinates', () {
      final room = build();
      expect(room.distanceFrom(latitude: 12.9, longitude: 77.5), isNull);
    });

    test('a full room is not available', () {
      final room = build(occupancy: 2, currentOccupancy: 2);
      expect(room.isAvailable, isFalse);
      expect(room.availableSlots, 0);
    });

    test('groups the rooms without a home under one id', () {
      expect(build().resolvedHomeId, RoomModel.legacyHomeId);
      expect(build(homeId: 'HOME-1').resolvedHomeId, 'HOME-1');
    });

    test('an unknown status is never treated as available', () {
      final room = RoomModel.fromJson({
        'roomId': 'RM-1',
        'ownerId': 'owner-1',
        'title': 'A room',
        'description': 'A nice room',
        'monthlyRent': 5000,
        'securityDeposit': 10000,
        'location': const <String, dynamic>{},
        'roomType': 'single',
        'furnishing': 'unfurnished',
        'availableFrom': null,
        'occupancy': 1,
        'currentOccupancy': 0,
        'genderPreference': 'any',
        'images': <String>[],
        'status': 'archived',
        'createdAt': null,
        'updatedAt': null,
      }, documentId: 'RM-1');
      expect(room.status, RoomStatus.inactive);
      expect(room.isAvailable, isFalse);
    });
  });
}
