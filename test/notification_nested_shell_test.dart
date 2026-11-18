import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/notifications/presentation/providers/notification_providers.dart';
import 'package:stayserve/features/notifications/presentation/widgets/notification_bell.dart';
import 'package:stayserve/models/notification_model.dart';
import 'package:stayserve/models/user_model.dart';

/// The notification bell used to call `context.push('/notifications')`.
///
/// The bell lives inside the shell of the signed-in role while the
/// notifications route is a shared root route. Pushing the root route from
/// the shell produced duplicate page keys in go_router 14.8.1 and the app
/// showed its "Page Not Found" page instead of the notifications.
void main() {
  testWidgets(
    'the bell replaces the nested shell with the notifications route',
    (tester) async {
      final router = GoRouter(
        initialLocation: '/owner/dashboard',
        routes: [
          ShellRoute(
            builder: (context, state, child) => Scaffold(
              appBar: AppBar(
                title: const Text('Owner'),
                actions: const [NotificationBell()],
              ),
              body: child,
            ),
            routes: [
              GoRoute(
                path: '/owner/dashboard',
                builder: (context, state) => const Scaffold(
                  body: Center(child: Text('OWNER DASHBOARD')),
                ),
              ),
            ],
          ),
          GoRoute(
            path: '/notifications',
            builder: (context, state) => const Scaffold(
              body: Center(child: Text('NOTIFICATIONS SCREEN')),
            ),
          ),
        ],
        errorBuilder: (context, state) =>
            const Scaffold(body: Center(child: Text('PAGE NOT FOUND'))),
      );
      addTearDown(router.dispose);

      final profile = UserModel(
        uid: 'owner-1',
        name: 'Owner',
        email: 'owner@example.com',
        role: UserRole.owner,
        createdAt: DateTime.utc(2026),
        updatedAt: DateTime.utc(2026),
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            unreadNotificationCountProvider.overrideWith(
              (ref) => Stream.value(0),
            ),
            notificationsProvider.overrideWith(
              (ref) => Stream.value(const <NotificationModel>[]),
            ),
            authSessionProvider.overrideWith(
              (ref) => Stream.value(
                AuthSession(
                  user: MockUser(uid: 'owner-1', email: 'owner@example.com'),
                  profile: profile,
                ),
              ),
            ),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('OWNER DASHBOARD'), findsOneWidget);

      await tester.tap(find.byTooltip('Notifications'));
      await tester.pumpAndSettle();

      expect(find.text('NOTIFICATIONS SCREEN'), findsOneWidget);
      expect(find.text('PAGE NOT FOUND'), findsNothing);
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/notifications',
      );
    },
  );
}
