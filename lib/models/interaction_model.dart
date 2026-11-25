/// Server-resolved metadata for a student-owner interaction.
///
/// The ordinary Firestore client cannot read another participant's private
/// profile document. These small models are therefore populated by the
/// interaction Cloud Functions, which resolve only the safe display fields
/// and the current personal-block state.
class ConversationInteractionDetails {
  final String conversationId;
  final String peerId;
  final String peerName;
  final String peerRole;
  final String roomId;
  final String roomTitle;
  final String? requestId;

  /// Whether the current user blocked the other participant.
  final bool blockedByMe;

  /// Whether the other participant blocked the current user.
  final bool blockedMe;

  /// Whether the current user may send a new message.
  final bool canSend;

  /// Whether this is a server-created administrator support conversation.
  final bool isAdminSupport;

  const ConversationInteractionDetails({
    required this.conversationId,
    required this.peerId,
    required this.peerName,
    this.peerRole = '',
    this.roomId = '',
    this.roomTitle = '',
    this.requestId,
    this.blockedByMe = false,
    this.blockedMe = false,
    this.canSend = true,
    this.isAdminSupport = false,
  });

  bool get isBlocked => !canSend;

  factory ConversationInteractionDetails.fromJson(Map<String, dynamic> json) {
    final blockedByMe = _requiredBool(
      json['blockedByMe'] ?? json['blockedByCaller'],
      'blockedByMe',
    );
    final blockedMe = _requiredBool(
      json['blockedMe'] ?? json['callerBlockedByPeer'],
      'blockedMe',
    );
    return ConversationInteractionDetails(
      conversationId: _requiredString(json['conversationId'], 'conversationId'),
      peerId: _requiredString(json['peerId'], 'peerId'),
      peerName: _readString(json['peerName']),
      peerRole: _readString(json['peerRole']),
      roomId: _readString(json['roomId']),
      roomTitle: _readString(json['roomTitle']),
      requestId: _readNullableString(json['requestId']),
      blockedByMe: blockedByMe,
      blockedMe: blockedMe,
      canSend: _requiredBool(json['canSend'], 'canSend'),
      isAdminSupport: json['isAdminSupport'] == true,
    );
  }
}

/// Server-resolved metadata for one booking request.
class BookingInteractionDetails {
  final String requestId;
  final String studentId;
  final String ownerId;
  final String studentName;
  final String ownerName;
  final String roomId;
  final String roomTitle;

  /// Whether the current user blocked the other participant.
  final bool blockedByMe;

  /// Whether the other participant blocked the current user.
  final bool blockedMe;

  /// Whether the current participant may continue the booking interaction.
  final bool canSend;

  const BookingInteractionDetails({
    required this.requestId,
    required this.studentId,
    required this.ownerId,
    required this.studentName,
    required this.ownerName,
    this.roomId = '',
    this.roomTitle = '',
    this.blockedByMe = false,
    this.blockedMe = false,
    this.canSend = true,
  });

  bool get isBlocked => !canSend;

  factory BookingInteractionDetails.fromJson(Map<String, dynamic> json) {
    final blockedByMe = _requiredBool(
      json['blockedByMe'] ?? json['blockedByCaller'],
      'blockedByMe',
    );
    final blockedMe = _requiredBool(
      json['blockedMe'] ?? json['callerBlockedByPeer'],
      'blockedMe',
    );
    return BookingInteractionDetails(
      requestId: _requiredString(json['requestId'], 'requestId'),
      studentId: _requiredString(json['studentId'], 'studentId'),
      ownerId: _requiredString(json['ownerId'], 'ownerId'),
      studentName: _readString(json['studentName']),
      ownerName: _readString(json['ownerName']),
      roomId: _readString(json['roomId']),
      roomTitle: _readString(json['roomTitle']),
      blockedByMe: blockedByMe,
      blockedMe: blockedMe,
      canSend: _requiredBool(json['canSend'], 'canSend'),
    );
  }
}

/// The safe owner contact details shown before a student books a room.
class RoomContactDetails {
  final String roomId;
  final String roomTitle;
  final String ownerId;
  final String ownerName;

  /// Whether the current student blocked the owner.
  final bool blockedByMe;

  /// Whether the owner blocked the current student.
  final bool blockedMe;

  /// Whether the student may start or continue a conversation.
  final bool canContact;

  const RoomContactDetails({
    required this.roomId,
    required this.roomTitle,
    required this.ownerId,
    required this.ownerName,
    this.blockedByMe = false,
    this.blockedMe = false,
    this.canContact = true,
  });

  bool get canSend => canContact;
  bool get isBlocked => !canContact;

  factory RoomContactDetails.fromJson(Map<String, dynamic> json) {
    final blockedByMe = _requiredBool(
      json['blockedByMe'] ?? json['blockedByCaller'],
      'blockedByMe',
    );
    final blockedMe = _requiredBool(
      json['blockedMe'] ?? json['callerBlockedByPeer'],
      'blockedMe',
    );
    final canContact = _requiredBool(
      json['canContact'] ?? json['canSend'],
      'canContact',
    );
    return RoomContactDetails(
      roomId: _requiredString(json['roomId'], 'roomId'),
      roomTitle: _readString(json['roomTitle']),
      ownerId: _requiredString(json['ownerId'], 'ownerId'),
      ownerName: _readString(json['ownerName']),
      blockedByMe: blockedByMe,
      blockedMe: blockedMe,
      canContact: canContact,
    );
  }
}

/// The result of opening a verified conversation.
class ConversationOpenResult {
  final String conversationId;
  final String peerId;
  final String peerName;
  final String peerRole;
  final String roomId;
  final String roomTitle;
  final String? requestId;
  final bool blockedByMe;
  final bool blockedMe;
  final bool canSend;

  const ConversationOpenResult({
    required this.conversationId,
    required this.peerId,
    required this.peerName,
    this.peerRole = '',
    this.roomId = '',
    this.roomTitle = '',
    this.requestId,
    this.blockedByMe = false,
    this.blockedMe = false,
    this.canSend = true,
  });

  factory ConversationOpenResult.fromJson(Map<String, dynamic> json) {
    final blockedByMe = _requiredBool(
      json['blockedByMe'] ?? json['blockedByCaller'],
      'blockedByMe',
    );
    final blockedMe = _requiredBool(
      json['blockedMe'] ?? json['callerBlockedByPeer'],
      'blockedMe',
    );
    return ConversationOpenResult(
      conversationId: _requiredString(json['conversationId'], 'conversationId'),
      peerId: _requiredString(json['peerId'], 'peerId'),
      peerName: _readString(json['peerName']),
      peerRole: _readString(json['peerRole']),
      roomId: _readString(json['roomId']),
      roomTitle: _readString(json['roomTitle']),
      requestId: _readNullableString(json['requestId']),
      blockedByMe: blockedByMe,
      blockedMe: blockedMe,
      canSend: _requiredBool(json['canSend'], 'canSend'),
    );
  }
}

/// The result of blocking or unblocking another participant.
class UserBlockResult {
  final String otherUserId;
  final String otherName;
  final bool blockedByMe;
  final bool blockedMe;
  final bool canSend;

  const UserBlockResult({
    required this.otherUserId,
    required this.otherName,
    this.blockedByMe = false,
    this.blockedMe = false,
    this.canSend = true,
  });

  factory UserBlockResult.fromJson(Map<String, dynamic> json) {
    final blockedByMe = _requiredBool(
      json['blockedByMe'] ?? json['blockedByCaller'],
      'blockedByMe',
    );
    final blockedMe = _requiredBool(
      json['blockedMe'] ?? json['callerBlockedByPeer'],
      'blockedMe',
    );
    return UserBlockResult(
      otherUserId: _requiredString(json['otherUserId'], 'otherUserId'),
      otherName: _readString(json['otherName']),
      blockedByMe: blockedByMe,
      blockedMe: blockedMe,
      canSend: _requiredBool(json['canSend'], 'canSend'),
    );
  }
}

String _readString(dynamic value) {
  return value is String ? value.trim() : '';
}

String? _readNullableString(dynamic value) {
  if (value is! String) return null;
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}

String _requiredString(dynamic value, String field) {
  final text = _readString(value);
  if (text.isEmpty) {
    throw FormatException('Missing $field in the interaction response.');
  }
  return text;
}

bool _requiredBool(dynamic value, String field) {
  if (value is bool) return value;
  throw FormatException('Missing $field in the interaction response.');
}
