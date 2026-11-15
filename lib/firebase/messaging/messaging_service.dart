import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '../../core/utils/app_logger.dart';
import '../auth/auth_service.dart';

final firebaseMessagingProvider = Provider<FirebaseMessaging>((ref) => FirebaseMessaging.instance);

final messagingServiceProvider = Provider<MessagingService>((ref) {
  return MessagingService(
    messaging: ref.watch(firebaseMessagingProvider),
    firestore: ref.watch(firestoreProvider),
  );
});

class MessagingService {
  final FirebaseMessaging _messaging;
  final FirebaseFirestore _firestore;

  MessagingService({required this._messaging, required this._firestore});

  Future<String?> getToken() async {
    try {
      return await _messaging.getToken();
    } catch (e) {
      // On the web the plugin needs a service worker; without one it
      // throws. The app must keep working — the in-app notifications do
      // not need FCM at all.
      AppLogger.warning('Could not read the FCM token', error: e);
      return null;
    }
  }

  Future<void> requestPermission() async {
    try {
      await _messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
        provisional: false,
      );
    } catch (e) {
      AppLogger.warning('Could not ask for the notification permission', error: e);
    }
  }

  /// The messages that arrive while the app is in the foreground.
  Stream<RemoteMessage> get onMessage => FirebaseMessaging.onMessage;

  Stream<RemoteMessage> get onMessageOpenedApp => FirebaseMessaging.onMessageOpenedApp;

  Future<RemoteMessage?> getInitialMessage() async {
    try {
      return await _messaging.getInitialMessage();
    } catch (e) {
      AppLogger.warning('Could not read the initial message', error: e);
      return null;
    }
  }

  /// Fires whenever Firebase rotates the token of this device.
  ///
  /// The token has to be written to the profile again after every
  /// rotation — otherwise the push messages keep going to the old token
  /// (or nowhere at all) and the user stops receiving them.
  Stream<String> get onTokenRefresh => _messaging.onTokenRefresh;

  Future<void> subscribeToTopic(String topic) async {
    await _messaging.subscribeToTopic(topic);
  }

  Future<void> unsubscribeFromTopic(String topic) async {
    await _messaging.unsubscribeFromTopic(topic);
  }

  /// The token that is stored on the profile of [uid] — `null` when there
  /// is none.
  Future<String?> readToken(String uid) async {
    try {
      final doc = await _firestore.collection('users').doc(uid).get();
      final token = doc.get('fcmToken');
      return token is String && token.isNotEmpty ? token : null;
    } catch (e) {
      AppLogger.warning('Could not read the stored FCM token', error: e);
      return null;
    }
  }

  Future<void> saveTokenToUser(String uid, String token) async {
    // `set` and **not** `update`.
    //
    // The token is registered as soon as the user signs in — but the
    // profile (`users/{uid}`) is written by the server a moment later. An
    // `update` on a document that does not exist yet fails with "NOT_FOUND",
    // the whole registration was aborted and the device never received a
    // push message again.
    //
    // `set` with `merge` writes the token whether the profile exists or
    // not — and it never touches the other fields of the profile.
    await _firestore.collection('users').doc(uid).set(
      {
        'fcmToken': token,
        'updatedAt': FieldValue.serverTimestamp(),
      },
      SetOptions(merge: true),
    );
  }

  Future<void> removeTokenFromUser(String uid) async {
    await _firestore.collection('users').doc(uid).update({
      'fcmToken': FieldValue.delete(),
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  // Local notification handling
  Future<void> showLocalNotification({
    required String title,
    required String body,
    Map<String, String>? data,
  }) async {
    // This would use flutter_local_notifications for in-app display
    // Implementation depends on the local notification package
  }
}

/// Keeps the FCM token of the signed-in user on their profile.
///
/// Without this the server has no token to push to, so the user only ever
/// saw a notification **after** they happened to open the app.
///
/// The token is written:
///
///  * when the user signs in (and whenever the app starts with an
///    existing session), and
///  * whenever Firebase rotates it.
final pushNotificationRegistrarProvider = Provider<PushNotificationRegistrar>((ref) {
  final registrar = PushNotificationRegistrar(
    ref.watch(messagingServiceProvider),
  );
  ref.onDispose(registrar.dispose);
  return registrar;
});

/// Writes the FCM token of the device to `users/{uid}.fcmToken`.
class PushNotificationRegistrar {
  final MessagingService _messaging;

  StreamSubscription<String>? _refreshSubscription;

  /// The account the refresh listener belongs to.
  ///
  /// The subscription captures the uid it was created for. When another
  /// account signs in on the same device, the refreshed token would be
  /// written to the **first** account — and the new account would never
  /// get a push message.
  String? _registeredUid;

  /// Whether the permission was already asked for in this session.
  bool _permissionAsked = false;

  PushNotificationRegistrar(this._messaging);

  /// Registers the token of this device for [uid].
  ///
  /// Safe to call again and again — the token is only written when it
  /// really changed. That matters: the profile of the user is a **stream**,
  /// so every write to it triggers the next call of this method. Writing
  /// the token unconditionally would be an endless loop of writes.
  Future<void> register(String uid) async {
    try {
      if (!kIsWeb && !_permissionAsked) {
        _permissionAsked = true;
        await _messaging.requestPermission();
      }

      final token = await _messaging.getToken();
      if (token == null || token.isEmpty) {
        AppLogger.info('No FCM token available on this device');
        return;
      }

      final current = await _messaging.readToken(uid);
      if (current != token) {
        await _messaging.saveTokenToUser(uid, token);
        AppLogger.info('The FCM token was registered for $uid');
      }

      _listenForTokenRefresh(uid);
    } catch (e) {
      // A device without Play Services (or a browser without a service
      // worker) simply has no token. The app must not break because of it.
      AppLogger.warning('Could not register the FCM token', error: e);
    }
  }

  /// Writes the new token whenever Firebase rotates it.
  void _listenForTokenRefresh(String uid) {
    // Another account signed in — the old listener has to go, otherwise the
    // refreshed token is written to the wrong profile.
    if (_registeredUid != null && _registeredUid != uid) {
      _refreshSubscription?.cancel();
      _refreshSubscription = null;
    }
    _registeredUid = uid;

    if (_refreshSubscription != null) return;

    _refreshSubscription = _messaging.onTokenRefresh.listen((token) async {
      if (token.isEmpty) return;
      // The account may have changed while the message was in flight.
      if (_registeredUid != uid) return;
      try {
        final current = await _messaging.readToken(uid);
        if (current == token) return;
        await _messaging.saveTokenToUser(uid, token);
        AppLogger.info('The FCM token was refreshed for $uid');
      } catch (e) {
        AppLogger.warning('Could not store the refreshed FCM token', error: e);
      }
    });
  }

  /// Removes the token of the device from the profile of [uid].
  ///
  /// Without this the device keeps the token of the account that signed
  /// out: the server would keep pushing the notifications of the old user
  /// to a device that now belongs to somebody else.
  Future<void> unregister(String uid) async {
    if (_registeredUid == uid) {
      _refreshSubscription?.cancel();
      _refreshSubscription = null;
      _registeredUid = null;
    }

    try {
      await _messaging.removeTokenFromUser(uid);
    } catch (e) {
      // The account may already be gone — not a problem.
      AppLogger.warning('Could not remove the FCM token', error: e);
    }
  }

  void dispose() {
    _refreshSubscription?.cancel();
    _refreshSubscription = null;
    _registeredUid = null;
  }
}
