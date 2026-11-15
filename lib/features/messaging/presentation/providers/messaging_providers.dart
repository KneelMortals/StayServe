import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../firebase/messaging/conversation_repository.dart';
import '../../../../../models/messaging_model.dart';

final conversationsProvider = StreamProvider.autoDispose<List<ConversationModel>>((ref) {
  return ref.watch(conversationRepositoryProvider).watchConversations();
});

final messagesProvider = StreamProvider.autoDispose.family<List<MessageModel>, String>(
  (ref, conversationId) {
    return ref.watch(conversationRepositoryProvider).watchMessages(conversationId);
  },
);
