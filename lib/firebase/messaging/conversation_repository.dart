import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
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

/// Keeps the idempotency key of an unresolved administrator message.
///
/// The server trims the message before storing it. The client therefore uses
/// the same trimmed text as the operation identity: a retry which only adds
/// whitespace is the same send. Once a send succeeds, its key is released so
/// that deliberately sending the same text again creates a new message.
///
/// The key is additionally scoped by the recipient (a conversation or a user
/// id). Two sends of the same text to different recipients are different
/// operations, and one of them must not release the other's key — otherwise
/// a retry after a lost response could create a second message.
class AdminMessageRequestTracker {
  AdminMessageRequestTracker(this._newRequestId);

  final String Function() _newRequestId;
  final Map<String, String> _pendingRequestIdsByKey = {};

  /// The stable request id for an unresolved send of [content] to [scope].
  ///
  /// [scope] identifies the recipient of the message. It may be empty when a
  /// caller only ever talks to one recipient.
  String requestIdFor(String content, {String scope = ''}) {
    final canonicalContent = content.trim();
    if (canonicalContent.isEmpty) {
      throw ArgumentError.value(content, 'content', 'Message cannot be empty');
    }
    return _pendingRequestIdsByKey.putIfAbsent(
      _keyFor(scope, canonicalContent),
      _newRequestId,
    );
  }

  /// Releases the key after the server has confirmed the send.
  void markSucceeded(String content, {String scope = ''}) {
    _pendingRequestIdsByKey.remove(_keyFor(scope, content.trim()));
  }

  String _keyFor(String scope, String canonicalContent) =>
      '$scope\u0000$canonicalContent';
}

/// Data access for conversations and their messages.
class ConversationRepository {
  static const Uuid _uuid = Uuid();

  final FirebaseFirestore _firestore;
  final FirebaseAuth _auth;
  final FunctionsService _functions;

  /// The idempotency key of an unresolved administrator-support reply.
  ///
  /// The server derives the message id from the request id, so a retry after
  /// a lost response updates the same message instead of creating a second
  /// one.
  final AdminMessageRequestTracker _supportReplyRequestTracker =
      AdminMessageRequestTracker(() => _uuid.v4());

  ConversationRepository({
    required this._firestore,
    required this._auth,
    required this._functions,
  });

  String? get _uid => _auth.currentUser?.uid;

  /// Conversations the current user takes part in, newest first.
  ///
  /// Administrator support conversations are discovered through a trusted
  /// server callable because their public participant list contains an opaque
  /// identity instead of the administrator's real uid. The returned ids are
  /// then watched as exact documents, where Firestore independently verifies
  /// the server-only administrator mapping for every request.
  ///
  /// The discovery runs again while the inbox is open: a support
  /// conversation which was created after the inbox was mounted has to show
  /// up without a restart of the app.
  Stream<List<ConversationModel>> watchConversations({
    bool includeAdminSupport = false,
  }) {
    final uid = _uid;
    if (uid == null) return Stream.value([]);

    final ordinaryStream = _firestore
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

    if (!includeAdminSupport) return ordinaryStream;

    return Stream<List<ConversationModel>>.multi((controller) {
      final ordinaryConversations = <String, ConversationModel>{};
      final supportConversations = <String, ConversationModel>{};
      final subscriptions = <StreamSubscription<dynamic>>[];
      final supportSubscriptions = <String, StreamSubscription<dynamic>>{};
      var stopped = false;
      var discovering = false;

      void emitConversations() {
        if (stopped) return;
        final conversationsById = <String, ConversationModel>{
          ...ordinaryConversations,
          ...supportConversations,
        };
        final conversations = conversationsById.values.toList()
          ..sort((left, right) {
            final byUpdatedAt = right.updatedAt.compareTo(left.updatedAt);
            if (byUpdatedAt != 0) return byUpdatedAt;
            return left.conversationId.compareTo(right.conversationId);
          });
        controller.add(conversations);
      }

      void addError(Object error, StackTrace stackTrace) {
        if (stopped) return;
        controller.addError(error, stackTrace);
      }

      subscriptions.add(
        ordinaryStream.listen((conversations) {
          ordinaryConversations.clear();
          for (final conversation in conversations) {
            ordinaryConversations[conversation.conversationId] = conversation;
          }
          emitConversations();
        }, onError: addError),
      );

      /// Looks for the support conversations of the current administrator.
      ///
      /// The ids are diffed against the watched ones: a new conversation is
      /// watched, and a conversation which is no longer mapped to this
      /// administrator is dropped together with its subscription.
      Future<void> discoverSupportConversations({
        required bool reportErrors,
      }) async {
        if (stopped || discovering) return;
        discovering = true;
        try {
          final supportConversationIds =
              await listAdminSupportConversationIds();
          if (stopped) return;

          final wanted = supportConversationIds.toSet();

          // The conversations which are no longer mapped to this
          // administrator are removed from the inbox.
          for (final conversationId in supportSubscriptions.keys.toList()) {
            if (wanted.contains(conversationId)) continue;
            final subscription = supportSubscriptions.remove(conversationId);
            await subscription?.cancel();
            supportConversations.remove(conversationId);
          }

          // The new conversations are watched as exact documents.
          for (final conversationId in wanted) {
            if (stopped) return;
            if (supportSubscriptions.containsKey(conversationId)) continue;
            final supportStream = _firestore
                .collection('conversations')
                .doc(conversationId)
                .snapshots();
            supportSubscriptions[conversationId] = supportStream.listen((
              snapshot,
            ) {
              final conversation = _parseConversation(snapshot);
              if (conversation == null) {
                supportConversations.remove(conversationId);
              } else {
                supportConversations[conversationId] = conversation;
              }
              emitConversations();
            }, onError: addError);
          }
          emitConversations();
        } catch (error, stackTrace) {
          if (reportErrors) {
            addError(error, stackTrace);
          } else {
            // A failed refresh must not empty the inbox. The next refresh
            // tries again.
            AppLogger.warning(
              'Could not refresh the administrator inbox',
              error: error,
            );
          }
        } finally {
          discovering = false;
        }
      }

      unawaited(discoverSupportConversations(reportErrors: true));

      // The inbox keeps looking for new support conversations while it is
      // open. Without it a conversation which was created after the inbox
      // was mounted stayed invisible until the app was restarted.
      final discoveryTimer = Timer.periodic(
        adminSupportDiscoveryInterval,
        (_) => unawaited(discoverSupportConversations(reportErrors: false)),
      );

      controller.onCancel = () async {
        stopped = true;
        discoveryTimer.cancel();
        for (final subscription in subscriptions) {
          await subscription.cancel();
        }
        for (final subscription in supportSubscriptions.values) {
          await subscription.cancel();
        }
        supportSubscriptions.clear();
      };
    });
  }

  /// How often the administrator inbox looks for new support conversations.
  ///
  /// The support conversations cannot be queried directly — their public
  /// participant list contains an opaque identity instead of the
  /// administrator's real uid — so the client asks the trusted server for
  /// the ids of the conversations which are mapped to it.
  @visibleForTesting
  Duration get adminSupportDiscoveryInterval => const Duration(seconds: 30);

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

    // An administrator-support channel is written by the trusted server
    // route only. The server validates the live support target, the durable
    // administrator mapping and the live mapped administrator, and it writes
    // the message, the preview and the unread counters in one transaction.
    // A direct client write could forge a preview or move an unread counter
    // without a message.
    final conversationSnapshot = await conversationRef.get();
    final conversationData = conversationSnapshot.data();
    final isAdminSupport =
        conversationData?['conversationType'] == 'adminSupport' &&
        conversationData?['adminId'] == adminSupportIdentity;
    if (isAdminSupport) {
      await _sendAdminSupportReply(
        conversationId: conversationId,
        content: content,
      );
      return;
    }

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

  /// Sends a reply to the administrator of a support channel.
  ///
  /// The server owns the message, the preview and the unread counters, so a
  /// retry with the same request id cannot create a second message.
  Future<void> _sendAdminSupportReply({
    required String conversationId,
    required String content,
  }) async {
    final body = content.trim();
    if (body.isEmpty) throw Exception('Enter a message');

    final requestId = _supportReplyRequestTracker.requestIdFor(
      body,
      scope: conversationId,
    );
    await _functions.callFunction(
      'sendAdminSupportReply',
      parameters: {
        'conversationId': conversationId,
        'content': body,
        'requestId': requestId,
      },
    );
    _supportReplyRequestTracker.markSucceeded(body, scope: conversationId);
  }

  /// Creates an idempotency key for one administrator message.
  ///
  /// The key must be reused when the **same** send is retried after a lost
  /// response. Otherwise the server cannot tell a retry from a second
  /// message and may notify the recipient twice.
  String newAdminMessageRequestId() => _uuid.v4();

  /// Sends a verified administrator message to a student or room owner.
  ///
  /// The server owns the conversation id, the sender fields and the verified
  /// administrator marker. The client cannot make an ordinary message look
  /// as if the administrator had sent it.
  Future<AdminMessageResult> sendAdminMessage({
    required String userId,
    required String content,
    required String requestId,
  }) async {
    final targetUid = userId.trim();
    final body = content.trim();
    final key = requestId.trim();
    if (targetUid.isEmpty || body.isEmpty || key.isEmpty) {
      throw Exception('The recipient and message are required.');
    }
    if (body.length > 1000) {
      throw Exception('A message can be at most 1000 characters long');
    }

    final data = await _callInteraction(
      'sendAdminMessage',
      parameters: {'userId': targetUid, 'content': body, 'requestId': key},
      fallbackMessage: 'Could not send the administrator message',
    );
    return AdminMessageResult.fromJson(data);
  }

  /// Resets the unread counter of the current user for [conversationId].
  Future<void> markConversationRead(String conversationId) async {
    final uid = _uid;
    if (uid == null) return;

    final ref = _firestore.collection('conversations').doc(conversationId);
    try {
      final preliminarySnapshot = await ref.get();
      if (!preliminarySnapshot.exists) return;
      final preliminaryData = preliminarySnapshot.data();
      final isAdminSupport =
          preliminaryData?['conversationType'] == 'adminSupport' &&
          preliminaryData?['adminId'] == adminSupportIdentity;

      // A support channel is written by trusted callables only. The trusted
      // server clears exactly the caller's own counter: the opaque
      // administrator key for the mapped administrator and the ordinary uid
      // key for the support target.
      if (isAdminSupport) {
        await _callInteraction(
          'markAdminSupportConversationRead',
          parameters: {'conversationId': conversationId},
          fallbackMessage: 'Could not mark the administrator message as read',
        );
        return;
      }

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

  /// Loads the support conversations mapped to the current administrator.
  ///
  /// It is public so that a test can replace the discovery of the trusted
  /// server with a deterministic list of ids.
  Future<List<String>> listAdminSupportConversationIds() async {
    final data = await _callInteraction(
      'listAdminSupportConversations',
      parameters: const {},
      fallbackMessage: 'Could not load administrator conversations',
    );
    final rawIds = data['conversationIds'];
    if (rawIds is! List) {
      throw Exception('The server returned an invalid administrator inbox.');
    }

    final ids = <String>[];
    final seen = <String>{};
    for (final value in rawIds) {
      if (value is! String) continue;
      final id = value.trim();
      if (id.isEmpty || !seen.add(id)) continue;
      ids.add(id);
    }
    return ids;
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

      final conversation = _parseConversation(snapshot);
      final peerId = conversation?.getPeerForViewer(uid);
      return peerId?.isNotEmpty == true ? peerId : null;
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
