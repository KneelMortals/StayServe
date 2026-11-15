import 'package:cloud_firestore/cloud_firestore.dart';

/// A review a student wrote about a room.
///
/// ## When may a review be written?
///
/// Only when the **owner accepted the booking request** of the student. The
/// rule is enforced by the server (see `submitRoomReview` in
/// `functions/src/reviews.ts`) — the client only mirrors it so that the
/// button is shown at the right moment.
class RoomReviewModel {
  final String reviewId;
  final String roomId;
  final String studentId;
  final String ownerId;

  /// The booking request that made the review possible.
  ///
  /// It is the proof that the owner accepted the student — the review is
  /// taken back when the request is not accepted any more.
  final String joinRequestId;

  /// The number of stars, from 1 to 5.
  final int rating;

  /// What the student wrote. May be empty.
  final String comment;

  /// The name of the student — shown next to the review.
  final String studentName;

  final DateTime createdAt;
  final DateTime updatedAt;

  const RoomReviewModel({
    required this.reviewId,
    required this.roomId,
    required this.studentId,
    required this.ownerId,
    required this.joinRequestId,
    required this.rating,
    required this.comment,
    required this.studentName,
    required this.createdAt,
    required this.updatedAt,
  });

  factory RoomReviewModel.fromJson(String reviewId, Map<String, dynamic> json) {
    return RoomReviewModel(
      reviewId: json['reviewId'] as String? ?? reviewId,
      roomId: json['roomId'] as String? ?? '',
      studentId: json['studentId'] as String? ?? '',
      ownerId: json['ownerId'] as String? ?? '',
      joinRequestId: json['joinRequestId'] as String? ?? '',
      // A rating that is not a whole number between 1 and 5 is **invalid**,
      // not "the smallest rating": it is kept as `0` and left out of the
      // average. Clamping it to 1 would let one broken document drag the
      // average of a room down to a single star.
      rating: _readRating(json['rating']),
      comment: json['comment'] as String? ?? '',
      studentName: json['studentName'] as String? ?? '',
      createdAt: _toDate(json['createdAt']),
      updatedAt: _toDate(json['updatedAt']),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'reviewId': reviewId,
      'roomId': roomId,
      'studentId': studentId,
      'ownerId': ownerId,
      'joinRequestId': joinRequestId,
      'rating': rating,
      'comment': comment,
      'studentName': studentName,
      'createdAt': Timestamp.fromDate(createdAt),
      'updatedAt': Timestamp.fromDate(updatedAt),
    };
  }

  /// The name that is shown — never empty.
  String get displayName =>
      studentName.trim().isNotEmpty ? studentName.trim() : 'A student';

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is RoomReviewModel &&
            runtimeType == other.runtimeType &&
            reviewId == other.reviewId &&
            roomId == other.roomId &&
            studentId == other.studentId &&
            ownerId == other.ownerId &&
            joinRequestId == other.joinRequestId &&
            rating == other.rating &&
            comment == other.comment &&
            studentName == other.studentName &&
            createdAt == other.createdAt &&
            updatedAt == other.updatedAt;
  }

  @override
  int get hashCode => Object.hash(
        reviewId,
        roomId,
        studentId,
        ownerId,
        joinRequestId,
        rating,
        comment,
        studentName,
        createdAt,
        updatedAt,
      );

  @override
  String toString() => 'RoomReviewModel(reviewId: $reviewId, roomId: $roomId, '
      'studentId: $studentId, rating: $rating)';
}

/// The average of the reviews of a room.
class ReviewSummary {
  /// The average number of stars — `0` when there is no review.
  final double average;

  /// How many reviews there are.
  final int count;

  /// How many stars each of the five scores was given.
  final Map<int, int> distribution;

  const ReviewSummary({
    this.average = 0,
    this.count = 0,
    this.distribution = const {},
  });

  factory ReviewSummary.fromReviews(List<RoomReviewModel> reviews) {
    if (reviews.isEmpty) return const ReviewSummary();

    var total = 0;
    final distribution = <int, int>{for (var i = 1; i <= 5; i++) i: 0};

    for (final review in reviews) {
      if (review.rating < 1 || review.rating > 5) continue;
      total += review.rating;
      distribution[review.rating] = (distribution[review.rating] ?? 0) + 1;
    }

    final counted = distribution.values.fold<int>(0, (total, n) => total + n);
    if (counted == 0) return const ReviewSummary();

    return ReviewSummary(
      average: total / counted,
      count: counted,
      distribution: distribution,
    );
  }

  /// The label of the average — e.g. "4.5".
  String get averageLabel =>
      count == 0 ? '—' : average.toStringAsFixed(1);
}

/// Reads the rating of a review.
///
/// A rating outside 1..5 (or one that is not a number at all) is invalid —
/// it is reported as `0` and left out of the average.
int _readRating(dynamic value) {
  if (value is! num) return 0;
  if (!value.isFinite) return 0;

  final rating = value.toInt();
  if (rating < 1 || rating > 5) return 0;
  return rating;
}

/// Reads a Firestore timestamp (or ISO string) into a [DateTime].
DateTime _toDate(dynamic value) {
  if (value is Timestamp) return value.toDate();
  if (value is DateTime) return value;
  if (value is String) {
    final parsed = DateTime.tryParse(value);
    if (parsed != null) return parsed;
  }
  return DateTime.fromMillisecondsSinceEpoch(0);
}
