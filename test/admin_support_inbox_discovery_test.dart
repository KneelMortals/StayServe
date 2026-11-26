import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/firebase/messaging/conversation_repository.dart';
import 'package:stayserve/models/messaging_model.dart';

import 'support/auth_identity_fakes.dart';
import 'support/conversation_inbox_fakes.dart';

/// The inbox of the administrator with a short discovery interval.
class _InboxRepository extends ConversationRepository {
  _InboxRepository({
    required FakeInboxFirestore firestore,
    required MockFirebaseAuth auth,
    required this.supportConversationIds,
  }) : super(
         firestore: firestore,
         auth: auth,
         functions: RecordingFunctionsService(),
       );

  /// The ids which the trusted server reports for this administrator.
  final List<String> supportConversationIds;

  /// Whether the discovery of the trusted server fails.
  bool failDiscovery = false;

  @override
  Duration get adminSupportDiscoveryInterval =>
      const Duration(milliseconds: 40);

  @override
  Future<List<String>> listAdminSupportConversationIds() async {
    if (failDiscovery) throw Exception('the server is unavailable');
    return List<String>.from(supportConversationIds);
  }
}

Map<String, dynamic> _conversationData(String conversationId) {
  final now = Timestamp.fromDate(DateTime.utc(2026, 1, 1));
  return <String, dynamic>{
    'conversationId': conversationId,
    'participantIds': const [adminSupportIdentity, 'student-1'],
    'lastMessage': 'Please update your room details.',
    'lastMessageAt': now,
    'unreadCount': const <String, dynamic>{'student-1': 1},
    'conversationType': 'adminSupport',
    'adminId': adminSupportIdentity,
    'roomId': '',
    'roomTitle': 'StayServe Support',
    'createdAt': now,
    'updatedAt': now,
  };
}

void main() {
  group('the administrator support inbox', () {
    test(
      'finds a support conversation which was created while it was open',
      () async {
        final firestore = FakeInboxFirestore();
        final repository = _InboxRepository(
          firestore: firestore,
          auth: MockFirebaseAuth(
            signedIn: true,
            mockUser: MockUser(uid: 'admin-1'),
          ),
          supportConversationIds: ['conversation-1'],
        );
        firestore.putConversation(
          'conversation-1',
          _conversationData('conversation-1'),
        );

        final seen = <List<ConversationModel>>[];
        final subscription = repository
            .watchConversations(includeAdminSupport: true)
            .listen(seen.add);
        addTearDown(subscription.cancel);

        await Future<void>.delayed(const Duration(milliseconds: 120));

        expect(
          seen.last.map((conversation) => conversation.conversationId),
          contains('conversation-1'),
          reason: 'the known support conversation has to be shown',
        );

        // A new support conversation arrives while the inbox is open.
        repository.supportConversationIds.add('conversation-2');
        firestore.putConversation(
          'conversation-2',
          _conversationData('conversation-2'),
        );

        await Future<void>.delayed(const Duration(milliseconds: 200));

        expect(
          seen.last.map((conversation) => conversation.conversationId),
          contains('conversation-2'),
          reason: 'the inbox has to look for new support conversations',
        );

        // The administrator is no longer mapped to the first conversation.
        repository.supportConversationIds.remove('conversation-1');

        await Future<void>.delayed(const Duration(milliseconds: 200));

        expect(
          seen.last.map((conversation) => conversation.conversationId),
          isNot(contains('conversation-1')),
          reason: 'a conversation which is no longer mapped has to disappear',
        );
        expect(
          seen.last.map((conversation) => conversation.conversationId),
          contains('conversation-2'),
        );
      },
    );

    test('keeps the inbox alive when a refresh fails', () async {
      final firestore = FakeInboxFirestore();
      final repository = _InboxRepository(
        firestore: firestore,
        auth: MockFirebaseAuth(
          signedIn: true,
          mockUser: MockUser(uid: 'admin-1'),
        ),
        supportConversationIds: ['conversation-1'],
      );
      firestore.putConversation(
        'conversation-1',
        _conversationData('conversation-1'),
      );

      final seen = <List<ConversationModel>>[];
      final errors = <Object>[];
      final subscription = repository
          .watchConversations(includeAdminSupport: true)
          .listen(seen.add, onError: errors.add);
      addTearDown(subscription.cancel);

      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(seen, isNotEmpty);
      expect(errors, isEmpty);

      // The discovery fails from now on. The inbox must keep the
      // conversations it already knows.
      repository.failDiscovery = true;

      await Future<void>.delayed(const Duration(milliseconds: 200));

      expect(
        seen.last.map((conversation) => conversation.conversationId),
        contains('conversation-1'),
      );
      expect(
        errors,
        isEmpty,
        reason: 'a failed refresh must not empty the inbox',
      );
    });
  });
}
