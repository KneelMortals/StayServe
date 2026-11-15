import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../core/routing/app_router.dart';
import '../../../../../core/utils/app_logger.dart';
import '../../../../../firebase/messaging/messaging_service.dart';
import '../../../../../models/notification_model.dart';
import '../../../auth/presentation/providers/auth_provider.dart';
import 'pending_notification_route.dart';

/// Opens the screen a push notification came from.
///
/// ## Why this is needed
///
/// The server pushes a message to the device of the user, but the app never
/// listened to the tap:
///
///  * `FirebaseMessaging.onMessageOpenedApp` — the app was in the
///    background and the user tapped the notification,
///  * `FirebaseMessaging.getInitialMessage` — the app was **closed** and
///    the user tapped the notification.
///
/// The notification arrived, the phone showed it, the user tapped it — and
/// nothing happened. The app did open, but it opened on the screen the user
/// last had, not on the screen the notification was about.
///
/// The handler reads the type and the payload of the message and opens the
/// same screen the notification list would open — see
/// [notificationRouteFor].
final notificationTapHandlerProvider = Provider<NotificationTapHandler>((ref) {
  final handler = NotificationTapHandler(ref);
  ref.onDispose(handler.dispose);
  return handler;
});

/// Listens for the taps on the push notifications.
class NotificationTapHandler {
  final Ref _ref;

  StreamSubscription<RemoteMessage>? _subscription;

  /// Whether the message the app was opened with was already read.
  bool _initialMessageRead = false;

  NotificationTapHandler(this._ref) {
    // The handler only works while somebody is signed in — the route of a
    // notification depends on the role of the user.
    //
    // `fireImmediately` matters: the session is often already resolved when
    // the app starts, and the listener has to be called for that value too
    // — otherwise the handler would only start working after the next
    // sign-in.
    _ref.listen<AsyncValue<AuthSession?>>(
      authSessionProvider,
      (previous, next) {
        if (next.valueOrNull != null) {
          _listen();
          unawaited(_handleInitialMessage());
        } else {
          _unlisten();
        }
      },
      fireImmediately: true,
    );
  }

  /// Starts listening for the taps.
  void _listen() {
    if (_subscription != null) return;
    try {
      final messaging = _ref.read(messagingServiceProvider);
      _subscription = messaging.onMessageOpenedApp.listen(
        _open,
        onError: (Object error) {
          AppLogger.warning('Could not handle the notification tap', error: error);
        },
      );
    } catch (e) {
      // A device without Firebase (or a browser without a service worker)
      // simply has no push messages — the app must keep working.
      AppLogger.warning('Could not listen for notification taps', error: e);
    }
  }

  void _unlisten() {
    _subscription?.cancel();
    _subscription = null;
  }

  /// Reads the message the app was **opened** with.
  ///
  /// It is only read once — the second call would always return `null`
  /// anyway.
  Future<void> _handleInitialMessage() async {
    if (_initialMessageRead) return;
    _initialMessageRead = true;

    try {
      final messaging = _ref.read(messagingServiceProvider);
      final message = await messaging.getInitialMessage();
      if (message != null) _open(message);
    } catch (e) {
      AppLogger.warning('Could not read the initial message', error: e);
    }
  }

  /// Opens the screen the notification was about.
  void _open(RemoteMessage message) {
    try {
      final data = Map<String, dynamic>.from(message.data);
      final role = _ref.read(userRoleProvider);

      final route = notificationRouteFor(
        type: data['type']?.toString() ?? 'general',
        data: data,
        role: role,
      );

      if (route.isEmpty) return;

      final router = _ref.read(routerProvider);
      final pending = _ref.read(pendingNotificationRouteProvider.notifier);

      // ---------------------------------------------------------------------
      // The app was **started** by the tap: the splash screen is still
      // running.
      //
      // It would navigate to the home screen of the role as soon as it is
      // done (it still has to ask for the location and check the launch
      // area), and the user would never see the screen the notification was
      // about — the tap looked like it did nothing.
      //
      // The route is therefore remembered until the splash screen picks it
      // up (see `pendingNotificationRouteProvider`).
      // ---------------------------------------------------------------------
      if (router.routerDelegate.currentConfiguration.uri.path == '/splash') {
        pending.state = route;
        return;
      }

      pending.state = null;

      // `go` and not `push`: the notification opens a **section** of the
      // app, it does not add a page to the stack.
      router.go(route);
    } catch (e) {
      AppLogger.warning('Could not open the notification', error: e);
    }
  }

  void dispose() {
    _unlisten();
  }
}
