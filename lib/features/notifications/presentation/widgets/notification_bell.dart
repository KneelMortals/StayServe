import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../providers/notification_providers.dart';

/// The bell in the app bar — with the number of unread notifications.
///
/// The number was never shown before: the bell was there, but the user
/// had to open the notifications screen to find out that something had
/// happened. The count comes from the live Firestore stream, so it is
/// up to date the moment a notification arrives.
class NotificationBell extends ConsumerWidget {
  /// The tooltip of the button.
  final String tooltip;

  const NotificationBell({this.tooltip = 'Notifications', super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unread = ref.watch(unreadNotificationCountProvider).valueOrNull ?? 0;

    return IconButton(
      tooltip: unread > 0 ? '$tooltip ($unread unread)' : tooltip,
      icon: Badge(
        isLabelVisible: unread > 0,
        label: Text('$unread'),
        child: const Icon(Icons.notifications_outlined),
      ),
      // The notifications screen is a **root** route. `push` from a page
      // inside a role shell asks the nested navigator to match the path and
      // leaves the user on a blank page; `go` replaces the root stack with
      // the actual route.
      onPressed: () => context.go('/notifications'),
    );
  }
}
