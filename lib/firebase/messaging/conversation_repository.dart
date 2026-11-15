import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/enums.dart';
import '../../../core/utils/app_logger.dart';
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
        .map((snapshot) => snapshot.docs
            .map((doc) => _parseConversation(doc))
            .whereType<ConversationModel>()
            .toList());
  }

  /// Messages inside a conversation, oldest first.
  Stream<List<MessageModel>> watchMessages(String conversationId) {
    return _firestore
        .collection('conversations')
        .doc(conversationId)
        .collection('messages')
        .orderBy('createdAt', descending: false)
        .snapshots()
        .map((snapshot) => snapshot.docs
            .map((doc) => _parseMessage(doc))
            .whereType<MessageModel>()
            .toList());
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

    final messageId = 'MSG-${DateTime.now().millisecondsSinceEpoch}';
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

    final conversationRef =
        _firestore.collection('conversations').doc(conversationId);

    // A conversation that does not exist yet is created first, with both
    // parties fixed. Afterwards the participant list can never change (the
    // security rules forbid it).
    final existingConversation = await conversationRef.get();
    if (!existingConversation.exists) {
      await conversationRef.set({
        'conversationId': conversationId,
        'participantIds': [uid, receiverId],
        'lastMessage': '',
        'lastMessageAt': FieldValue.serverTimestamp(),
        'createdAt': FieldValue.serverTimestamp(),
        'updatedAt': FieldValue.serverTimestamp(),
        'unreadCount': <String, dynamic>{},
      });
    }

    // The message and the conversation counters are written in one
    // transaction, so the unread counter can never drift away from the
    // messages.
    await _firestore.runTransaction((transaction) async {
      final snapshot = await transaction.get(conversationRef);
      final existing = snapshot.data();

      final participants =
          (existing?['participantIds'] as List<dynamic>?)?.whereType<String>() ??
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

      // `roomId` is only written when it is actually known. Writing `null`
      // used to wipe the room link of every conversation on the first
      // message that was sent without one.
      if (roomId != null) {
        conversation['roomId'] = roomId;
      }

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
          'title': 'New message',
          'body': content,
          'data': {'conversationId': conversationId},
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

  /// Starts (or reuses) a conversation between two users.
  Future<String> openConversation(String otherUserId, {String? roomId}) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    final participants = [uid, otherUserId]..sort();
    final conversationId = participants.join('_');

    final ref = _firestore.collection('conversations').doc(conversationId);
    final snapshot = await ref.get();

    if (!snapshot.exists) {
      await ref.set({
        'conversationId': conversationId,
        'participantIds': participants,
        'lastMessage': '',
        'lastMessageAt': FieldValue.serverTimestamp(),
        'createdAt': FieldValue.serverTimestamp(),
        'updatedAt': FieldValue.serverTimestamp(),
        'roomId': roomId,
        'unreadCount': <String, dynamic>{},
      });
    }

    return conversationId;
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

  ConversationModel? _parseConversation(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data();
    if (data == null) return null;
    try {
      return ConversationModel.fromJson({
        ...data,
        'conversationId': doc.id,
        'participants': (data['participantIds'] as List<dynamic>? ?? data['participants'] as List<dynamic>? ?? const []),
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
      return value.map((key, val) => MapEntry(key.toString(), (val as num).toInt()));
    }
    return {};
  }
}
