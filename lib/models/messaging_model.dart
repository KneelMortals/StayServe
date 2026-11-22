import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import '../../core/constants/enums.dart';

class ConversationModel {
  final String conversationId;
  final List<String> participants;
  final String lastMessage;
  final DateTime lastMessageAt;
  final Map<String, int> unreadCount;
  final String? roomId;

  /// Server-resolved display names keyed by participant uid.
  final Map<String, String> participantNames;

  /// The title of the room/listing which the conversation belongs to.
  final String roomTitle;

  final DateTime createdAt;
  final DateTime updatedAt;

  const ConversationModel({
    required this.conversationId,
    required this.participants,
    required this.lastMessage,
    required this.lastMessageAt,
    required this.unreadCount,
    this.roomId,
    this.participantNames = const {},
    this.roomTitle = '',
    required this.createdAt,
    required this.updatedAt,
  });

  factory ConversationModel.fromJson(Map<String, dynamic> json) {
    return ConversationModel(
      conversationId: json['conversationId'] as String,
      participants:
          (json['participants'] as List<dynamic>?)
              ?.map((e) => e as String)
              .toList() ??
          const [],
      lastMessage: json['lastMessage'] as String? ?? '',
      lastMessageAt: _toDate(json['lastMessageAt']),
      unreadCount: (json['unreadCount'] as Map<String, dynamic>? ?? const {})
          .map((key, value) => MapEntry(key, (value as num).toInt())),
      roomId: json['roomId'] as String?,
      participantNames:
          (json['participantNames'] as Map<String, dynamic>? ?? const {}).map(
            (key, value) => MapEntry(key, value?.toString() ?? ''),
          ),
      roomTitle: json['roomTitle'] as String? ?? '',
      createdAt: _toDate(json['createdAt']),
      updatedAt: _toDate(json['updatedAt']),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'conversationId': conversationId,
      'participants': participants,
      'lastMessage': lastMessage,
      'lastMessageAt': Timestamp.fromDate(lastMessageAt),
      'unreadCount': unreadCount,
      'roomId': roomId,
      'participantNames': participantNames,
      'roomTitle': roomTitle,
      'createdAt': Timestamp.fromDate(createdAt),
      'updatedAt': Timestamp.fromDate(updatedAt),
    };
  }

  ConversationModel copyWith({
    String? conversationId,
    List<String>? participants,
    String? lastMessage,
    DateTime? lastMessageAt,
    Map<String, int>? unreadCount,
    String? roomId,
    Map<String, String>? participantNames,
    String? roomTitle,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) {
    return ConversationModel(
      conversationId: conversationId ?? this.conversationId,
      participants: participants ?? this.participants,
      lastMessage: lastMessage ?? this.lastMessage,
      lastMessageAt: lastMessageAt ?? this.lastMessageAt,
      unreadCount: unreadCount ?? this.unreadCount,
      roomId: roomId ?? this.roomId,
      participantNames: participantNames ?? this.participantNames,
      roomTitle: roomTitle ?? this.roomTitle,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }

  String getOtherParticipant(String currentUserId) {
    return participants.firstWhere(
      (id) => id != currentUserId,
      orElse: () => '',
    );
  }

  int getUnreadCount(String userId) => unreadCount[userId] ?? 0;

  /// The server-resolved display name of one participant.
  String getParticipantName(String userId) {
    final name = participantNames[userId]?.trim() ?? '';
    return name;
  }

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is ConversationModel &&
            runtimeType == other.runtimeType &&
            conversationId == other.conversationId &&
            listEquals(participants, other.participants) &&
            lastMessage == other.lastMessage &&
            lastMessageAt == other.lastMessageAt &&
            mapEquals(unreadCount, other.unreadCount) &&
            roomId == other.roomId &&
            mapEquals(participantNames, other.participantNames) &&
            roomTitle == other.roomTitle &&
            createdAt == other.createdAt &&
            updatedAt == other.updatedAt;
  }

  @override
  int get hashCode => Object.hash(
    conversationId,
    Object.hashAll(participants),
    lastMessage,
    lastMessageAt,
    // The entries are **sorted** before they are hashed.
    //
    // `==` compares the map without an order (`mapEquals`), so two
    // equal conversations have to have the same hash code. The entries
    // of a map keep their insertion order, and the order of the keys is
    // not guaranteed to be the same for two equal maps — so the hash
    // code was different and the models behaved differently in a set
    // or as a key of a map.
    Object.hashAll(
      unreadCount.entries.map((e) => Object.hash(e.key, e.value)).toList()
        ..sort(),
    ),
    roomId,
    Object.hashAll(
      participantNames.entries.map((e) => Object.hash(e.key, e.value)).toList()
        ..sort(),
    ),
    roomTitle,
    createdAt,
    updatedAt,
  );

  @override
  String toString() {
    return 'ConversationModel(conversationId: $conversationId, '
        'participants: $participants, lastMessage: $lastMessage, '
        'lastMessageAt: $lastMessageAt, unreadCount: $unreadCount, '
        'roomId: $roomId, createdAt: $createdAt, updatedAt: $updatedAt)';
  }
}

class MessageModel {
  final String messageId;
  final String conversationId;
  final String senderId;
  final String receiverId;
  final String content;
  final MessageType type;
  final DateTime createdAt;
  final DateTime? readAt;
  final String? roomId;
  final String? imageUrl;

  const MessageModel({
    required this.messageId,
    required this.conversationId,
    required this.senderId,
    required this.receiverId,
    required this.content,
    required this.type,
    required this.createdAt,
    this.readAt,
    this.roomId,
    this.imageUrl,
  });

  factory MessageModel.fromJson(Map<String, dynamic> json) {
    return MessageModel(
      messageId: json['messageId'] as String,
      conversationId: json['conversationId'] as String,
      senderId: json['senderId'] as String,
      receiverId: json['receiverId'] as String,
      content: json['content'] as String? ?? '',
      type: MessageType.values.firstWhere(
        (e) => e.name == json['type'],
        orElse: () => MessageType.text,
      ),
      createdAt: _toDate(json['createdAt']),
      readAt: json['readAt'] == null ? null : _toDate(json['readAt']),
      roomId: json['roomId'] as String?,
      imageUrl: json['imageUrl'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'messageId': messageId,
      'conversationId': conversationId,
      'senderId': senderId,
      'receiverId': receiverId,
      'content': content,
      'type': type.name,
      'createdAt': Timestamp.fromDate(createdAt),
      'readAt': readAt != null ? Timestamp.fromDate(readAt!) : null,
      'roomId': roomId,
      'imageUrl': imageUrl,
    };
  }

  MessageModel copyWith({
    String? messageId,
    String? conversationId,
    String? senderId,
    String? receiverId,
    String? content,
    MessageType? type,
    DateTime? createdAt,
    DateTime? readAt,
    String? roomId,
    String? imageUrl,
  }) {
    return MessageModel(
      messageId: messageId ?? this.messageId,
      conversationId: conversationId ?? this.conversationId,
      senderId: senderId ?? this.senderId,
      receiverId: receiverId ?? this.receiverId,
      content: content ?? this.content,
      type: type ?? this.type,
      createdAt: createdAt ?? this.createdAt,
      readAt: readAt ?? this.readAt,
      roomId: roomId ?? this.roomId,
      imageUrl: imageUrl ?? this.imageUrl,
    );
  }

  bool get isRead => readAt != null;
  bool get isImage => type == MessageType.image;
  bool get isContactShare => type == MessageType.contactShare;

  @override
  bool operator ==(Object other) {
    return identical(this, other) ||
        other is MessageModel &&
            runtimeType == other.runtimeType &&
            messageId == other.messageId &&
            conversationId == other.conversationId &&
            senderId == other.senderId &&
            receiverId == other.receiverId &&
            content == other.content &&
            type == other.type &&
            createdAt == other.createdAt &&
            readAt == other.readAt &&
            roomId == other.roomId &&
            imageUrl == other.imageUrl;
  }

  @override
  int get hashCode => Object.hash(
    messageId,
    conversationId,
    senderId,
    receiverId,
    content,
    type,
    createdAt,
    readAt,
    roomId,
    imageUrl,
  );

  @override
  String toString() {
    return 'MessageModel(messageId: $messageId, conversationId: $conversationId, '
        'senderId: $senderId, receiverId: $receiverId, content: $content, '
        'type: $type, createdAt: $createdAt, readAt: $readAt, '
        'roomId: $roomId, imageUrl: $imageUrl)';
  }
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
