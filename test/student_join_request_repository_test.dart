import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/firebase/functions/functions_service.dart';
import 'package:stayserve/firebase/student/student_join_request_repository.dart';

class _UnavailableFirebaseFunctions implements FirebaseFunctions {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Functions are not available in this test');
}

class _FakeFunctionsService extends FunctionsService {
  _FakeFunctionsService({this.response = const <String, dynamic>{}})
    : super(_UnavailableFirebaseFunctions());

  final Map<String, dynamic> response;
  int calls = 0;

  @override
  Future<Map<String, dynamic>> callFunctionData(
    String name, {
    Map<String, dynamic>? parameters,
  }) async {
    calls += 1;
    return Map<String, dynamic>.from(response);
  }
}

class _FakeFirestore implements FirebaseFirestore {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Firestore is not available in this test');
}

Map<String, dynamic> _canonicalRequest({
  String requestId = 'request-1',
  String roomId = 'room-1',
  String studentId = 'student-1',
  String ownerId = 'owner-1',
  String status = 'pending',
}) {
  return <String, dynamic>{
    'requestId': requestId,
    'roomId': roomId,
    'studentId': studentId,
    'ownerId': ownerId,
    'status': status,
    'monthlyRentAtJoin': 14500,
    'commissionPercentageAtJoin': 12.5,
    'platformFeePayer': 'student',
    'advancePaid': false,
    'createdAt': DateTime.utc(2026, 1, 1),
    'updatedAt': DateTime.utc(2026, 1, 1),
  };
}

StudentJoinRequestRepository _repository({
  required _FakeFunctionsService functions,
  required JoinRequestDocumentReader documentReader,
}) {
  final auth = MockFirebaseAuth(
    signedIn: true,
    mockUser: MockUser(uid: 'student-1', email: 'student@example.test'),
  );
  return StudentJoinRequestRepository(
    firestore: _FakeFirestore(),
    auth: auth,
    functions: functions,
    documentReader: documentReader,
  );
}

void main() {
  group('StudentJoinRequestRepository creates only canonical requests', () {
    test('returns the canonical server-owned request', () async {
      final functions = _FakeFunctionsService(
        response: <String, dynamic>{'success': true, 'requestId': 'request-1'},
      );
      var reads = 0;

      final request = await _repository(
        functions: functions,
        documentReader: (_) async {
          reads += 1;
          return _canonicalRequest();
        },
      ).createJoinRequest(roomId: 'room-1');

      expect(functions.calls, 1);
      expect(reads, 1);
      expect(request.requestId, 'request-1');
      expect(request.roomId, 'room-1');
      expect(request.studentId, 'student-1');
      expect(request.ownerId, 'owner-1');
      expect(request.status, JoinRequestStatus.pending);
      expect(request.monthlyRentAtJoin, 14500);
      expect(request.commissionPercentageAtJoin, 12.5);
      expect(request.platformFeePayer, 'student');
    });

    test(
      'rejects an unconfirmed callable response before reading Firestore',
      () async {
        final functions = _FakeFunctionsService(
          response: <String, dynamic>{'success': false},
        );
        var reads = 0;

        await expectLater(
          _repository(
            functions: functions,
            documentReader: (_) async {
              reads += 1;
              return _canonicalRequest();
            },
          ).createJoinRequest(roomId: 'room-1'),
          throwsA(isA<StateError>()),
        );
        expect(reads, 0);
      },
    );

    test('rejects a missing request id before reading Firestore', () async {
      final functions = _FakeFunctionsService(
        response: <String, dynamic>{'success': true, 'requestId': '  '},
      );
      var reads = 0;

      await expectLater(
        _repository(
          functions: functions,
          documentReader: (_) async {
            reads += 1;
            return _canonicalRequest();
          },
        ).createJoinRequest(roomId: 'room-1'),
        throwsA(isA<StateError>()),
      );
      expect(reads, 0);
    });

    test('rejects a missing canonical request', () async {
      final functions = _FakeFunctionsService(
        response: <String, dynamic>{'success': true, 'requestId': 'request-1'},
      );

      await expectLater(
        _repository(
          functions: functions,
          documentReader: (_) async => null,
        ).createJoinRequest(roomId: 'room-1'),
        throwsA(isA<StateError>()),
      );
    });

    test('rejects a mismatched canonical identity', () async {
      for (final document in <Map<String, dynamic>>[
        _canonicalRequest(roomId: 'other-room'),
        _canonicalRequest(studentId: 'other-student'),
        _canonicalRequest(ownerId: ''),
        _canonicalRequest(ownerId: 'student-1'),
        _canonicalRequest(status: 'made-up-status'),
      ]) {
        final functions = _FakeFunctionsService(
          response: <String, dynamic>{
            'success': true,
            'requestId': 'request-1',
          },
        );

        await expectLater(
          _repository(
            functions: functions,
            documentReader: (_) async => document,
          ).createJoinRequest(roomId: 'room-1'),
          throwsA(isA<StateError>()),
        );
      }
    });

    test(
      'does not replace a canonical read failure with a local request',
      () async {
        final functions = _FakeFunctionsService(
          response: <String, dynamic>{
            'success': true,
            'requestId': 'request-1',
          },
        );

        await expectLater(
          _repository(
            functions: functions,
            documentReader: (_) async => throw Exception('read failed'),
          ).createJoinRequest(roomId: 'room-1'),
          throwsA(isA<Exception>()),
        );
      },
    );
  });
}
