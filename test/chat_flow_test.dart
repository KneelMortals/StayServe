import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/messaging/presentation/providers/messaging_providers.dart';
import 'package:stayserve/features/messaging/presentation/screens/chat_screen.dart';
import 'package:stayserve/firebase/functions/functions_service.dart';
import 'package:stayserve/firebase/messaging/conversation_repository.dart';
import 'package:stayserve/models/messaging_model.dart';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class _FakeFirestore implements FirebaseFirestore {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Firestore is not available in the test');
}

class _FakeFirebaseFunctions implements FirebaseFunctions {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Functions are not available in the test');
}

class _FakeFunctionsService extends FunctionsService {
  _FakeFunctionsService() : super(_FakeFirebaseFunctions());
}

/// Records the messages that were sent instead of writing them to Firestore.
class _FakeConversationRepository extends ConversationRepository {
  _FakeConversationRepository()
      : super(
          firestore: _FakeFirestore(),
          auth: MockFirebaseAuth(),
          functions: _FakeFunctionsService(),
        );

  final List<Map<String, String>> sent = [];
  bool markedRead = false;

  /// The other participant of the conversation, read from the document.
  String? otherParticipant;

  @override
  Future<String?> getOtherParticipant(String conversationId) async =>
      otherParticipant;

  @override
  Future<void> sendMessage({
    required String conversationId,
    required String receiverId,
    required String content,
    MessageType type = MessageType.text,
    String? roomId,
    String? imageUrl,
  }) async {
    sent.add({
      'conversationId': conversationId,
      'receiverId': receiverId,
      'content': content,
    });
  }

  @override
  Future<void> markConversationRead(String conversationId) async {
    markedRead = true;
  }
}

void main() {
  testWidgets(
    'the chat shows the message input when the peer comes with the route',
    (tester) async {
      final repository = _FakeConversationRepository();
      final user = MockUser(uid: 'student-1', email: 'student@example.com');

      final router = GoRouter(
        initialLocation: '/chat/owner-1_student-1?peer=owner-1',
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

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(user),
            authStateProvider.overrideWith((ref) => Stream.value(user)),
            conversationRepositoryProvider.overrideWithValue(repository),
            // The conversation list is empty — the chat must not depend on it.
            conversationsProvider.overrideWith((ref) => Stream.value(const [])),
            messagesProvider.overrideWith(
              (ref, conversationId) => Stream.value(const <MessageModel>[]),
            ),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      // The input field is there even though the conversation list is empty.
      expect(find.byType(TextField), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'Is the room available?');
      await tester.pumpAndSettle();

      await tester.tap(find.byType(Icon).last);
      await tester.pumpAndSettle();

      // The message went to the owner that came with the route.
      expect(repository.sent, hasLength(1));
      expect(repository.sent.first['receiverId'], 'owner-1');
      expect(repository.sent.first['content'], 'Is the room available?');
    },
  );

  testWidgets(
    'the chat falls back to the conversation document for the recipient',
    (tester) async {
      final repository = _FakeConversationRepository()
        ..otherParticipant = 'owner-1';
      final user = MockUser(uid: 'student-1', email: 'student@example.com');

      final router = GoRouter(
        initialLocation: '/chat/owner-1_student-1',
        routes: [
          GoRoute(
            path: '/chat/:conversationId',
            builder: (context, state) => ChatScreen(
              conversationId: state.pathParameters['conversationId']!,
            ),
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(user),
            authStateProvider.overrideWith((ref) => Stream.value(user)),
            conversationRepositoryProvider.overrideWithValue(repository),
            conversationsProvider.overrideWith((ref) => Stream.value(const [])),
            messagesProvider.overrideWith(
              (ref, conversationId) => Stream.value(const <MessageModel>[]),
            ),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      // The peer was not in the route and the conversation list is empty, so
      // the recipient was read from the conversation document.
      expect(find.byType(TextField), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'Hello there');
      await tester.pumpAndSettle();
      await tester.tap(find.byType(Icon).last);
      await tester.pumpAndSettle();

      expect(repository.sent, hasLength(1));
      expect(repository.sent.first['receiverId'], 'owner-1');
    },
  );
}
