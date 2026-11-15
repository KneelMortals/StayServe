import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../firebase/notifications/notifications_repository.dart';
import '../../../../../models/notification_model.dart';

final notificationsProvider = StreamProvider.autoDispose<List<NotificationModel>>((ref) {
  return ref.watch(notificationsRepositoryProvider).watchNotifications();
});

final unreadNotificationCountProvider = StreamProvider.autoDispose<int>((ref) {
  return ref.watch(notificationsRepositoryProvider).watchUnreadCount();
});
