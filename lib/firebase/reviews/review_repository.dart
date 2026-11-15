import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../models/room_review_model.dart';
import '../auth/auth_service.dart';
import '../functions/functions_service.dart';

final reviewRepositoryProvider = Provider<ReviewRepository>((ref) {
  return ReviewRepository(
    firestore: ref.watch(firestoreProvider),
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
class ReviewRepository {
  final FirebaseFirestore _firestore;
  final FirebaseAuth _auth;
  final FunctionsService _functions;

  ReviewRepository({
    required this._firestore,
    required this._auth,
    required this._functions,
  });

  String? get _uid => _auth.currentUser?.uid;

  /// The reviews of a room, newest first.
  Stream<List<RoomReviewModel>> watchRoomReviews(String roomId) {
    if (roomId.isEmpty) return Stream.value([]);

    return _firestore
        .collection('roomReviews')
        .where('roomId', isEqualTo: roomId)
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map((snapshot) => snapshot.docs
            .map((doc) {
              try {
                return RoomReviewModel.fromJson(doc.id, doc.data());
              } catch (_) {
                // One broken document must not take the whole list down.
                return null;
              }
            })
            .whereType<RoomReviewModel>()
            .toList());
  }

  /// The review the current student wrote for a room — `null` when there is
  /// none.
  Stream<RoomReviewModel?> watchMyReview(String roomId) {
    final uid = _uid;
    if (uid == null || roomId.isEmpty) return Stream.value(null);

    // The id of the review is derived from the room and the student, so the
    // document can be read directly — without a query that would need an
    // index.
    final reviewId = 'REV-$roomId-$uid';

    return _firestore
        .collection('roomReviews')
        .doc(reviewId)
        .snapshots()
        .map((snapshot) {
      if (!snapshot.exists) return null;
      try {
        return RoomReviewModel.fromJson(snapshot.id, snapshot.data()!);
      } catch (_) {
        return null;
      }
    });
  }

  /// Writes (or replaces) the review of the current student for a room.
  ///
  /// The server refuses the review when the owner has not accepted the
  /// booking request yet.
  Future<void> submitReview({
    required String roomId,
    required int rating,
    required String comment,
  }) async {
    await _functions.callFunction(
      'submitRoomReview',
      parameters: {
        'roomId': roomId,
        'rating': rating,
        'comment': comment.trim(),
      },
    );
  }

  /// Removes the review of the current student.
  Future<void> deleteReview({required String roomId}) async {
    await _functions.callFunction(
      'deleteRoomReview',
      parameters: {'roomId': roomId},
    );
  }
}
