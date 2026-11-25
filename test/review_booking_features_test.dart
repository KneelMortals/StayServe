import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/reviews/presentation/providers/review_providers.dart';
import 'package:stayserve/models/join_request_model.dart';
import 'package:stayserve/models/notification_model.dart';
import 'package:stayserve/models/room_review_model.dart';

/// The three features that were added on top of the booking:
///
///  1. a student may **review** a room — but only after the owner accepted
///     their request,
///  2. a booking may be **cancelled** even after the owner accepted it, as
///     long as nothing was paid,
///  3. the student gets the **location** of the room as soon as the owner
///     accepted.
///
/// The rules are made by the server, but the app mirrors them — and the
/// mirror has to be exactly the same, or the app would offer a button that
/// the server refuses (or hide a button that works).
void main() {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  JoinRequestModel request({
    String requestId = 'JRQ-1',
    JoinRequestStatus status = JoinRequestStatus.pending,
    String roomId = 'RM-1',
    bool advancePaid = false,
    bool platformCutTaken = false,
    PaymentStatus? paymentStatus,
  }) {
    final now = DateTime(2026, 11, 13);
    return JoinRequestModel(
      requestId: requestId,
      roomId: roomId,
      studentId: 'student-1',
      ownerId: 'owner-1',
      status: status,
      createdAt: now,
      updatedAt: now,
      monthlyRentAtJoin: 10000,
      commissionPercentageAtJoin: 30,
      advancePaid: advancePaid,
      platformCutTaken: platformCutTaken,
      advancePaymentStatus: paymentStatus,
    );
  }

  RoomReviewModel review({
    String reviewId = 'REV-RM-1-student-1',
    String roomId = 'RM-1',
    String studentId = 'student-1',
    int rating = 5,
    String comment = 'Nice room',
    String studentName = 'Asha',
  }) {
    final now = DateTime(2026, 11, 13);
    return RoomReviewModel(
      reviewId: reviewId,
      reviewInstanceId: 'review-instance-1',
      roomId: roomId,
      studentId: studentId,
      ownerId: 'owner-1',
      joinRequestId: 'JRQ-1',
      rating: rating,
      comment: comment,
      studentName: studentName,
      createdAt: now,
      updatedAt: now,
    );
  }

  // ---------------------------------------------------------------------------
  // 1) The review gate
  // ---------------------------------------------------------------------------
  group('the review gate', () {
    test('a request that is still pending is not an acceptance', () {
      expect(request().isOwnerAccepted, isFalse);
    });

    test('a declined request is not an acceptance', () {
      expect(
        request(status: JoinRequestStatus.rejected).isOwnerAccepted,
        isFalse,
      );
    });

    test('a cancelled request is not an acceptance', () {
      expect(
        request(status: JoinRequestStatus.cancelled).isOwnerAccepted,
        isFalse,
      );
    });

    test('the approval of the owner is an acceptance', () {
      expect(
        request(status: JoinRequestStatus.ownerConfirmed).isOwnerAccepted,
        isTrue,
      );
    });

    test('the confirmation of the student is an acceptance', () {
      expect(
        request(status: JoinRequestStatus.studentConfirmed).isOwnerAccepted,
        isTrue,
      );
    });

    test('the review of the admin is an acceptance', () {
      expect(
        request(status: JoinRequestStatus.adminReviewed).isOwnerAccepted,
        isTrue,
      );
    });

    test('a student without an accepted request may not review', () {
      final requests = [
        request(status: JoinRequestStatus.pending),
        request(requestId: 'JRQ-2', status: JoinRequestStatus.rejected),
      ];

      expect(mayReviewRoom(requests, 'RM-1'), isFalse);
    });

    test('a student with an accepted request may review', () {
      final requests = [
        request(status: JoinRequestStatus.pending),
        request(requestId: 'JRQ-2', status: JoinRequestStatus.ownerConfirmed),
      ];

      expect(mayReviewRoom(requests, 'RM-1'), isTrue);
    });

    test('the acceptance of another room does not help', () {
      final requests = [
        request(
          requestId: 'JRQ-2',
          roomId: 'RM-2',
          status: JoinRequestStatus.ownerConfirmed,
        ),
      ];

      expect(mayReviewRoom(requests, 'RM-1'), isFalse);
      expect(ownerAcceptedRequestFor(requests, 'RM-2'), isTrue);
    });

    test('a student without any request may not review', () {
      expect(mayReviewRoom(const [], 'RM-1'), isFalse);
    });
  });

  // ---------------------------------------------------------------------------
  // 2) The cancellation after the acceptance
  // ---------------------------------------------------------------------------
  group('the cancellation', () {
    test('a pending request can be cancelled', () {
      expect(request().canBeCancelled, isTrue);
    });

    test('a request the owner approved can be cancelled', () {
      // This is the whole point of the feature: the acceptance is not a
      // payment, so the booking can still be walked away from.
      expect(
        request(status: JoinRequestStatus.ownerConfirmed).canBeCancelled,
        isTrue,
      );
    });

    test('a request the student confirmed can be cancelled', () {
      expect(
        request(status: JoinRequestStatus.studentConfirmed).canBeCancelled,
        isTrue,
      );
    });

    test('an active booking cannot be cancelled', () {
      expect(
        request(status: JoinRequestStatus.adminReviewed).canBeCancelled,
        isFalse,
      );
    });

    test('a cancelled request cannot be cancelled again', () {
      expect(
        request(status: JoinRequestStatus.cancelled).canBeCancelled,
        isFalse,
      );
    });

    test('a request with a paid fee cannot be cancelled', () {
      expect(
        request(
          status: JoinRequestStatus.ownerConfirmed,
          advancePaid: true,
        ).canBeCancelled,
        isFalse,
      );
    });

    test('a request with a submitted payment cannot be cancelled', () {
      // The payment is recorded as *submitted* the moment the student sends
      // the reference — from that moment on the money is out.
      expect(
        request(
          status: JoinRequestStatus.studentConfirmed,
          paymentStatus: PaymentStatus.submitted,
        ).canBeCancelled,
        isFalse,
      );
    });

    test('a request with a verified payment cannot be cancelled', () {
      expect(
        request(
          status: JoinRequestStatus.studentConfirmed,
          paymentStatus: PaymentStatus.verified,
        ).canBeCancelled,
        isFalse,
      );
    });

    test('a request whose cut was taken cannot be cancelled', () {
      expect(
        request(
          status: JoinRequestStatus.studentConfirmed,
          platformCutTaken: true,
        ).canBeCancelled,
        isFalse,
      );
    });

    test('a rejected payment does not block the cancellation', () {
      // The payment was refused — no money arrived, so the booking may
      // still be walked away from.
      expect(
        request(
          status: JoinRequestStatus.studentConfirmed,
          paymentStatus: PaymentStatus.rejected,
        ).canBeCancelled,
        isTrue,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // The review model
  // ---------------------------------------------------------------------------
  group('the review model', () {
    test('a review is read from the document', () {
      final now = DateTime(2026, 11, 13);
      final model = RoomReviewModel.fromJson('REV-1', {
        'reviewId': 'REV-1',
        'roomId': 'RM-1',
        'studentId': 'student-1',
        'ownerId': 'owner-1',
        'joinRequestId': 'JRQ-1',
        'rating': 4,
        'comment': 'Good light',
        'studentName': 'Asha',
        'createdAt': now,
        'updatedAt': now,
      });

      expect(model.reviewId, 'REV-1');
      expect(model.roomId, 'RM-1');
      expect(model.studentId, 'student-1');
      expect(model.joinRequestId, 'JRQ-1');
      expect(model.rating, 4);
      expect(model.comment, 'Good light');
      expect(model.studentName, 'Asha');
      expect(model.createdAt, now);
    });

    test('a broken document does not break the model', () {
      final model = RoomReviewModel.fromJson('REV-1', const {});

      expect(model.roomId, '');
      expect(model.rating, 0);
      expect(model.comment, '');
      expect(model.displayName, 'A student');
    });

    test('a rating out of range is invalid, not the smallest rating', () {
      // A broken document must not drag the average of the room down to a
      // single star — it is left out of the average instead.
      expect(RoomReviewModel.fromJson('REV-1', const {'rating': 9}).rating, 0);
      expect(RoomReviewModel.fromJson('REV-1', const {'rating': 0}).rating, 0);
      expect(RoomReviewModel.fromJson('REV-1', const {'rating': -3}).rating, 0);
      expect(
        RoomReviewModel.fromJson('REV-1', const {'rating': 'five'}).rating,
        0,
      );
      expect(RoomReviewModel.fromJson('REV-1', const {'rating': 4}).rating, 4);
    });

    test('the name of the author is never empty', () {
      expect(review(studentName: '  ').displayName, 'A student');
      expect(review(studentName: 'Asha').displayName, 'Asha');
    });

    test('two reviews with the same data are equal', () {
      expect(review(), review());
      expect(review().hashCode, review().hashCode);
      expect(review(), isNot(review(rating: 4)));
    });
  });

  // ---------------------------------------------------------------------------
  // The average of the reviews
  // ---------------------------------------------------------------------------
  group('the average of the reviews', () {
    test('a room without reviews has no average', () {
      final summary = ReviewSummary.fromReviews(const []);

      expect(summary.average, 0);
      expect(summary.count, 0);
      expect(summary.averageLabel, '—');
    });

    test('a single review is its own average', () {
      final summary = ReviewSummary.fromReviews([review(rating: 5)]);

      expect(summary.average, 5);
      expect(summary.count, 1);
      expect(summary.averageLabel, '5.0');
    });

    test('the average is calculated over all reviews', () {
      final summary = ReviewSummary.fromReviews([
        review(reviewId: 'REV-1', rating: 5),
        review(reviewId: 'REV-2', rating: 4),
        review(reviewId: 'REV-3', rating: 3),
      ]);

      expect(summary.average, 4);
      expect(summary.count, 3);
      expect(summary.averageLabel, '4.0');
    });

    test('the distribution counts every score', () {
      final summary = ReviewSummary.fromReviews([
        review(reviewId: 'REV-1', rating: 5),
        review(reviewId: 'REV-2', rating: 5),
        review(reviewId: 'REV-3', rating: 3),
      ]);

      expect(summary.distribution[5], 2);
      expect(summary.distribution[4], 0);
      expect(summary.distribution[3], 1);
      expect(summary.distribution[1], 0);
      expect(summary.distribution[2], 0);
    });

    test('a broken rating does not drag the average down', () {
      final broken = RoomReviewModel.fromJson('REV-X', const {'rating': 0});
      final summary = ReviewSummary.fromReviews([
        review(reviewId: 'REV-1', rating: 4),
        broken,
      ]);

      expect(summary.count, 1);
      expect(summary.average, 4);
    });
  });

  // ---------------------------------------------------------------------------
  // The notification of a review
  // ---------------------------------------------------------------------------
  group('the notification of a review', () {
    test('a review opens the reviews of the room', () {
      expect(
        notificationRouteFor(
          type: 'review',
          data: const {'roomId': 'RM-1', 'reviewId': 'REV-1'},
          role: UserRole.owner,
        ),
        '/room/RM-1/reviews',
      );
    });

    test('a review without a room does not break the route', () {
      final route = notificationRouteFor(
        type: 'review',
        data: const {},
        role: UserRole.owner,
      );

      expect(route, '/owner/rooms');
    });

    test('the type of the review is known', () {
      final notification = NotificationModel.fromJson({
        'notificationId': 'N-1',
        'userId': 'u1',
        'type': 'review',
        'title': 'New review',
        'body': 'You rated 5/5',
        'data': <String, dynamic>{'roomId': 'RM-1'},
        'createdAt': DateTime(2026, 11, 13).toIso8601String(),
      });

      expect(notification.type, NotificationType.review);
      expect(notification.routeFor(UserRole.owner), '/room/RM-1/reviews');
    });
  });
}
