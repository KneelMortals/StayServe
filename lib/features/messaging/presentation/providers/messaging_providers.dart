import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../core/constants/enums.dart';
import '../../../../../features/auth/presentation/providers/auth_provider.dart';
import '../../../../../firebase/messaging/conversation_repository.dart';
import '../../../../../models/interaction_model.dart';
import '../../../../../models/messaging_model.dart';

final conversationsProvider =
    StreamProvider.autoDispose<List<ConversationModel>>((ref) {
      final includeAdminSupport =
          ref.watch(currentUserRoleProvider) == UserRole.admin;
      return ref
          .watch(conversationRepositoryProvider)
          .watchConversations(includeAdminSupport: includeAdminSupport);
    });

final messagesProvider = StreamProvider.autoDispose
    .family<List<MessageModel>, String>((ref, conversationId) {
      return ref
          .watch(conversationRepositoryProvider)
          .watchMessages(conversationId);
    });

/// The context needed to resolve the correct listing for one conversation.
typedef ConversationInteractionKey = ({
  String conversationId,
  String? roomId,
  String? requestId,
});

/// Loads the server-resolved peer name, room title and block state.
final conversationInteractionDetailsProvider = FutureProvider.autoDispose
    .family<ConversationInteractionDetails, ConversationInteractionKey>((
      ref,
      key,
    ) {
      return ref
          .watch(conversationRepositoryProvider)
          .getConversationInteractionDetails(
            key.conversationId,
            roomId: key.roomId,
            requestId: key.requestId,
          );
    });

/// Loads the real participant names, room title and block state of a
/// booking request.
final bookingInteractionDetailsProvider = FutureProvider.autoDispose
    .family<BookingInteractionDetails, String>((ref, requestId) {
      return ref
          .watch(conversationRepositoryProvider)
          .getBookingInteractionDetails(requestId);
    });

/// Loads the safe owner name and block state shown on a room listing.
final roomContactDetailsProvider = FutureProvider.autoDispose
    .family<RoomContactDetails, String>((ref, roomId) {
      return ref
          .watch(conversationRepositoryProvider)
          .getRoomContactDetails(roomId);
    });

/// The deterministic conversation id used for a participant pair.
String conversationIdForParticipants(String firstUserId, String secondUserId) {
  final ids = [
    firstUserId.trim(),
    secondUserId.trim(),
  ].where((id) => id.isNotEmpty).toSet().toList()..sort();
  return ids.join('_');
}

/// Refreshes every client view which depends on one participant pair.
///
/// A block is stored for the pair, not for one screen. The chat, the
/// booking-request card and the room listing can therefore all be mounted at
/// the same time. Invalidating only the screen where the button was pressed
/// would leave another mounted screen showing stale controls until it was
/// rebuilt from scratch.
void invalidateParticipantInteractionProviders(
  WidgetRef ref, {
  required String conversationId,
  String? roomId,
  String? requestId,
}) {
  final normalizedRoomId = roomId?.trim();
  final normalizedRequestId = requestId?.trim();
  final contextRoomId = normalizedRoomId == null || normalizedRoomId.isEmpty
      ? null
      : normalizedRoomId;
  final contextRequestId =
      normalizedRequestId == null || normalizedRequestId.isEmpty
      ? null
      : normalizedRequestId;

  // The current context (a request-backed chat has both ids).
  ref.invalidate(
    conversationInteractionDetailsProvider((
      conversationId: conversationId,
      roomId: contextRoomId,
      requestId: contextRequestId,
    )),
  );

  if (contextRequestId != null) {
    ref.invalidate(bookingInteractionDetailsProvider(contextRequestId));
  }

  if (contextRoomId != null) {
    ref.invalidate(roomContactDetailsProvider(contextRoomId));
  }

  // A block belongs to the participant pair, not to one route or one
  // listing. The same student and owner can have several mounted chats,
  // booking cards and room details at once, each with a different context
  // key. Invalidate every active metadata family as well so none of those
  // screens can keep showing a stale composer or booking action.
  ref.invalidate(conversationInteractionDetailsProvider);
  ref.invalidate(bookingInteractionDetailsProvider);
  ref.invalidate(roomContactDetailsProvider);
}
