import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../models/room_review_model.dart';
import '../auth/auth_service.dart';
import '../functions/functions_service.dart';

final reviewRepositoryProvider = Provider<ReviewRepository>((ref) {
  return ReviewRepository(
    auth: ref.watch(firebaseAuthProvider),
    functions: ref.watch(functionsServiceProvider),
  );
});

/// Data access for the reviews of a room.
///
/// The reviews are **written by the server**: the client sends the room and
/// the rating, and the server checks that the owner accepted the booking
/// request of the student. A modified client therefore cannot review a room
/// it was never accepted for, and it cannot write a review in somebody
/// else's name.
///
/// Reads also go through the server. A direct Firestore list would expose
/// every review record and the reviewer's uid/name to every signed-in
/// tenant. The callable returns one room at a time and redacts the reviewer
/// identity for viewers who are not entitled to it.
class ReviewRepository {
  final FirebaseAuth _auth;
  final FunctionsService _functions;

  ReviewRepository({required this._auth, required this._functions});

  String? get currentUserId => _auth.currentUser?.uid;

  /// The reviews of one room, newest first.
  Future<List<RoomReviewModel>> getRoomReviews(String roomId) async {
    final cleanRoomId = roomId.trim();
    if (cleanRoomId.isEmpty) return const [];

    final result = await _functions.callFunction(
      'getRoomReviews',
      parameters: {'roomId': cleanRoomId},
    );
    final data = Map<String, dynamic>.from(result.data as Map);
    final rawReviews = data['reviews'];
    if (rawReviews is! List) return const [];

    final reviews = <RoomReviewModel>[];
    for (final rawReview in rawReviews) {
      if (rawReview is! Map) continue;
      try {
        final review = Map<String, dynamic>.from(rawReview);
        reviews.add(
          RoomReviewModel.fromJson(
            review['reviewId']?.toString() ?? '',
            review,
          ),
        );
      } catch (_) {
        // One malformed record must not take the whole room list down.
      }
    }
    return reviews;
  }

  /// The review the current student wrote for a room — `null` when there is
  /// none.
  RoomReviewModel? myReviewFrom(List<RoomReviewModel> reviews) {
    final uid = currentUserId;
    if (uid == null) return null;
    for (final review in reviews) {
      if (review.studentId == uid) return review;
    }
    return null;
  }

  /// Writes (or replaces) the review of the current student for a room.
  ///
  /// The server refuses the review when the owner has not accepted the
  /// booking request yet. [expectedReviewInstanceId] binds an edit to the
  /// exact lifecycle the user saw; a delayed edit cannot recreate a review
  /// which was moderated in the meantime.
  Future<ReviewSubmissionResult> submitReview({
    required String roomId,
    required int rating,
    required String comment,
    String? expectedReviewInstanceId,
  }) async {
    final result = await _functions.callFunction(
      'submitRoomReview',
      parameters: {
        'roomId': roomId.trim(),
        'rating': rating,
        'comment': comment.trim(),
        if (expectedReviewInstanceId != null &&
            expectedReviewInstanceId.trim().isNotEmpty)
          'expectedReviewInstanceId': expectedReviewInstanceId.trim(),
      },
    );
    final data = Map<String, dynamic>.from(result.data as Map);
    return ReviewSubmissionResult.fromJson(data);
  }

  /// Removes the review of the current student.
  Future<void> deleteReview({
    required String roomId,
    required String reviewInstanceId,
  }) async {
    await _functions.callFunction(
      'deleteRoomReview',
      parameters: {
        'roomId': roomId.trim(),
        'expectedReviewInstanceId': reviewInstanceId.trim(),
      },
    );
  }

  /// Removes any room review as a live administrator.
  ///
  /// The server re-checks the live administrator role in the same
  /// transaction which deletes the review and records the moderation action
  /// in its audit collection. The expected lifecycle prevents a delayed
  /// moderation request from deleting a recreated review.
  Future<AdminReviewDeletionResult> deleteReviewAsAdmin({
    required String reviewId,
    required String reviewInstanceId,
  }) async {
    final result = await _functions.callFunction(
      'deleteAnyRoomReview',
      parameters: {
        'reviewId': reviewId,
        'expectedReviewInstanceId': reviewInstanceId,
      },
    );
    return AdminReviewDeletionResult.fromJson(
      Map<String, dynamic>.from(result.data as Map),
    );
  }
}

/// The server-confirmed identity of a submitted review.
class ReviewSubmissionResult {
  final String reviewId;
  final String reviewInstanceId;

  const ReviewSubmissionResult({
    required this.reviewId,
    required this.reviewInstanceId,
  });

  factory ReviewSubmissionResult.fromJson(Map<String, dynamic> json) {
    final reviewId = json['reviewId']?.toString().trim() ?? '';
    final reviewInstanceId = json['reviewInstanceId']?.toString().trim() ?? '';
    if (reviewId.isEmpty || reviewInstanceId.isEmpty) {
      throw const FormatException(
        'Missing review identity in the review-submission result.',
      );
    }
    return ReviewSubmissionResult(
      reviewId: reviewId,
      reviewInstanceId: reviewInstanceId,
    );
  }
}

/// The idempotent result of an administrator review deletion.
class AdminReviewDeletionResult {
  final String reviewId;
  final String reviewInstanceId;
  final bool alreadyDeleted;

  const AdminReviewDeletionResult({
    required this.reviewId,
    this.reviewInstanceId = '',
    this.alreadyDeleted = false,
  });

  factory AdminReviewDeletionResult.fromJson(Map<String, dynamic> json) {
    final reviewId = json['reviewId']?.toString().trim() ?? '';
    if (reviewId.isEmpty) {
      throw const FormatException(
        'Missing reviewId in the administrator review-deletion result.',
      );
    }
    return AdminReviewDeletionResult(
      reviewId: reviewId,
      reviewInstanceId: json['reviewInstanceId']?.toString().trim() ?? '',
      alreadyDeleted: json['alreadyDeleted'] == true,
    );
  }
}
