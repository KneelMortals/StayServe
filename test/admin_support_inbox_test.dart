import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:material_ui/material_ui.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/admin/presentation/screens/admin_messages_screen.dart';
import 'package:stayserve/features/admin/presentation/widgets/admin_scaffold.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/messaging/presentation/providers/messaging_providers.dart';
import 'package:stayserve/features/notifications/presentation/providers/notification_providers.dart';
import 'package:stayserve/models/interaction_model.dart';
import 'package:stayserve/models/messaging_model.dart';

/// A phone-sized viewport.
///
/// The admin area uses a drawer below 900 logical pixels and a rail from
/// 900 on. The bug this test guards against only happened on a phone: the
/// support inbox replaced the whole admin frame with a bare `Scaffold`.
const Size _phone = Size(360, 800);

ConversationModel _supportConversation() {
  return ConversationModel(
    conversationId: 'conversation-1',
    participants: const [adminSupportIdentity, 'student-1'],
    lastMessage: 'Please update your room details.',
    lastMessageAt: DateTime.utc(2026, 1, 1),
    unreadCount: const {adminSupportIdentity: 1, 'student-1': 0},
    conversationType: 'adminSupport',
    adminId: adminSupportIdentity,
    roomTitle: 'StayServe Support',
    createdAt: DateTime.utc(2026, 1, 1),
    updatedAt: DateTime.utc(2026, 1, 1),
  );
}

GoRouter _router() {
  return GoRouter(
    initialLocation: '/admin/messages',
    routes: [
      GoRoute(
        path: '/admin/messages',
        builder: (context, state) => const AdminMessagesScreen(),
      ),
      GoRoute(
        path: '/chat/:conversationId',
        builder: (context, state) =>
            const Scaffold(body: Center(child: Text('CHAT'))),
      ),
    ],
  );
}

void main() {
  group('the administrator support inbox', () {
    testWidgets('keeps the admin frame on a phone', (tester) async {
      await tester.binding.setSurfaceSize(_phone);
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final router = _router();
      addTearDown(router.dispose);

      final admin = MockUser(uid: 'admin-1', email: 'admin@example.test');

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(admin),
            currentUserRoleProvider.overrideWithValue(UserRole.admin),
            conversationsProvider.overrideWith(
              (ref) => Stream.value([_supportConversation()]),
            ),
            conversationInteractionDetailsProvider.overrideWith(
              (ref, key) => Future.value(
                ConversationInteractionDetails(
                  conversationId: key.conversationId,
                  peerId: 'student-1',
                  peerName: 'Student',
                  peerRole: 'student',
                  roomTitle: 'StayServe Support',
                  canSend: true,
                  isAdminSupport: true,
                ),
              ),
            ),
            unreadNotificationCountProvider.overrideWith(
              (ref) => Stream.value(3),
            ),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      // The list of the support conversations is there.
      expect(find.text('Student'), findsOneWidget);
      expect(find.text('Please update your room details.'), findsOneWidget);

      // The frame of the admin area is there as well: the drawer, the
      // notification bell and the log out button.
      final scaffold = tester.widget<Scaffold>(find.byType(Scaffold).first);
      expect(
        scaffold.drawer,
        isNotNull,
        reason: 'the support inbox needs the navigation of the admin area',
      );
      expect(find.byType(AdminNavigationDrawer), findsNothing);
      expect(find.byTooltip('Notifications (3 unread)'), findsOneWidget);
      expect(find.byTooltip('Log out'), findsOneWidget);
    });

    testWidgets('opens the drawer of the admin area', (tester) async {
      await tester.binding.setSurfaceSize(_phone);
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final router = _router();
      addTearDown(router.dispose);

      final admin = MockUser(uid: 'admin-1', email: 'admin@example.test');

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(admin),
            currentUserRoleProvider.overrideWithValue(UserRole.admin),
            conversationsProvider.overrideWith(
              (ref) => Stream.value([_supportConversation()]),
            ),
            conversationInteractionDetailsProvider.overrideWith(
              (ref, key) => Future.value(
                ConversationInteractionDetails(
                  conversationId: key.conversationId,
                  peerId: 'student-1',
                  peerName: 'Student',
                  peerRole: 'student',
                  roomTitle: 'StayServe Support',
                  canSend: true,
                  isAdminSupport: true,
                ),
              ),
            ),
            unreadNotificationCountProvider.overrideWith(
              (ref) => Stream.value(0),
            ),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      final scaffoldState = tester.state<ScaffoldState>(
        find.byType(Scaffold).first,
      );
      scaffoldState.openDrawer();
      await tester.pumpAndSettle();

      expect(find.byType(AdminNavigationDrawer), findsOneWidget);
      expect(find.text('Dashboard'), findsOneWidget);
    });
  });
}
