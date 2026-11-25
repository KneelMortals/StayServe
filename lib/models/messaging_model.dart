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

  /// The server-owned kind of conversation.
  ///
  /// Ordinary student-owner chats use `booking`. A conversation created by
  /// `sendAdminMessage` uses `adminSupport` and contains one live
  /// administrator and one student or owner.
  final String conversationType;

  /// The administrator who owns an [isAdminSupport] conversation.
  final String? adminId;

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
    this.conversationType = 'booking',
    this.adminId,
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
      conversationType:
          (json['conversationType'] as String?)?.trim().toLowerCase() ??
          'booking',
      adminId: json['adminId'] as String?,
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
      'conversationType': conversationType,
      'adminId': adminId,
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
    String? conversationType,
    String? adminId,
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
      conversationType: conversationType ?? this.conversationType,
      adminId: adminId ?? this.adminId,
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

  /// Whether this is a server-created administrator support conversation.
  ///
  /// The administrator id must also be one of the participants. A malformed
  /// or legacy document with only a type label is not allowed to render the
  /// verified administrator identity.
  bool get isAdminSupport {
    final verifiedAdminId = adminId?.trim();
    return conversationType.trim().toLowerCase() == 'adminsupport' &&
        (verifiedAdminId?.isNotEmpty ?? false) &&
        participants.contains(verifiedAdminId);
  }

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
            conversationType == other.conversationType &&
            adminId == other.adminId &&
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
    conversationType,
    adminId,
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

  /// The server-owned kind of sender.
  ///
  /// It is `admin` only for a message created by `sendAdminMessage`; an
  /// ordinary participant message keeps the default `user` value.
  final String senderType;

  /// Whether the server verified that [adminId] is a live administrator.
  final bool adminVerified;

  /// The uid of the verified administrator who sent this message.
  final String? adminId;

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
    this.senderType = 'user',
    this.adminVerified = false,
    this.adminId,
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
      senderType:
          (json['senderType'] as String?)?.trim().toLowerCase() ?? 'user',
      adminVerified: json['adminVerified'] == true,
      adminId: json['adminId'] as String?,
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
      // The administrator markers are deliberately **not** serialized.
      // This map is the client-created message schema accepted by the
      // Firestore rules; only trusted server code may add those markers.
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
    String? senderType,
    bool? adminVerified,
    String? adminId,
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
      senderType: senderType ?? this.senderType,
      adminVerified: adminVerified ?? this.adminVerified,
      adminId: adminId ?? this.adminId,
    );
  }

  bool get isRead => readAt != null;
  bool get isImage => type == MessageType.image;
  bool get isContactShare => type == MessageType.contactShare;

  /// Whether this message carries the server-owned administrator badge.
  ///
  /// The sender type, verification marker and administrator id must all be
  /// present, and the administrator id must be the actual sender. A message
  /// which merely calls its sender `admin` is not shown as an administrator
  /// message.
  bool get isVerifiedAdminMessage {
    final verifiedAdminId = adminId?.trim();
    return senderType == 'admin' &&
        adminVerified &&
        (verifiedAdminId?.isNotEmpty ?? false) &&
        senderId == verifiedAdminId;
  }

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
            imageUrl == other.imageUrl &&
            senderType == other.senderType &&
            adminVerified == other.adminVerified &&
            adminId == other.adminId;
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
    senderType,
    adminVerified,
    adminId,
  );

  @override
  String toString() {
    return 'MessageModel(messageId: $messageId, conversationId: $conversationId, '
        'senderId: $senderId, receiverId: $receiverId, content: $content, '
        'type: $type, createdAt: $createdAt, readAt: $readAt, '
        'roomId: $roomId, imageUrl: $imageUrl)';
  }
}

/// The server's result for an administrator support message.
class AdminMessageResult {
  final String conversationId;
  final String messageId;
  final String peerId;
  final String peerName;
  final String peerRole;
  final bool alreadySent;

  const AdminMessageResult({
    required this.conversationId,
    required this.messageId,
    required this.peerId,
    required this.peerName,
    this.peerRole = '',
    this.alreadySent = false,
  });

  factory AdminMessageResult.fromJson(Map<String, dynamic> json) {
    String requiredString(String key) {
      final value = json[key];
      if (value is! String || value.trim().isEmpty) {
        throw FormatException('Missing $key in the administrator message.');
      }
      return value.trim();
    }

    return AdminMessageResult(
      conversationId: requiredString('conversationId'),
      messageId: requiredString('messageId'),
      peerId: requiredString('peerId'),
      peerName: requiredString('peerName'),
      peerRole: json['peerRole'] is String
          ? (json['peerRole'] as String).trim().toLowerCase()
          : '',
      alreadySent: json['alreadySent'] == true,
    );
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
