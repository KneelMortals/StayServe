import 'package:material_ui/material_ui.dart';

import '../../../messaging/presentation/screens/conversations_screen.dart';
import '../widgets/admin_scaffold.dart';

/// The support inbox of the administrator.
///
/// It uses the [AdminScaffold] of the admin area, so the navigation drawer,
/// the notification bell and the log out button are there on a phone as
/// well.
///
/// The plain conversation screen used to be routed into `/admin/messages`
/// directly. That screen brings its own `Scaffold` with its own app bar, so
/// on a phone the whole admin frame disappeared: the administrator could
/// neither reach another admin screen, nor see the unread notifications,
/// nor sign out without going through the dashboard first.
class AdminMessagesScreen extends StatelessWidget {
  const AdminMessagesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const AdminScaffold(title: 'Messages', body: ConversationsList());
  }
}
