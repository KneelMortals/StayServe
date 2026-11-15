import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/students/presentation/providers/student_providers.dart';
import 'package:stayserve/firebase/student/student_repository.dart';
import 'package:stayserve/models/room_model.dart';

class _FakeStudentRepository implements StudentRepository {
  final List<String> watchedUids = <String>[];

  @override
  Stream<List<RoomModel>> watchJoinedRoomsForUid(String uid) {
    watchedUids.add(uid);
    return Stream.value([_room()]);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

RoomModel _room() {
  final now = DateTime.utc(2026, 1, 1);
  return RoomModel(
    roomId: 'room-1',
    ownerId: 'owner-1',
    title: 'Joined room',
    description: '',
    monthlyRent: 1000,
    securityDeposit: 0,
    location: const Location(
      address: '',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    ),
    roomType: RoomType.single,
    furnishing: FurnishingType.unfurnished,
    availableFrom: now,
    occupancy: 1,
    currentOccupancy: 1,
    genderPreference: GenderPreference.any,
    status: RoomStatus.occupied,
    createdAt: now,
    updatedAt: now,
  );
}

Map<String, dynamic> _request({
  required String roomId,
  required String status,
}) {
  return {
    'requestId': 'JRQ-$roomId',
    'roomId': roomId,
    'studentId': 'student-1',
    'ownerId': 'owner-1',
    'status': status,
    'monthlyRentAtJoin': 1000,
    'commissionPercentageAtJoin': 30,
  };
}

void main() {
  group('joined-room request selection', () {
    test('only an admin-reviewed request is a joined room', () {
      final roomIds = joinedRoomIdsFromRequests([
        (
          documentId: 'pending',
          data: _request(roomId: 'room-pending', status: 'pending'),
        ),
        (
          documentId: 'owner-confirmed',
          data: _request(roomId: 'room-owner', status: 'ownerConfirmed'),
        ),
        (
          documentId: 'student-confirmed',
          data: _request(roomId: 'room-student', status: 'studentConfirmed'),
        ),
        (
          documentId: 'payment-submitted',
          data: _request(roomId: 'room-submitted', status: 'studentConfirmed'),
        ),
        (
          documentId: 'admin-reviewed',
          data: _request(roomId: 'room-active', status: 'adminReviewed'),
        ),
      ]);

      expect(roomIds, ['room-active']);
    });

    test('the legacy admin_reviewed spelling is also joined', () {
      final roomIds = joinedRoomIdsFromRequests([
        (
          documentId: 'legacy',
          data: _request(roomId: 'legacy-room', status: 'admin_reviewed'),
        ),
      ]);

      expect(roomIds, ['legacy-room']);
    });

    test('one malformed request does not hide the other joined rooms', () {
      final roomIds = joinedRoomIdsFromRequests([
        (documentId: 'malformed', data: {'status': 123, 'roomId': 456}),
        (
          documentId: 'missing-room',
          data: _request(roomId: '', status: 'adminReviewed'),
        ),
        (
          documentId: 'valid',
          data: _request(roomId: 'valid-room', status: 'adminReviewed'),
        ),
      ]);

      expect(roomIds, ['valid-room']);
    });

    test('duplicate room ids are returned only once', () {
      final roomIds = joinedRoomIdsFromRequests([
        (
          documentId: 'first',
          data: _request(roomId: 'same-room', status: 'adminReviewed'),
        ),
        (
          documentId: 'second',
          data: _request(roomId: 'same-room', status: 'adminReviewed'),
        ),
      ]);

      expect(roomIds, ['same-room']);
    });
  });

  test(
    'the joined-rooms provider starts when Firebase restores the user',
    () async {
      final authEvents = StreamController<User?>.broadcast();
      final repository = _FakeStudentRepository();
      final container = ProviderContainer(
        overrides: [
          authStateProvider.overrideWith((ref) => authEvents.stream),
          studentRepositoryProvider.overrideWithValue(repository),
        ],
      );
      addTearDown(() async {
        container.dispose();
        await authEvents.close();
      });

      final subscription = container.listen(myJoinedRoomsProvider, (_, __) {});
      addTearDown(subscription.close);

      await pumpEventQueue();
      expect(repository.watchedUids, isEmpty);
      expect(container.read(myJoinedRoomsProvider).valueOrNull, isEmpty);

      authEvents.add(
        MockUser(uid: 'student-1', email: 'student-1@example.com'),
      );
      await pumpEventQueue();

      expect(repository.watchedUids, ['student-1']);
      expect(
        container.read(myJoinedRoomsProvider).valueOrNull?.single.roomId,
        'room-1',
      );
    },
  );
}
