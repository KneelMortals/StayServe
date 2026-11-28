import 'dart:async';

import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/students/presentation/providers/student_providers.dart';
import 'package:stayserve/firebase/student/student_repository.dart';
import 'package:stayserve/models/room_model.dart';
import 'package:stayserve/models/user_model.dart';

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

/// A profile of a signed-in account with the given role.
UserModel _profile(String uid, UserRole role) {
  final now = DateTime.utc(2026, 1, 1);
  return UserModel(
    uid: uid,
    name: 'Test $uid',
    email: '$uid@example.com',
    role: role,
    registrationCompleted: true,
    phoneVerified: true,
    createdAt: now,
    updatedAt: now,
  );
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
    location: const Location(city: 'Bengaluru', state: 'Karnataka'),
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

    test('one student may join more than one different room', () {
      final roomIds = joinedRoomIdsFromRequests([
        (
          documentId: 'first-room',
          data: _request(roomId: 'room-first', status: 'adminReviewed'),
        ),
        (
          documentId: 'second-room',
          data: _request(roomId: 'room-second', status: 'adminReviewed'),
        ),
      ]);

      expect(roomIds, ['room-first', 'room-second']);
    });

    test('ending one joined room keeps the student other joined room', () {
      final roomIds = joinedRoomIdsFromRequests([
        (
          documentId: 'released-room',
          data: _request(roomId: 'room-released', status: 'cancelled'),
        ),
        (
          documentId: 'kept-room',
          data: _request(roomId: 'room-kept', status: 'adminReviewed'),
        ),
      ]);

      expect(roomIds, ['room-kept']);
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
      final authEvents = StreamController<AuthSession?>.broadcast();
      final repository = _FakeStudentRepository();
      final container = ProviderContainer(
        overrides: [
          authSessionProvider.overrideWith((ref) => authEvents.stream),
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
        AuthSession(
          user: MockUser(uid: 'student-1', email: 'student-1@example.com'),
          profile: _profile('student-1', UserRole.student),
        ),
      );
      await pumpEventQueue();

      expect(repository.watchedUids, ['student-1']);
      expect(
        container.read(myJoinedRoomsProvider).valueOrNull?.single.roomId,
        'room-1',
      );
    },
  );

  test('the joined-rooms provider stays empty for an owner account', () async {
    final authEvents = StreamController<AuthSession?>.broadcast();
    final repository = _FakeStudentRepository();
    final container = ProviderContainer(
      overrides: [
        authSessionProvider.overrideWith((ref) => authEvents.stream),
        studentRepositoryProvider.overrideWithValue(repository),
      ],
    );
    addTearDown(() async {
      container.dispose();
      await authEvents.close();
    });

    final subscription = container.listen(myJoinedRoomsProvider, (_, __) {});
    addTearDown(subscription.close);

    authEvents.add(
      AuthSession(
        user: MockUser(uid: 'owner-1', email: 'owner-1@example.com'),
        profile: _profile('owner-1', UserRole.owner),
      ),
    );
    await pumpEventQueue();

    // The student-side collections are scoped to the student of a booking.
    // A listener which is attached for an owner is refused by the rules, so
    // it is never attached at all.
    expect(repository.watchedUids, isEmpty);
    expect(container.read(myJoinedRoomsProvider).valueOrNull, isEmpty);
  });
}
