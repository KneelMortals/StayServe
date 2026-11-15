// Regression tests for the "owner uploads a room, the student does not see
// it" bug.
//
// The cause was a listing that was written **without** the server-owned
// fields. The student search compares the listing status with an equality
// (`status == available`), and a Firestore equality query never matches a
// document that does not have the field — so a perfectly valid listing was
// invisible to every student.
//
// The fix has three parts, and each of them is covered here:
//
//   1. the create payload states the initial values (`available` / 0);
//   2. the student search filters the status in Dart, so a listing without
//      the field is still offered;
//   3. the model treats a missing status as "available".

import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/firebase/student/student_repository.dart';
import 'package:stayserve/models/room_model.dart';

RoomModel _room({
  int occupancy = 2,
  int currentOccupancy = 0,
  RoomStatus status = RoomStatus.available,
}) {
  final now = DateTime(2026, 1, 1);
  return RoomModel(
    roomId: 'RM-1',
    ownerId: 'owner-1',
    title: 'A room',
    description: 'A nice room',
    monthlyRent: 5000,
    securityDeposit: 10000,
    location: const Location(
      address: 'Some street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    ),
    roomType: RoomType.single,
    furnishing: FurnishingType.unfurnished,
    availableFrom: DateTime(2026),
    occupancy: occupancy,
    currentOccupancy: currentOccupancy,
    genderPreference: GenderPreference.any,
    status: status,
    createdAt: now,
    updatedAt: now,
  );
}

void main() {
  group('the room create payload', () {
    test('states the initial server-owned state', () {
      final payload = _room().toCreateJson();

      // A listing without a status never matches the student search, so the
      // initial values have to be part of the create payload.
      expect(payload.containsKey('status'), isTrue);
      expect(payload['status'], 'available');
      expect(payload.containsKey('currentOccupancy'), isTrue);
      expect(payload['currentOccupancy'], 0);
    });

    test('does not carry any tenant of the owner', () {
      final payload = _room().toCreateJson();

      expect(payload['ownerId'], 'owner-1');
      expect(payload['occupancy'], 2);
      expect(payload['currentOccupancy'], 0);
      expect(payload['status'], 'available');
    });
  });

  group('a listing without a status', () {
    final legacy = RoomModel.fromJson({
      'roomId': 'RM-legacy',
      'ownerId': 'owner-1',
      'title': 'An older listing',
      'monthlyRent': 5000,
      'location': {'city': 'Bengaluru'},
      'occupancy': 2,
    });

    test('is read as available', () {
      expect(legacy.status, RoomStatus.available);
    });

    test('is still offered to students', () {
      expect(isRoomOfferedToStudents(legacy), isTrue);
    });
  });

  group('the listings offered to students', () {
    test('an available listing with a free slot is offered', () {
      expect(isRoomOfferedToStudents(_room()), isTrue);
    });

    test('a full listing is not offered', () {
      expect(
        isRoomOfferedToStudents(_room(occupancy: 2, currentOccupancy: 2)),
        isFalse,
      );
    });

    test('an occupied listing is not offered', () {
      expect(
        isRoomOfferedToStudents(_room(status: RoomStatus.occupied)),
        isFalse,
      );
    });

    test('an inactive listing is not offered', () {
      expect(
        isRoomOfferedToStudents(_room(status: RoomStatus.inactive)),
        isFalse,
      );
    });
  });
}
