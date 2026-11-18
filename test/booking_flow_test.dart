import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/widgets/common_widgets.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/students/presentation/providers/student_providers.dart';
import 'package:stayserve/features/students/presentation/screens/room_detail_screen.dart';
import 'package:stayserve/firebase/functions/functions_service.dart';
import 'package:stayserve/firebase/student/student_join_request_repository.dart';
import 'package:stayserve/firebase/student/student_repository.dart';
import 'package:stayserve/models/join_request_model.dart';
import 'package:stayserve/models/room_model.dart';
import 'package:stayserve/services/user_location_provider.dart';

// ---------------------------------------------------------------------------
// Test doubles.
//
// The booking flow only needs a handful of collaborators. Everything that
// would talk to Firebase is replaced by a fake that records what it was
// asked to do.
// ---------------------------------------------------------------------------

/// A Firestore that does not talk to the network.
class _FakeFirestore implements FirebaseFirestore {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Firestore is not available in the test');
}

/// A `FirebaseFunctions` that does not talk to the network.
class _FakeFirebaseFunctions implements FirebaseFunctions {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Functions are not available in the test');
}

class _FakeFunctionsService extends FunctionsService {
  _FakeFunctionsService() : super(_FakeFirebaseFunctions());
}

/// Records the booking request instead of sending it to the server.
class _FakeJoinRequestRepository extends StudentJoinRequestRepository {
  _FakeJoinRequestRepository()
    : super(
        firestore: _FakeFirestore(),
        auth: MockFirebaseAuth(),
        functions: _FakeFunctionsService(),
      );

  String? requestedRoomId;
  bool called = false;

  /// The request that was cancelled — `null` when nothing was cancelled.
  String? cancelledRequestId;

  /// When this is set, the creation fails with this message.
  String? createError;

  @override
  Future<JoinRequestModel> createJoinRequest({
    required String roomId,
    String? ownerId,
    double? monthlyRent,
  }) async {
    called = true;
    requestedRoomId = roomId;

    final error = createError;
    if (error != null) throw Exception(error);

    final now = DateTime(2026, 1, 1);
    return JoinRequestModel(
      requestId: 'JRQ-test',
      roomId: roomId,
      studentId: 'student-1',
      ownerId: ownerId ?? '',
      status: JoinRequestStatus.pending,
      createdAt: now,
      updatedAt: now,
      monthlyRentAtJoin: monthlyRent ?? 0,
      commissionPercentageAtJoin: 30,
    );
  }

  @override
  Future<void> cancelJoinRequest(String requestId, {String? reason}) async {
    cancelledRequestId = requestId;
  }
}

/// A location that never asks the device where it is.
class _FakeLocationNotifier extends UserLocationNotifier {
  @override
  UserLocation? build() => null;
}

/// A student repository that only answers "is this room saved?" and hands
/// out the requests of the student.
class _FakeStudentRepository extends StudentRepository {
  _FakeStudentRepository()
    : super(firestore: _FakeFirestore(), auth: MockFirebaseAuth());

  /// The requests the student has. The list is read **every time** the
  /// provider is invalidated, so a cancelled request really disappears.
  List<JoinRequestModel> requests = [];

  @override
  Future<bool> isRoomSaved(String roomId) async => false;

  @override
  Stream<List<JoinRequestModel>> watchMyJoinRequests() async* {
    yield List<JoinRequestModel>.of(requests);
  }
}

RoomModel _room() {
  final now = DateTime(2026, 1, 1);
  return RoomModel(
    roomId: 'room-1',
    ownerId: 'owner-1',
    title: 'Test room',
    description: 'A room for the test',
    monthlyRent: 12000,
    securityDeposit: 30000,
    location: const Location(city: 'Bengaluru', state: 'Karnataka'),
    roomType: RoomType.single,
    furnishing: FurnishingType.semi,
    availableFrom: now,
    amenities: const ['WiFi'],
    occupancy: 1,
    genderPreference: GenderPreference.any,
    status: RoomStatus.available,
    createdAt: now,
    updatedAt: now,
  );
}

JoinRequestModel _request({
  String requestId = 'JRQ-test',
  String roomId = 'room-1',
  JoinRequestStatus status = JoinRequestStatus.pending,
  bool advancePaid = false,
}) {
  final now = DateTime(2026, 1, 1);
  return JoinRequestModel(
    requestId: requestId,
    roomId: roomId,
    studentId: 'student-1',
    ownerId: 'owner-1',
    status: status,
    createdAt: now,
    updatedAt: now,
    monthlyRentAtJoin: 12000,
    commissionPercentageAtJoin: 30,
    advancePaid: advancePaid,
    advanceAmount: advancePaid ? 3600 : null,
    advancePaymentReference: advancePaid ? '425781234567' : null,
    advancePaymentStatus: advancePaid ? PaymentStatus.submitted : null,
  );
}

/// Pumps the room page with the fakes in place.
Future<void> _pumpRoom(
  WidgetTester tester, {
  required _FakeJoinRequestRepository joinRequests,
  required _FakeStudentRepository studentRepository,
  required MockUser user,
  GoRouter? router,
}) async {
  final goRouter =
      router ??
      GoRouter(
        initialLocation: '/room/room-1',
        routes: [
          GoRoute(
            path: '/room/:roomId',
            builder: (context, state) =>
                RoomDetailScreen(roomId: state.pathParameters['roomId']!),
          ),
          GoRoute(
            path: '/student/requests',
            builder: (context, state) =>
                const Scaffold(body: Center(child: Text('Student Requests'))),
          ),
        ],
      );

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        currentUserProvider.overrideWithValue(user),
        currentUserRoleProvider.overrideWithValue(UserRole.student),
        authStateProvider.overrideWith((ref) => Stream.value(user)),
        roomProvider.overrideWith((ref, roomId) => Stream.value(_room())),
        userLocationProvider.overrideWith(_FakeLocationNotifier.new),
        studentRepositoryProvider.overrideWithValue(studentRepository),
        studentJoinRequestProvider.overrideWithValue(joinRequests),
        myJoinRequestsProvider.overrideWith(
          (ref) => Stream<List<JoinRequestModel>>.value(
            List<JoinRequestModel>.of(studentRepository.requests),
          ),
        ),
      ],
      child: MaterialApp.router(routerConfig: goRouter),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('booking a room sends the request and turns the button into '
      '"Cancel booking"', (tester) async {
    final joinRequests = _FakeJoinRequestRepository();
    final studentRepository = _FakeStudentRepository();
    final user = MockUser(uid: 'student-1', email: 'student@example.com');

    await _pumpRoom(
      tester,
      joinRequests: joinRequests,
      studentRepository: studentRepository,
      user: user,
    );

    // The room is on the screen and the booking button is reachable.
    expect(find.text('Test room'), findsWidgets);
    final requestButton = find.widgetWithText(AppButton, 'Request to Book');
    expect(requestButton, findsOneWidget);

    await tester.ensureVisible(requestButton);
    await tester.pumpAndSettle();
    await tester.tap(requestButton);
    await tester.pumpAndSettle();

    // The dialog explains the terms and offers the platform UPI.
    expect(find.text('Request to book'), findsOneWidget);
    expect(find.textContaining('shauryaprataprai461-2@oksbi'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, 'Send Request'));
    await tester.pumpAndSettle();

    // The request really went out ...
    expect(joinRequests.called, isTrue);
    expect(joinRequests.requestedRoomId, 'room-1');

    // ... and the button of the room says "Cancel booking" now.
    //
    // Before the fix it still said "Request to Book" — and a second tap
    // produced the strange error "You have already requested to join this
    // room" from the server.
    expect(find.widgetWithText(AppButton, 'Request to Book'), findsNothing);
    expect(find.widgetWithText(AppButton, 'Cancel booking'), findsOneWidget);
  });

  testWidgets('cancelling the booking dialog does not send a request', (
    tester,
  ) async {
    final joinRequests = _FakeJoinRequestRepository();
    final studentRepository = _FakeStudentRepository();
    final user = MockUser(uid: 'student-1', email: 'student@example.com');

    await _pumpRoom(
      tester,
      joinRequests: joinRequests,
      studentRepository: studentRepository,
      user: user,
    );

    final requestButton = find.widgetWithText(AppButton, 'Request to Book');
    await tester.ensureVisible(requestButton);
    await tester.pumpAndSettle();
    await tester.tap(requestButton);
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();

    expect(joinRequests.called, isFalse);
    expect(find.text('Student Requests'), findsNothing);
    expect(find.widgetWithText(AppButton, 'Request to Book'), findsOneWidget);
  });

  testWidgets(
    'a request that already exists turns the button into "Cancel booking"',
    (tester) async {
      final joinRequests = _FakeJoinRequestRepository();
      final studentRepository = _FakeStudentRepository()
        ..requests = [_request()];
      final user = MockUser(uid: 'student-1', email: 'student@example.com');

      await _pumpRoom(
        tester,
        joinRequests: joinRequests,
        studentRepository: studentRepository,
        user: user,
      );

      // The student has already asked for this room — the button must not
      // offer a second request.
      expect(find.widgetWithText(AppButton, 'Request to Book'), findsNothing);
      expect(find.widgetWithText(AppButton, 'Cancel booking'), findsOneWidget);
    },
  );

  testWidgets('a cancelled request lets the student ask for the room again', (
    tester,
  ) async {
    final joinRequests = _FakeJoinRequestRepository();
    final studentRepository = _FakeStudentRepository()
      ..requests = [_request(status: JoinRequestStatus.cancelled)];
    final user = MockUser(uid: 'student-1', email: 'student@example.com');

    await _pumpRoom(
      tester,
      joinRequests: joinRequests,
      studentRepository: studentRepository,
      user: user,
    );

    expect(find.widgetWithText(AppButton, 'Request to Book'), findsOneWidget);
    expect(find.widgetWithText(AppButton, 'Cancel booking'), findsNothing);
  });

  testWidgets(
    'cancelling the booking asks the server and turns the button back',
    (tester) async {
      final joinRequests = _FakeJoinRequestRepository();
      final studentRepository = _FakeStudentRepository()
        ..requests = [_request()];
      final user = MockUser(uid: 'student-1', email: 'student@example.com');

      await _pumpRoom(
        tester,
        joinRequests: joinRequests,
        studentRepository: studentRepository,
        user: user,
      );

      final cancelButton = find.widgetWithText(AppButton, 'Cancel booking');
      expect(cancelButton, findsOneWidget);

      await tester.ensureVisible(cancelButton);
      await tester.pumpAndSettle();
      await tester.tap(cancelButton);
      await tester.pumpAndSettle();

      // The student is asked first — a cancellation cannot be undone.
      expect(find.text('Cancel booking?'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Cancel booking'));
      await tester.pumpAndSettle();

      expect(joinRequests.cancelledRequestId, 'JRQ-test');

      // The request is gone — the button offers the request again.
      studentRepository.requests = [];
      await tester.pumpAndSettle();
    },
  );

  testWidgets('a booking that already has money in it cannot be cancelled', (
    tester,
  ) async {
    final joinRequests = _FakeJoinRequestRepository();
    final studentRepository = _FakeStudentRepository()
      ..requests = [_request(advancePaid: true)];
    final user = MockUser(uid: 'student-1', email: 'student@example.com');

    await _pumpRoom(
      tester,
      joinRequests: joinRequests,
      studentRepository: studentRepository,
      user: user,
    );

    // A non-cancellable request does not offer a misleading disabled action.
    expect(find.widgetWithText(AppButton, 'Request to Book'), findsNothing);
    expect(find.widgetWithText(AppButton, 'Cancel booking'), findsNothing);
    expect(joinRequests.cancelledRequestId, isNull);
  });

  testWidgets('a joined room shows You joined and has no cancel action', (
    tester,
  ) async {
    final joinRequests = _FakeJoinRequestRepository();
    final studentRepository = _FakeStudentRepository()
      ..requests = [
        _request(status: JoinRequestStatus.adminReviewed, advancePaid: true),
      ];
    final user = MockUser(uid: 'student-1', email: 'student@example.com');

    await _pumpRoom(
      tester,
      joinRequests: joinRequests,
      studentRepository: studentRepository,
      user: user,
    );

    expect(find.text('You joined this room'), findsOneWidget);
    expect(find.widgetWithText(AppButton, 'Request to Book'), findsNothing);
    expect(find.widgetWithText(AppButton, 'Cancel booking'), findsNothing);
    expect(find.widgetWithText(AppButton, 'Visit the room'), findsOneWidget);
  });

  testWidgets('a confirmed but inactive booking can still be cancelled', (
    tester,
  ) async {
    final joinRequests = _FakeJoinRequestRepository();
    final studentRepository = _FakeStudentRepository()
      ..requests = [_request(status: JoinRequestStatus.studentConfirmed)];
    final user = MockUser(uid: 'student-1', email: 'student@example.com');

    await _pumpRoom(
      tester,
      joinRequests: joinRequests,
      studentRepository: studentRepository,
      user: user,
    );

    expect(find.text('You joined this room'), findsNothing);
    expect(find.widgetWithText(AppButton, 'Cancel booking'), findsOneWidget);
  });

  testWidgets('a second request does not produce the error of the server', (
    tester,
  ) async {
    final joinRequests = _FakeJoinRequestRepository()
      ..createError = 'You have already requested to join this room';
    final studentRepository = _FakeStudentRepository();
    final user = MockUser(uid: 'student-1', email: 'student@example.com');

    await _pumpRoom(
      tester,
      joinRequests: joinRequests,
      studentRepository: studentRepository,
      user: user,
    );

    final requestButton = find.widgetWithText(AppButton, 'Request to Book');
    await tester.ensureVisible(requestButton);
    await tester.pumpAndSettle();
    await tester.tap(requestButton);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Send Request'));
    await tester.pumpAndSettle();

    // The raw error of the server is **not** shown ...
    expect(find.textContaining('Request failed'), findsNothing);

    // ... the student gets an explanation ...
    expect(find.textContaining('already requested this room'), findsOneWidget);
  });
}
