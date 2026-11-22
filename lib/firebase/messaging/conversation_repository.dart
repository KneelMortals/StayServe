import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../../core/constants/enums.dart';
import '../../../core/utils/app_logger.dart';
import '../../../models/interaction_model.dart';
import '../../../models/messaging_model.dart';
import '../auth/auth_service.dart';
import '../functions/functions_service.dart';

final conversationRepositoryProvider = Provider<ConversationRepository>((ref) {
  return ConversationRepository(
    firestore: ref.watch(firestoreProvider),
    auth: ref.watch(firebaseAuthProvider),
    functions: ref.watch(functionsServiceProvider),
  );
});

/// Data access for conversations and their messages.
class ConversationRepository {
  static const Uuid _uuid = Uuid();

  final FirebaseFirestore _firestore;
  final FirebaseAuth _auth;
  final FunctionsService _functions;

  ConversationRepository({
    required this._firestore,
    required this._auth,
    required this._functions,
  });

  String? get _uid => _auth.currentUser?.uid;

  /// Conversations the current user takes part in, newest first.
  Stream<List<ConversationModel>> watchConversations() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);

    return _firestore
        .collection('conversations')
        .where('participantIds', arrayContains: uid)
        .orderBy('updatedAt', descending: true)
        .snapshots()
        .map(
          (snapshot) => snapshot.docs
              .map((doc) => _parseConversation(doc))
              .whereType<ConversationModel>()
              .toList(),
        );
  }

  /// Messages inside a conversation, oldest first.
  Stream<List<MessageModel>> watchMessages(String conversationId) {
    return _firestore
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .orderBy('createdAt', descending: false)
        .snapshots()
        .map(
          (snapshot) => snapshot.docs
              .map((doc) => _parseMessage(doc))
              .whereType<MessageModel>()
              .toList(),
        );
  }

  /// Sends a message inside a conversation.
  Future<void> sendMessage({
    required String conversationId,
    required String receiverId,
    required String content,
    MessageType type = MessageType.text,
    String? roomId,
    String? imageUrl,
  }) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    // Message ids are random rather than timestamp-only. Two devices can
    // send in the same millisecond, and a timestamp id made one of those
    // messages overwrite the other.
    final messageId = 'MSG-${_uuid.v4()}';
    final now = DateTime.now();

    final message = MessageModel(
      messageId: messageId,
      conversationId: conversationId,
      senderId: uid,
      receiverId: receiverId,
      content: content,
      type: type,
      createdAt: now,
      roomId: roomId,
      imageUrl: imageUrl,
    );

    final conversationRef = _firestore
        .collection('conversations')
        .doc(conversationId);

    // Conversation creation is server-owned. The server verifies the room
    // and its owner before it creates the participant list, so this client
    // can only send into a conversation which already exists.

    // The message and the conversation counters are written in one
    // transaction, so the unread counter can never drift away from the
    // messages.
    await _firestore.runTransaction((transaction) async {
      final snapshot = await transaction.get(conversationRef);
      final existing = snapshot.data();

      final participants =
          (existing?['participantIds'] as List<dynamic>?)
              ?.whereType<String>() ??
          const <String>[];
      if (!participants.contains(uid)) {
        throw Exception('You are not part of this conversation');
      }

      final conversation = <String, dynamic>{};

      // The unread counters are a map of `uid -> count` everywhere. The old
      // code wrote a *number* here while `openConversation` wrote a map,
      // which made the whole batch fail with "Cannot increment a non-numeric
      // value" — the message was never stored.
      final unread = <String, int>{};
      final rawUnread = existing?['unreadCount'];
      if (rawUnread is Map) {
        rawUnread.forEach((key, value) {
          if (value is num) unread[key.toString()] = value.toInt();
        });
      }
      if (receiverId != uid) {
        unread[receiverId] = (unread[receiverId] ?? 0) + 1;
      }

      conversation['lastMessage'] = content;
      conversation['lastMessageAt'] = FieldValue.serverTimestamp();
      conversation['updatedAt'] = FieldValue.serverTimestamp();
      conversation['unreadCount'] = unread;

      // The listing context is server-owned. A client message must not
      // re-point an existing conversation to another room.
      transaction.set(conversationRef, conversation, SetOptions(merge: true));
      transaction.set(
        conversationRef.collection('messages').doc(messageId),
        message.toJson(),
      );
    });

    // The notification is written by the server, which checks that the
    // recipient really is the other participant of this conversation — a
    // client used to be able to push notifications into anybody's list.
    try {
      await _functions.callFunction(
        'notifyUser',
        parameters: {
          'userId': receiverId,
          'type': 'newMessage',
          'data': {'conversationId': conversationId, 'messageId': messageId},
        },
      );
    } catch (e) {
      // A missing notification must never lose the message itself.
      AppLogger.warning('Could not create the chat notification', error: e);
    }
  }

  /// Resets the unread counter of the current user for [conversationId].
  Future<void> markConversationRead(String conversationId) async {
    final uid = _uid;
    if (uid == null) return;

    final ref = _firestore.collection('conversations').doc(conversationId);
    try {
      await _firestore.runTransaction((transaction) async {
        final snapshot = await transaction.get(ref);
        if (!snapshot.exists) return;

        final rawUnread = snapshot.data()?['unreadCount'];
        if (rawUnread is! Map) return;

        final unread = <String, int>{};
        rawUnread.forEach((key, value) {
          if (value is num) unread[key.toString()] = value.toInt();
        });
        if ((unread[uid] ?? 0) == 0) return;

        unread[uid] = 0;
        transaction.update(ref, {'unreadCount': unread});
      });
    } catch (e) {
      AppLogger.warning('Could not mark the conversation as read', error: e);
    }
  }

  /// Starts (or reuses) a verified conversation.
  ///
  /// A student may open a room inquiry with the owner of that room. Either
  /// booking participant may also open the conversation through a verified
  /// booking request, which is how an owner replies to a student.
  Future<ConversationOpenResult> openConversation(
    String otherUserId, {
    String? roomId,
    String? requestId,
  }) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');
    final cleanRoomId = roomId?.trim() ?? '';
    final cleanRequestId = requestId?.trim() ?? '';
    if (cleanRoomId.isEmpty && cleanRequestId.isEmpty) {
      throw Exception('A room or booking request is required.');
    }

    final data = await _callInteraction(
      'openConversation',
      parameters: {
        'otherUserId': otherUserId,
        if (cleanRoomId.isNotEmpty) 'roomId': cleanRoomId,
        if (cleanRequestId.isNotEmpty) 'requestId': cleanRequestId,
      },
      fallbackMessage: 'Could not open the conversation',
    );
    final conversationId = data['conversationId'];
    if (conversationId is! String || conversationId.isEmpty) {
      throw Exception('The server did not return a conversation id.');
    }
    return ConversationOpenResult.fromJson(data);
  }

  /// Loads the peer name, listing title and current block state of a chat.
  Future<ConversationInteractionDetails> getConversationInteractionDetails(
    String conversationId, {
    String? roomId,
    String? requestId,
  }) async {
    final data = await _callInteraction(
      'getConversationInteractionDetails',
      parameters: {
        'conversationId': conversationId,
        if (roomId != null && roomId.trim().isNotEmpty) 'roomId': roomId.trim(),
        if (requestId != null && requestId.trim().isNotEmpty)
          'requestId': requestId.trim(),
      },
      fallbackMessage: 'Could not load the conversation details',
    );
    return ConversationInteractionDetails.fromJson(data);
  }

  /// Loads the real participant names, room title and block state of a
  /// booking request.
  Future<BookingInteractionDetails> getBookingInteractionDetails(
    String requestId,
  ) async {
    final data = await _callInteraction(
      'getBookingInteractionDetails',
      parameters: {'requestId': requestId},
      fallbackMessage: 'Could not load the booking details',
    );
    return BookingInteractionDetails.fromJson(data);
  }

  /// Loads the safe owner contact details for a room listing.
  Future<RoomContactDetails> getRoomContactDetails(String roomId) async {
    final data = await _callInteraction(
      'getRoomContactDetails',
      parameters: {'roomId': roomId},
      fallbackMessage: 'Could not load the owner details',
    );
    return RoomContactDetails.fromJson(data);
  }

  /// Blocks the other participant from new messages and booking progress.
  Future<UserBlockResult> blockUser(
    String otherUserId, {
    String? requestId,
    String? conversationId,
  }) async {
    final data = await _callInteraction(
      'blockUser',
      parameters: {
        'otherUserId': otherUserId,
        if (requestId != null && requestId.trim().isNotEmpty)
          'requestId': requestId.trim(),
        if (conversationId != null && conversationId.trim().isNotEmpty)
          'conversationId': conversationId.trim(),
      },
      fallbackMessage: 'Could not block this participant',
    );
    return UserBlockResult.fromJson(data);
  }

  /// Removes only the current user's block of the other participant.
  Future<UserBlockResult> unblockUser(String otherUserId) async {
    final data = await _callInteraction(
      'unblockUser',
      parameters: {'otherUserId': otherUserId},
      fallbackMessage: 'Could not unblock this participant',
    );
    return UserBlockResult.fromJson(data);
  }

  /// Calls an interaction callable and converts Firebase failures into the
  /// readable [Exception] used by the screens.
  Future<Map<String, dynamic>> _callInteraction(
    String name, {
    required Map<String, dynamic> parameters,
    required String fallbackMessage,
  }) async {
    try {
      final result = await _functions.callFunction(
        name,
        parameters: parameters,
      );
      final raw = result.data;
      if (raw is! Map) {
        throw Exception(fallbackMessage);
      }
      return Map<String, dynamic>.from(raw);
    } on FirebaseFunctionsException catch (error) {
      final message = error.message?.trim();
      throw Exception(
        message == null || message.isEmpty ? fallbackMessage : message,
      );
    }
  }

  /// The uid of the other participant of a conversation.
  ///
  /// The chat screen used to take the recipient from the conversation
  /// **list** — a query that is not needed to write a message and that can
  /// fail (or still be loading) on its own. Reading the conversation
  /// document directly is always possible for a participant and makes the
  /// message input independent of the list.
  Future<String?> getOtherParticipant(String conversationId) async {
    final uid = _uid;
    if (uid == null) return null;

    try {
      final snapshot = await _firestore
          .collection('conversations')
          .doc(conversationId)
          .get();
      if (!snapshot.exists) return null;

      final participants =
          (snapshot.data()?['participantIds'] as List<dynamic>?)
              ?.whereType<String>()
              .toList() ??
          const <String>[];
      for (final participant in participants) {
        if (participant != uid) return participant;
      }
      return null;
    } catch (e) {
      AppLogger.warning('Could not read the conversation', error: e);
      return null;
    }
  }

  ConversationModel? _parseConversation(
    DocumentSnapshot<Map<String, dynamic>> doc,
  ) {
    final data = doc.data();
    if (data == null) return null;
    try {
      return ConversationModel.fromJson({
        ...data,
        'conversationId': doc.id,
        'participants':
            (data['participantIds'] as List<dynamic>? ??
            data['participants'] as List<dynamic>? ??
            const []),
        'lastMessage': data['lastMessage'] ?? '',
        'lastMessageAt': data['lastMessageAt'],
        'unreadCount': _asIntMap(data['unreadCount']),
        'roomId': data['roomId'] as String?,
        'createdAt': data['createdAt'],
        'updatedAt': data['updatedAt'],
      });
    } catch (_) {
      return null;
    }
  }

  MessageModel? _parseMessage(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data();
    if (data == null) return null;
    try {
      return MessageModel.fromJson({
        ...data,
        'messageId': doc.id,
        'conversationId': data['conversationId'] ?? '',
        'senderId': data['senderId'] ?? '',
        'receiverId': data['receiverId'] ?? '',
        'content': data['content'] ?? '',
        'type': data['type'] ?? 'text',
        'createdAt': data['createdAt'],
        'readAt': data['readAt'],
        'roomId': data['roomId'] as String?,
        'imageUrl': data['imageUrl'] as String?,
      });
    } catch (_) {
      return null;
    }
  }

  Map<String, int> _asIntMap(dynamic value) {
    if (value is Map) {
      return value.map(
        (key, val) => MapEntry(key.toString(), (val as num).toInt()),
      );
    }
    return {};
  }
}
