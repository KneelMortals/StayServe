import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../models/join_request_model.dart';
import '../../../../models/room_review_model.dart';
import '../../../../firebase/reviews/review_repository.dart';
import '../../../students/presentation/providers/student_providers.dart';

/// The reviews of a room, newest first.
final roomReviewsProvider =
    StreamProvider.autoDispose.family<List<RoomReviewModel>, String>((ref, roomId) {
  return ref.watch(reviewRepositoryProvider).watchRoomReviews(roomId);
});

/// The average of the reviews of a room.
final roomReviewSummaryProvider =
    Provider.autoDispose.family<ReviewSummary, String>((ref, roomId) {
  final reviews = ref.watch(roomReviewsProvider(roomId)).valueOrNull ??
      const <RoomReviewModel>[];
  return ReviewSummary.fromReviews(reviews);
});

/// The review the current student wrote for a room.
final myRoomReviewProvider =
    StreamProvider.autoDispose.family<RoomReviewModel?, String>((ref, roomId) {
  return ref.watch(reviewRepositoryProvider).watchMyReview(roomId);
});

/// The booking requests of the current student whose owner accepted them.
///
/// These are the requests that make the two features possible: the student
/// may see where the room is and may review it.
final myAcceptedRequestsProvider =
    Provider.autoDispose<List<JoinRequestModel>>((ref) {
  final requests = ref.watch(myJoinRequestsProvider).valueOrNull ??
      const <JoinRequestModel>[];
  return requests.where((request) => request.isOwnerAccepted).toList();
});

/// Whether the owner accepted the request of the current student for
/// [roomId].
bool ownerAcceptedRequestFor(
  List<JoinRequestModel> requests,
  String roomId,
) {
  for (final request in requests) {
    if (request.roomId == roomId && request.isOwnerAccepted) return true;
  }
  return false;
}

/// Whether the current student may review the room [roomId].
bool mayReviewRoom(List<JoinRequestModel> requests, String roomId) {
  return ownerAcceptedRequestFor(requests, roomId);
}
