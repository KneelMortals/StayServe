import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/reviews/presentation/providers/review_providers.dart';
import 'package:stayserve/features/reviews/presentation/screens/room_reviews_screen.dart';
import 'package:stayserve/features/students/presentation/providers/student_providers.dart';
import 'package:stayserve/models/join_request_model.dart';
import 'package:stayserve/models/room_review_model.dart';

/// The review screen of a room.
///
/// The **form** is only shown to the students whose request the owner
/// accepted. The server makes the very same check — but the app must not
/// offer a button that the server refuses.
void main() {
  JoinRequestModel request({
    JoinRequestStatus status = JoinRequestStatus.pending,
    String roomId = 'RM-1',
  }) {
    final now = DateTime(2026, 11, 14);
    return JoinRequestModel(
      requestId: 'JRQ-1',
      roomId: roomId,
      studentId: 'student-1',
      ownerId: 'owner-1',
      status: status,
      createdAt: now,
      updatedAt: now,
      monthlyRentAtJoin: 10000,
      commissionPercentageAtJoin: 30,
    );
  }

  /// The screen with the providers of the room replaced by fixed data.
  Widget screen({
    required List<JoinRequestModel> requests,
    List<RoomReviewModel> reviews = const [],
  }) {
    return ProviderScope(
      overrides: [
        myJoinRequestsProvider.overrideWith((ref) => Stream.value(requests)),
        roomReviewsProvider(
          'RM-1',
        ).overrideWith((ref) => Stream.value(reviews)),
        myRoomReviewProvider('RM-1').overrideWith((ref) => Stream.value(null)),
      ],
      child: const MaterialApp(
        home: RoomReviewsScreen(roomId: 'RM-1', roomTitle: 'Test room'),
      ),
    );
  }

  testWidgets('a student without an accepted request gets no review form', (
    tester,
  ) async {
    await tester.pumpWidget(
      screen(requests: [request(status: JoinRequestStatus.pending)]),
    );
    await tester.pumpAndSettle();

    expect(find.text('Write a review'), findsNothing);
    expect(
      find.text(
        'You can review this room once the owner accepts your request.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a declined request gets no review form either', (tester) async {
    await tester.pumpWidget(
      screen(requests: [request(status: JoinRequestStatus.rejected)]),
    );
    await tester.pumpAndSettle();

    expect(find.text('Write a review'), findsNothing);
  });

  testWidgets('the owner acceptance shows the review form', (tester) async {
    await tester.pumpWidget(
      screen(requests: [request(status: JoinRequestStatus.ownerConfirmed)]),
    );
    await tester.pumpAndSettle();

    expect(find.text('Write a review'), findsOneWidget);
    expect(find.text('Publish review'), findsOneWidget);
  });

  testWidgets('the confirmation of the student shows the review form too', (
    tester,
  ) async {
    await tester.pumpWidget(
      screen(requests: [request(status: JoinRequestStatus.studentConfirmed)]),
    );
    await tester.pumpAndSettle();

    expect(find.text('Write a review'), findsOneWidget);
  });

  testWidgets('the acceptance of another room does not show the form', (
    tester,
  ) async {
    await tester.pumpWidget(
      screen(
        requests: [
          request(status: JoinRequestStatus.ownerConfirmed, roomId: 'RM-2'),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Write a review'), findsNothing);
  });

  testWidgets('the reviews of the room are listed', (tester) async {
    final now = DateTime(2026, 11, 14);
    await tester.pumpWidget(
      screen(
        requests: [request(status: JoinRequestStatus.ownerConfirmed)],
        reviews: [
          RoomReviewModel(
            reviewId: 'REV-1',
            roomId: 'RM-1',
            studentId: 'student-2',
            ownerId: 'owner-1',
            joinRequestId: 'JRQ-2',
            rating: 5,
            comment: 'A very nice room',
            studentName: 'Ravi',
            createdAt: now,
            updatedAt: now,
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('A very nice room'), findsOneWidget);
    expect(find.text('Ravi'), findsOneWidget);
    expect(find.text('1 review'), findsOneWidget);
  });

  testWidgets('a room without reviews says so', (tester) async {
    await tester.pumpWidget(
      screen(requests: [request(status: JoinRequestStatus.ownerConfirmed)]),
    );
    await tester.pumpAndSettle();

    expect(find.text('No Reviews Yet'), findsOneWidget);
    expect(find.text('0 reviews'), findsOneWidget);
  });
}
