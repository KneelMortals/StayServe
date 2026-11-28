import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '../../core/errors/failures.dart';
import '../../core/utils/app_logger.dart';
import '../auth/auth_service.dart';

final firebaseMessagingProvider = Provider<FirebaseMessaging>(
  (ref) => FirebaseMessaging.instance,
);

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
      AppLogger.warning(
        'Could not ask for the notification permission',
        error: e,
      );
    }
  }

  /// The messages that arrive while the app is in the foreground.
  Stream<RemoteMessage> get onMessage => FirebaseMessaging.onMessage;

  Stream<RemoteMessage> get onMessageOpenedApp =>
      FirebaseMessaging.onMessageOpenedApp;

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

  /// Stores the token on an **existing** server-owned profile.
  ///
  /// The profile is created by the Auth trigger and completed by the
  /// registration callable. Using `set` here would create a second,
  /// incomplete profile containing only `fcmToken` and `updatedAt` when the
  /// trigger had not run yet. Such a document can never be completed by the
  /// registration flow, so the client must never create it.
  Future<void> saveTokenToUser(String uid, String token) async {
    await _firestore.collection('users').doc(uid).update({
      'fcmToken': token,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  /// Tries to store the token and reports whether the profile existed.
  ///
  /// The `not-found` response is a normal race while the server creates a
  /// newly registered profile. It is not an error and must never turn into a
  /// client-side profile creation.
  Future<bool> trySaveTokenToUser(String uid, String token) async {
    try {
      await saveTokenToUser(uid, token);
      return true;
    } on FirebaseException catch (e) {
      if (e.code == 'not-found') return false;
      rethrow;
    }
  }

  /// Removes the token from the profile of [uid].
  ///
  /// A profile which no longer exists is already clean. Firestore reports an
  /// `update` of a missing document as `not-found`; that response is a
  /// successful cleanup, not a transient failure.
  Future<void> removeTokenFromUser(String uid) async {
    try {
      await _firestore.collection('users').doc(uid).update({
        'fcmToken': FieldValue.delete(),
        'updatedAt': FieldValue.serverTimestamp(),
      });
    } on FirebaseException catch (error) {
      if (error.code == 'not-found') return;
      rethrow;
    }
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

/// The final failure of a best-effort token cleanup.
///
/// The old account's token can still be attached when this exception is
/// raised. Callers must therefore not continue with a Firebase Auth sign-out
/// or register the token for another account.
///
/// The message is written for the user: the screen shows it as it is, and it
/// must not name the technology behind the notifications.
class FcmTokenCleanupException extends Failure implements Exception {
  const FcmTokenCleanupException({
    required this.uid,
    required this.attempts,
    required this.cause,
    this.causeStackTrace,
  }) : super(
         'The notifications of the previous account could not be switched '
         'off. Please try again.',
       );

  final String uid;
  final int attempts;
  final Object cause;
  final StackTrace? causeStackTrace;

  @override
  String toString() {
    return 'Could not remove the FCM token of $uid after $attempts attempts: $cause';
  }
}

/// An injectable asynchronous delay.
///
/// Tests use this to exercise bounded backoff without waiting for wall-clock
/// time.
typedef MessagingDelay = Future<void> Function(Duration delay);

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
final pushNotificationRegistrarProvider = Provider<PushNotificationRegistrar>((
  ref,
) {
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

  /// The account whose profile may currently contain this device's token.
  ///
  /// This is kept separately from [_registeredUid] because a cleanup can
  /// fail after the listener has already been invalidated. The next account
  /// must retry that cleanup before it receives the token.
  String? _tokenOwnerUid;

  /// Monotonically increasing generation of the registration operation.
  ///
  /// Every asynchronous step checks this value. A sign-out (or a new
  /// account) increments it, so an old operation cannot write the token or
  /// install a refresh listener after its account is no longer active.
  int _generation = 0;

  /// Serialises writes to the token field of a user profile.
  ///
  /// Firebase's token refresh callback, a new registration and a sign-out
  /// cleanup can otherwise overlap. Without this queue, an old refresh write
  /// could finish after the sign-out cleanup and leave the token attached to
  /// the account, or a new registration could write the token before an old
  /// cleanup removed it again.
  Future<void> _profileWriteQueue = Future<void>.value();

  /// The most recent sign-out cleanup which has not finished yet.
  ///
  /// A registration waits for it before it reads the stored token. Otherwise
  /// it could observe the old token, decide that no write was needed, and
  /// finish just as the cleanup removed that token from the profile.
  Future<void>? _pendingCleanup;

  /// The accounts whose device token was already removed from the profile.
  ///
  /// The profile of an account may only be written by that account itself, so
  /// the token has to be removed **before** Firebase Auth switches to another
  /// account. A second cleanup of the same account would be refused by the
  /// rules — it would only report a token which is not there any more.
  final Set<String> _cleanedTokenUids = <String>{};

  bool _disposed = false;

  /// Whether the permission was already asked for in this session.
  bool _permissionAsked = false;

  /// Delays used while the server creates a newly registered profile.
  ///
  /// The profile is server-owned. The client waits for it with bounded
  /// exponential backoff instead of creating a partial document with
  /// `set(..., merge: true)`.
  static const defaultProfileWaitDelays = <Duration>[
    Duration(milliseconds: 250),
    Duration(milliseconds: 500),
    Duration(milliseconds: 1000),
    Duration(milliseconds: 2000),
    Duration(milliseconds: 4000),
    Duration(milliseconds: 8000),
    Duration(milliseconds: 15000),
  ];

  /// Delays between token-removal attempts.
  ///
  /// The final attempt is made after the last delay, so the number of
  /// attempts is one more than the number of delays.
  static const defaultCleanupRetryDelays = <Duration>[
    Duration(milliseconds: 250),
    Duration(milliseconds: 500),
    Duration(milliseconds: 1000),
    Duration(milliseconds: 2000),
  ];

  final List<Duration> _profileWaitDelays;
  final List<Duration> _cleanupRetryDelays;
  final MessagingDelay _delay;

  PushNotificationRegistrar(
    this._messaging, {
    List<Duration> profileWaitDelays = defaultProfileWaitDelays,
    List<Duration> cleanupRetryDelays = defaultCleanupRetryDelays,
    MessagingDelay? delay,
  }) : _profileWaitDelays = List<Duration>.unmodifiable(profileWaitDelays),
       _cleanupRetryDelays = List<Duration>.unmodifiable(cleanupRetryDelays),
       _delay = delay ?? _defaultDelay;

  static Future<void> _defaultDelay(Duration duration) {
    return Future<void>.delayed(duration);
  }

  bool _isGenerationCurrent(int generation) {
    return !_disposed && _generation == generation;
  }

  bool _isCurrent(String uid, int generation) {
    return _isGenerationCurrent(generation) &&
        _registeredUid == uid &&
        _tokenOwnerUid == uid;
  }

  /// Runs one profile-token write after every earlier write.
  ///
  /// The queue itself always completes successfully so one failed Firestore
  /// write cannot poison every later registration or cleanup.
  Future<T> _enqueueProfileWrite<T>(Future<T> Function() action) {
    final next = _profileWriteQueue.then((_) => action());
    _profileWriteQueue = next.then<void>(
      (_) {},
      onError: (Object error, StackTrace stack) {},
    );
    return next;
  }

  /// Registers the token of this device for [uid].
  ///
  /// Safe to call again and again — the token is only written when it
  /// really changed. That matters: the profile of the user is a **stream**,
  /// so every write to it triggers the next call of this method. Writing
  /// the token unconditionally would be an endless loop of writes.
  Future<void> register(String uid) async {
    if (_disposed || uid.trim().isEmpty) return;

    // The account receives the token of this device again, so a cleanup of
    // this account has to be possible once more.
    _cleanedTokenUids.remove(uid);

    // Invalidate every older operation before doing any asynchronous work.
    final generation = ++_generation;
    _registeredUid = null;

    // A new account must not keep the old account's listener. Cancellation
    // is awaited so the old callback cannot race with the new one.
    final oldSubscription = _refreshSubscription;
    _refreshSubscription = null;
    if (oldSubscription != null) {
      await oldSubscription.cancel();
    }

    // A sign-out cleanup may still be removing the old token. Wait for it
    // before reading the profile. Its final failure is propagated: the new
    // account must not receive the device token while the old account may
    // still have it attached.
    await _waitForPendingCleanup();
    if (!_isGenerationCurrent(generation)) return;

    // The registrar can also learn about the old owner only from its own
    // previous registration. Remove that token before this account is
    // allowed to receive the same device token.
    final previousOwner = _tokenOwnerUid;
    if (previousOwner != null && previousOwner != uid) {
      await _cleanupToken(previousOwner);
      if (!_isGenerationCurrent(generation)) return;
    }

    _registeredUid = uid;
    _tokenOwnerUid = uid;

    try {
      if (!kIsWeb && !_permissionAsked) {
        _permissionAsked = true;
        await _messaging.requestPermission();
        if (!_isCurrent(uid, generation)) return;
      }

      final token = await _messaging.getToken();
      if (!_isCurrent(uid, generation)) return;
      if (token == null || token.isEmpty) {
        AppLogger.info('No FCM token available on this device');
        return;
      }

      var stored = false;
      for (var attempt = 0; attempt <= _profileWaitDelays.length; attempt++) {
        if (!_isCurrent(uid, generation)) return;

        final current = await _messaging.readToken(uid);
        if (!_isCurrent(uid, generation)) return;
        if (current == token) {
          stored = true;
          break;
        }

        // The check immediately before the write is important: a sign-out
        // can happen while the token or the profile is being read.
        if (!_isCurrent(uid, generation)) return;
        final saved = await _enqueueProfileWrite(() async {
          if (!_isCurrent(uid, generation)) return false;
          return await _messaging.trySaveTokenToUser(uid, token);
        });
        if (!_isCurrent(uid, generation)) return;
        if (saved) {
          stored = true;
          AppLogger.info('The FCM token was registered for $uid');
          break;
        }

        if (attempt < _profileWaitDelays.length) {
          await _delay(_profileWaitDelays[attempt]);
        }
      }

      if (!stored) {
        // The server profile is not ready yet. Do not create it on the
        // client; a later sign-in or token refresh will try again.
        AppLogger.info('The FCM token profile for $uid is not ready yet');
      }

      if (!_isCurrent(uid, generation)) return;
      _listenForTokenRefresh(uid, generation);
    } catch (e) {
      // A device without Play Services (or a browser without a service
      // worker) simply has no token. The app must not break because of it.
      AppLogger.warning('Could not register the FCM token', error: e);
    }
  }

  /// Writes the new token whenever Firebase rotates it.
  void _listenForTokenRefresh(String uid, int generation) {
    // The account may have changed while the token was being read. Never
    // install a listener for an operation which is no longer current.
    if (!_isCurrent(uid, generation)) return;
    if (_refreshSubscription != null) return;

    _refreshSubscription = _messaging.onTokenRefresh.listen((token) async {
      if (token.isEmpty) return;
      if (!_isCurrent(uid, generation)) return;
      try {
        final current = await _messaging.readToken(uid);
        if (!_isCurrent(uid, generation)) return;
        if (current == token) return;
        if (!_isCurrent(uid, generation)) return;
        final saved = await _enqueueProfileWrite(() async {
          if (!_isCurrent(uid, generation)) return false;
          return await _messaging.trySaveTokenToUser(uid, token);
        });
        if (!_isCurrent(uid, generation)) return;
        if (saved) {
          AppLogger.info('The FCM token was refreshed for $uid');
        }
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
  ///
  /// The returned future completes only after the token was removed. A
  /// transient Firestore failure is retried with bounded backoff. If the
  /// final attempt fails, [FcmTokenCleanupException] is raised so the caller
  /// cannot continue with an Auth sign-out or an account replacement.
  Future<void> unregister(String uid) async {
    if (uid.trim().isEmpty) return;

    // The token of this account was already removed — for example before a
    // sign-in which replaced the account. A second write would be refused by
    // the rules, because the client already carries the token of the new
    // account.
    if (_cleanedTokenUids.contains(uid)) {
      AppLogger.info('The FCM token of $uid was already removed');
      return;
    }

    // Invalidate pending registration and refresh operations for every
    // account. A delayed callback for the old UID must not be able to
    // restore its token while this cleanup is running.
    _generation++;
    _registeredUid = null;
    final subscription = _refreshSubscription;
    _refreshSubscription = null;

    // Queue the cleanup before awaiting the listener cancellation. Any
    // registration which starts after this point is therefore written after
    // the old token was removed, while an older in-flight write is removed by
    // this cleanup.
    final cleanup = _cleanupToken(uid);

    if (subscription != null) {
      await subscription.cancel();
    }

    await cleanup;
    _cleanedTokenUids.add(uid);
  }

  /// Waits for the most recent cleanup without hiding its failure.
  Future<void> _waitForPendingCleanup() async {
    while (true) {
      final pendingCleanup = _pendingCleanup;
      if (pendingCleanup == null) return;
      await pendingCleanup;
      if (identical(_pendingCleanup, pendingCleanup)) {
        _pendingCleanup = null;
      }
    }
  }

  /// Removes [uid]'s token and keeps the pending cleanup visible to a new
  /// registration.
  Future<void> _cleanupToken(String uid) async {
    final cleanup = _removeTokenWithRetries(uid);
    _pendingCleanup = cleanup;
    try {
      await cleanup;
      if (_tokenOwnerUid == uid) {
        _tokenOwnerUid = null;
      }
    } finally {
      if (identical(_pendingCleanup, cleanup)) {
        _pendingCleanup = null;
      }
    }
  }

  /// Removes a token with a bounded number of retries.
  Future<void> _removeTokenWithRetries(String uid) async {
    Object? lastError;
    StackTrace? lastStackTrace;

    for (var attempt = 0; attempt <= _cleanupRetryDelays.length; attempt++) {
      try {
        await _enqueueProfileWrite(() => _messaging.removeTokenFromUser(uid));
        return;
      } catch (error, stackTrace) {
        // A profile which is already gone cannot contain the old token.
        // This is a successful cleanup, not a failure to retry.
        if (_isMissingProfileError(error)) return;

        lastError = error;
        lastStackTrace = stackTrace;
        if (attempt == _cleanupRetryDelays.length) break;

        AppLogger.warning(
          'Could not remove the FCM token of $uid; retrying',
          error: error,
        );
        await _delay(_cleanupRetryDelays[attempt]);
      }
    }

    final failure = FcmTokenCleanupException(
      uid: uid,
      attempts: _cleanupRetryDelays.length + 1,
      cause: lastError ?? StateError('The FCM token removal failed.'),
      causeStackTrace: lastStackTrace,
    );
    AppLogger.warning('Could not remove the FCM token of $uid', error: failure);
    throw failure;
  }

  bool _isMissingProfileError(Object error) {
    return error is FirebaseException && error.code == 'not-found';
  }

  void dispose() {
    _disposed = true;
    _generation++;
    _refreshSubscription?.cancel();
    _refreshSubscription = null;
    _registeredUid = null;
    _tokenOwnerUid = null;
  }
}
