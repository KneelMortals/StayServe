import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/messaging/presentation/providers/messaging_providers.dart';
import 'package:stayserve/features/messaging/presentation/screens/chat_screen.dart';
import 'package:stayserve/firebase/messaging/conversation_repository.dart';
import 'package:stayserve/firebase/reviews/review_repository.dart';
import 'package:stayserve/models/interaction_model.dart';
import 'package:stayserve/models/messaging_model.dart';

import 'support/auth_identity_fakes.dart';

MessageModel _message({
  String messageId = 'message-1',
  String senderId = adminSupportIdentity,
  String receiverId = 'student-1',
  String senderType = 'admin',
  bool adminVerified = true,
  String? adminId = adminSupportIdentity,
}) {
  return MessageModel.fromJson({
    'messageId': messageId,
    'conversationId': 'conversation-1',
    'senderId': senderId,
    'receiverId': receiverId,
    'content': 'We will help with this.',
    'type': 'text',
    'createdAt': DateTime.utc(2026, 1, 1),
    'senderType': senderType,
    'adminVerified': adminVerified,
    'adminId': adminId,
  });
}

class _AdminChatRepository extends ConversationRepository {
  _AdminChatRepository()
    : super(
        firestore: IdentityFakeFirestore(),
        auth: MockFirebaseAuth(),
        functions: RecordingFunctionsService(),
      );

  final List<Map<String, String>> adminSends = [];
  final List<Map<String, String>> ordinarySends = [];

  int _nextRequestId = 0;
  int failuresBeforeSuccess = 0;

  @override
  String newAdminMessageRequestId() => 'request-${++_nextRequestId}';

  @override
  Future<AdminMessageResult> sendAdminMessage({
    required String userId,
    required String content,
    required String requestId,
  }) async {
    adminSends.add({
      'userId': userId,
      'content': content,
      'requestId': requestId,
    });
    if (failuresBeforeSuccess > 0) {
      failuresBeforeSuccess--;
      throw Exception('the response was lost');
    }
    return AdminMessageResult(
      conversationId: 'conversation-1',
      messageId: 'message-2',
      peerId: userId,
      peerName: 'Student',
      peerRole: 'student',
    );
  }

  @override
  Future<void> sendMessage({
    required String conversationId,
    required String receiverId,
    required String content,
    MessageType type = MessageType.text,
    String? roomId,
    String? imageUrl,
  }) async {
    ordinarySends.add({
      'conversationId': conversationId,
      'receiverId': receiverId,
      'content': content,
    });
  }

  @override
  Future<ConversationInteractionDetails> getConversationInteractionDetails(
    String conversationId, {
    String? roomId,
    String? requestId,
  }) async {
    return ConversationInteractionDetails(
      conversationId: conversationId,
      peerId: 'student-1',
      peerName: 'Student',
      peerRole: 'student',
      roomTitle: 'StayServe Support',
      canSend: true,
      isAdminSupport: true,
    );
  }

  @override
  Future<void> markConversationRead(String conversationId) async {}
}

void main() {
  group('administrator message idempotency', () {
    test('uses one request id for whitespace-only edits and retries', () {
      var nextId = 0;
      final tracker = AdminMessageRequestTracker(() => 'request-${++nextId}');

      final first = tracker.requestIdFor('Please review this room.');
      expect(tracker.requestIdFor(' Please review this room. '), first);
      expect(tracker.requestIdFor('Please review this room.'), first);

      tracker.markSucceeded('Please review this room.');
      expect(tracker.requestIdFor('Please review this room.'), isNot(first));
    });

    test('releases a successful id when the admin returns to earlier text', () {
      var nextId = 0;
      final tracker = AdminMessageRequestTracker(() => 'request-${++nextId}');

      final first = tracker.requestIdFor('First message');
      tracker.markSucceeded('First message');
      final second = tracker.requestIdFor('Second message');
      tracker.markSucceeded('Second message');
      expect(second, isNot(first));
      expect(tracker.requestIdFor('First message'), isNot(first));
    });

    test('scopes the request id by the recipient', () {
      var nextId = 0;
      final tracker = AdminMessageRequestTracker(() => 'request-${++nextId}');

      final first = tracker.requestIdFor(
        'Please review this room.',
        scope: 'conversation-a',
      );
      final second = tracker.requestIdFor(
        'Please review this room.',
        scope: 'conversation-b',
      );
      expect(second, isNot(first));

      // A successful send in one conversation must not release the pending
      // key of the same text in another conversation.
      tracker.markSucceeded(
        'Please review this room.',
        scope: 'conversation-a',
      );
      expect(
        tracker.requestIdFor(
          'Please review this room.',
          scope: 'conversation-b',
        ),
        second,
      );
      expect(
        tracker.requestIdFor(
          'Please review this room.',
          scope: 'conversation-a',
        ),
        isNot(first),
      );
    });
  });

  group('verified administrator message model', () {
    test('requires all server-owned marker facts and the real sender', () {
      expect(_message().isVerifiedAdminMessage, isTrue);
      expect(_message(senderType: 'user').isVerifiedAdminMessage, isFalse);
      expect(_message(adminVerified: false).isVerifiedAdminMessage, isFalse);
      expect(_message(adminId: null).isVerifiedAdminMessage, isFalse);
      expect(_message(adminId: '').isVerifiedAdminMessage, isFalse);
      expect(_message(senderId: 'student-1').isVerifiedAdminMessage, isFalse);
    });

    test('uses the complete marker to align an opaque administrator reply', () {
      expect(_message().isOwnedByViewer('admin-1'), isTrue);
      expect(_message().isOwnedByViewer('student-1'), isFalse);
      expect(_message(senderType: 'user').isOwnedByViewer('admin-1'), isFalse);
    });

    test('does not serialize the administrator markers to a client write', () {
      final json = _message().toJson();
      expect(json.containsKey('senderType'), isFalse);
      expect(json.containsKey('adminVerified'), isFalse);
      expect(json.containsKey('adminId'), isFalse);
    });

    test('recognises a server-created administrator support conversation', () {
      final conversation = ConversationModel.fromJson({
        'conversationId': 'conversation-1',
        'participants': [adminSupportIdentity, 'student-1'],
        'lastMessage': 'We will help with this.',
        'lastMessageAt': DateTime.utc(2026, 1, 1),
        'unreadCount': {adminSupportIdentity: 2, 'student-1': 1},
        'conversationType': 'adminSupport',
        'adminId': adminSupportIdentity,
        'roomId': '',
        'roomTitle': 'StayServe Support',
        'createdAt': DateTime.utc(2026, 1, 1),
        'updatedAt': DateTime.utc(2026, 1, 1),
      });

      expect(conversation.isAdminSupport, isTrue);
      expect(conversation.getParticipantName('student-1'), isEmpty);
      expect(conversation.getPeerForViewer('admin-1'), 'student-1');
      expect(conversation.getPeerForViewer('student-1'), adminSupportIdentity);
      expect(conversation.getUnreadCountForViewer('admin-1'), 2);
      expect(conversation.getUnreadCountForViewer('student-1'), 1);
    });

    test('does not trust an administrator marker without that participant', () {
      final malformed = ConversationModel.fromJson({
        'conversationId': 'conversation-1',
        'participants': ['student-1'],
        'lastMessage': '',
        'lastMessageAt': DateTime.utc(2026, 1, 1),
        'unreadCount': {'student-1': 0},
        'conversationType': 'adminSupport',
        'adminId': 'admin-1',
        'roomId': '',
        'roomTitle': 'StayServe Support',
        'createdAt': DateTime.utc(2026, 1, 1),
        'updatedAt': DateTime.utc(2026, 1, 1),
      });

      expect(malformed.isAdminSupport, isFalse);
    });
  });

  group('administrator repositories', () {
    test(
      'sends an administrator message through the trusted callable',
      () async {
        final functions = RecordingFunctionsService(
          payloads: {
            'sendAdminMessage': {
              'conversationId': 'conversation-1',
              'messageId': 'message-1',
              'peerId': 'student-1',
              'peerName': 'Student',
              'peerRole': 'student',
              'alreadySent': false,
            },
          },
        );
        final repository = ConversationRepository(
          firestore: IdentityFakeFirestore(),
          auth: MockFirebaseAuth(),
          functions: functions,
        );

        final result = await repository.sendAdminMessage(
          userId: 'student-1',
          content: 'Please send the room details.',
          requestId: 'request-1',
        );

        expect(functions.callNames, ['sendAdminMessage']);
        expect(functions.callParameters.single, {
          'userId': 'student-1',
          'content': 'Please send the room details.',
          'requestId': 'request-1',
        });
        expect(result.conversationId, 'conversation-1');
        expect(result.alreadySent, isFalse);
      },
    );

    test('reads room reviews through the server-scoped callable', () async {
      final functions = RecordingFunctionsService(
        payloads: {
          'getRoomReviews': {
            'success': true,
            'roomId': 'room-1',
            'reviews': [
              {
                'reviewId': 'PUBLIC-review',
                'reviewInstanceId': 'review-instance-1',
                'roomId': 'room-1',
                'studentId': '',
                'ownerId': 'owner-1',
                'rating': 5,
                'comment': 'A room review',
                'studentName': 'A student',
                'createdAt': 1765689600000,
                'updatedAt': 1765689600000,
              },
            ],
          },
        },
      );
      final repository = ReviewRepository(
        auth: MockFirebaseAuth(),
        functions: functions,
      );

      final reviews = await repository.getRoomReviews('room-1');

      expect(functions.callNames, ['getRoomReviews']);
      expect(functions.callParameters.single, {'roomId': 'room-1'});
      expect(reviews, hasLength(1));
      expect(reviews.single.reviewInstanceId, 'review-instance-1');
      expect(reviews.single.studentId, isEmpty);
      expect(reviews.single.studentName, 'A student');
    });

    test('binds review edits and deletes to the observed lifecycle', () async {
      final functions = RecordingFunctionsService(
        payloads: {
          'submitRoomReview': {
            'success': true,
            'reviewId': 'review-1',
            'reviewInstanceId': 'review-instance-2',
          },
        },
      );
      final repository = ReviewRepository(
        auth: MockFirebaseAuth(),
        functions: functions,
      );

      final submitted = await repository.submitReview(
        roomId: 'room-1',
        rating: 5,
        comment: '  Updated review  ',
        expectedReviewInstanceId: 'review-instance-1',
      );
      await repository.deleteReview(
        roomId: 'room-1',
        reviewInstanceId: 'review-instance-2',
      );

      expect(functions.callNames, ['submitRoomReview', 'deleteRoomReview']);
      expect(functions.callParameters.first, {
        'roomId': 'room-1',
        'rating': 5,
        'comment': 'Updated review',
        'expectedReviewInstanceId': 'review-instance-1',
      });
      expect(functions.callParameters.last, {
        'roomId': 'room-1',
        'expectedReviewInstanceId': 'review-instance-2',
      });
      expect(submitted.reviewId, 'review-1');
      expect(submitted.reviewInstanceId, 'review-instance-2');
    });

    test(
      'deletes an arbitrary review and preserves idempotent completion',
      () async {
        final functions = RecordingFunctionsService(
          payloads: {
            'deleteAnyRoomReview': {
              'success': true,
              'reviewId': 'review-1',
              'alreadyDeleted': true,
            },
          },
        );
        final repository = ReviewRepository(
          auth: MockFirebaseAuth(),
          functions: functions,
        );

        final result = await repository.deleteReviewAsAdmin(
          reviewId: 'review-1',
          reviewInstanceId: 'review-instance-1',
        );

        expect(functions.callNames, ['deleteAnyRoomReview']);
        expect(functions.callParameters.single, {
          'reviewId': 'review-1',
          'expectedReviewInstanceId': 'review-instance-1',
        });
        expect(result.reviewId, 'review-1');
        expect(result.alreadyDeleted, isTrue);
      },
    );
  });

  testWidgets(
    'an unresolved administrator send keeps its request id until success',
    (tester) async {
      final repository = _AdminChatRepository()..failuresBeforeSuccess = 1;
      final admin = MockUser(uid: 'admin-1', email: 'admin@example.test');
      final router = GoRouter(
        initialLocation: '/chat/conversation-1?peer=student-1',
        routes: [
          GoRoute(
            path: '/chat/:conversationId',
            builder: (context, state) => ChatScreen(
              conversationId: state.pathParameters['conversationId']!,
              peerId: state.uri.queryParameters['peer'],
            ),
          ),
        ],
      );
      addTearDown(router.dispose);

      final conversation = ConversationModel(
        conversationId: 'conversation-1',
        participants: const [adminSupportIdentity, 'student-1'],
        lastMessage: 'We will help with this.',
        lastMessageAt: DateTime.utc(2026, 1, 1),
        unreadCount: const {adminSupportIdentity: 0, 'student-1': 0},
        conversationType: 'adminSupport',
        adminId: adminSupportIdentity,
        roomTitle: 'StayServe Support',
        createdAt: DateTime.utc(2026, 1, 1),
        updatedAt: DateTime.utc(2026, 1, 1),
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(admin),
            currentUserRoleProvider.overrideWithValue(UserRole.admin),
            conversationRepositoryProvider.overrideWithValue(repository),
            conversationsProvider.overrideWith(
              (ref) => Stream.value([conversation]),
            ),
            messagesProvider.overrideWith(
              (ref, conversationId) => Stream.value([_message()]),
            ),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      const content = 'Please keep the same request id for this retry.';
      await tester.enterText(find.byType(TextField), content);
      await tester.ensureVisible(find.byIcon(Icons.send));
      await tester.tap(find.byIcon(Icons.send));
      await tester.pumpAndSettle();
      expect(repository.adminSends, hasLength(1));
      expect(repository.adminSends.single['requestId'], 'request-1');

      // Let the error snack bar leave the send button before retrying.
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();

      // The first response was lost. The retry must use the same id.
      await tester.ensureVisible(find.byIcon(Icons.send));
      await tester.tap(find.byIcon(Icons.send));
      await tester.pumpAndSettle();
      expect(repository.adminSends, hasLength(2));
      expect(repository.adminSends[1]['requestId'], 'request-1');

      // A confirmed send releases the id, so deliberately sending the same
      // text again is a new message rather than an idempotent replay.
      await tester.enterText(find.byType(TextField), content);
      await tester.ensureVisible(find.byIcon(Icons.send));
      await tester.tap(find.byIcon(Icons.send));
      await tester.pumpAndSettle();
      expect(repository.adminSends, hasLength(3));
      expect(repository.adminSends[2]['requestId'], 'request-2');
    },
  );

  testWidgets(
    'an administrator reply uses the verified server path and badge',
    (tester) async {
      final repository = _AdminChatRepository();
      final admin = MockUser(uid: 'admin-1', email: 'admin@example.test');
      final router = GoRouter(
        initialLocation: '/chat/conversation-1?peer=student-1',
        routes: [
          GoRoute(
            path: '/chat/:conversationId',
            builder: (context, state) => ChatScreen(
              conversationId: state.pathParameters['conversationId']!,
              peerId: state.uri.queryParameters['peer'],
            ),
          ),
        ],
      );
      addTearDown(router.dispose);

      final conversation = ConversationModel(
        conversationId: 'conversation-1',
        participants: const [adminSupportIdentity, 'student-1'],
        lastMessage: 'We will help with this.',
        lastMessageAt: DateTime.utc(2026, 1, 1),
        unreadCount: const {adminSupportIdentity: 0, 'student-1': 0},
        conversationType: 'adminSupport',
        adminId: adminSupportIdentity,
        roomTitle: 'StayServe Support',
        createdAt: DateTime.utc(2026, 1, 1),
        updatedAt: DateTime.utc(2026, 1, 1),
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(admin),
            currentUserRoleProvider.overrideWithValue(UserRole.admin),
            conversationRepositoryProvider.overrideWithValue(repository),
            conversationsProvider.overrideWith(
              (ref) => Stream.value([conversation]),
            ),
            messagesProvider.overrideWith(
              (ref, conversationId) => Stream.value([
                _message(),
                _message(
                  messageId: 'tenant-message',
                  senderId: 'student-1',
                  receiverId: adminSupportIdentity,
                  senderType: 'user',
                  adminVerified: false,
                  adminId: null,
                ),
              ]),
            ),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      final administratorBubble = tester.widget<Align>(
        find.byKey(const ValueKey('message-bubble-message-1')),
      );
      expect(
        administratorBubble.alignment,
        Alignment.centerRight,
        reason: 'the mapped administrator owns the opaque verified message',
      );
      final tenantBubble = tester.widget<Align>(
        find.byKey(const ValueKey('message-bubble-tenant-message')),
      );
      expect(
        tenantBubble.alignment,
        Alignment.centerLeft,
        reason: 'the tenant reply remains incoming for the administrator',
      );

      expect(find.text('Admin'), findsOneWidget);
      expect(find.byIcon(Icons.verified), findsOneWidget);
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is Container &&
              widget.decoration is BoxDecoration &&
              (widget.decoration! as BoxDecoration).color == Colors.blue,
        ),
        findsOneWidget,
      );

      await tester.enterText(
        find.byType(TextField),
        'A verified administrator reply',
      );
      await tester.tap(find.byIcon(Icons.send));
      await tester.pumpAndSettle();

      expect(repository.adminSends, hasLength(1));
      expect(repository.adminSends.single['userId'], 'student-1');
      expect(
        repository.adminSends.single['content'],
        'A verified administrator reply',
      );
      expect(repository.ordinarySends, isEmpty);
    },
  );
}
