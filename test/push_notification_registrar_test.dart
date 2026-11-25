import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/firebase/messaging/messaging_service.dart';

class _FakeFirestore implements FirebaseFirestore {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Firestore is not available in this test');
}

class _FakeFirebaseMessaging implements FirebaseMessaging {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError(
    'Firebase Messaging is not available in this test',
  );
}

class _TokenFirebaseMessaging implements FirebaseMessaging {
  @override
  Future<String?> getToken({String? vapidKey}) async => 'device-token';

  @override
  Stream<String> get onTokenRefresh => const Stream<String>.empty();

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Firebase Messaging is not used by this test');
}

class _RecordingFirestore implements FirebaseFirestore {
  _RecordingFirestore(this.document);

  final _RecordingDocumentReference document;

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) {
    return _RecordingCollectionReference(document);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Unexpected Firestore call: $invocation');
}

// ignore: subtype_of_sealed_class
class _RecordingCollectionReference
    implements CollectionReference<Map<String, dynamic>> {
  _RecordingCollectionReference(this.document);

  final _RecordingDocumentReference document;

  @override
  DocumentReference<Map<String, dynamic>> doc([String? path]) => document;

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Unexpected collection call: $invocation');
}

// ignore: subtype_of_sealed_class, must_be_immutable
class _RecordingDocumentReference
    implements DocumentReference<Map<String, dynamic>> {
  int updateCalls = 0;
  int setCalls = 0;
  Map<Object, Object?>? updateData;
  Object? updateError;
  final List<Object> updateErrors = <Object>[];

  @override
  Future<void> update(Map<Object, Object?> data) async {
    updateCalls++;
    updateData = Map<Object, Object?>.from(data);
    final error = updateErrors.isNotEmpty
        ? updateErrors.removeAt(0)
        : updateError;
    if (error != null) throw error;
  }

  @override
  Future<void> set(Map<String, dynamic> data, [SetOptions? options]) async {
    setCalls++;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Unexpected document call: $invocation');
}

class _RecordingMessagingService extends MessagingService {
  _RecordingMessagingService()
    : super(messaging: _FakeFirebaseMessaging(), firestore: _FakeFirestore());

  final StreamController<String> _tokenRefresh =
      StreamController<String>.broadcast();
  final Map<String, String?> storedTokens = <String, String?>{};

  int saveCalls = 0;
  int removeCalls = 0;

  /// Holds the next token write when it is configured.
  Completer<void>? nextSaveGate;

  /// Completes when the gated token write starts.
  Completer<void>? nextSaveStarted;

  /// Holds the next sign-out cleanup when it is configured.
  Completer<void>? nextRemovalGate;

  @override
  Stream<String> get onTokenRefresh => _tokenRefresh.stream;

  @override
  Future<void> requestPermission() async {}

  @override
  Future<String?> getToken() async => 'device-token';

  @override
  Future<String?> readToken(String uid) async => storedTokens[uid];

  @override
  Future<bool> trySaveTokenToUser(String uid, String token) async {
    saveCalls++;
    final gate = nextSaveGate;
    if (gate != null) {
      nextSaveGate = null;
      nextSaveStarted?.complete();
      await gate.future;
    }
    storedTokens[uid] = token;
    return true;
  }

  @override
  Future<void> removeTokenFromUser(String uid) async {
    removeCalls++;
    final gate = nextRemovalGate;
    if (gate != null) {
      nextRemovalGate = null;
      await gate.future;
    }
    storedTokens.remove(uid);
  }

  void emitTokenRefresh(String token) => _tokenRefresh.add(token);

  Future<void> close() => _tokenRefresh.close();
}

Future<void> _waitUntil(bool Function() condition) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
  fail('The expected asynchronous state was not reached');
}

void main() {
  test(
    'a registration after sign-out waits for the old token cleanup',
    () async {
      final messaging = _RecordingMessagingService();
      final registrar = PushNotificationRegistrar(messaging);
      addTearDown(registrar.dispose);
      addTearDown(messaging.close);

      await registrar.register('user-1');
      expect(messaging.saveCalls, 1);
      expect(messaging.storedTokens['user-1'], 'device-token');

      final removalGate = Completer<void>();
      messaging.nextRemovalGate = removalGate;
      final unregister = registrar.unregister('user-1');
      await _waitUntil(() => messaging.removeCalls == 1);

      final registerAgain = registrar.register('user-1');
      await Future<void>.delayed(const Duration(milliseconds: 5));
      expect(
        messaging.saveCalls,
        1,
        reason: 'the new registration must wait for the old cleanup',
      );

      removalGate.complete();
      await unregister;
      await registerAgain;

      expect(messaging.saveCalls, 2);
      expect(messaging.storedTokens['user-1'], 'device-token');
    },
  );

  test(
    'a token refresh which overlaps sign-out cannot restore the token',
    () async {
      final messaging = _RecordingMessagingService();
      final registrar = PushNotificationRegistrar(messaging);
      addTearDown(registrar.dispose);
      addTearDown(messaging.close);

      await registrar.register('user-1');
      expect(messaging.storedTokens['user-1'], 'device-token');

      final saveGate = Completer<void>();
      final saveStarted = Completer<void>();
      messaging.nextSaveGate = saveGate;
      messaging.nextSaveStarted = saveStarted;
      messaging.emitTokenRefresh('rotated-token');
      await saveStarted.future;

      final unregister = registrar.unregister('user-1');
      await Future<void>.delayed(const Duration(milliseconds: 5));

      saveGate.complete();
      await unregister;
      await Future<void>.delayed(const Duration(milliseconds: 5));

      expect(messaging.removeCalls, 1);
      expect(messaging.storedTokens.containsKey('user-1'), isFalse);
    },
  );

  test(
    'a late server profile receives the token without client creation',
    () async {
      final document = _RecordingDocumentReference()
        ..updateErrors.add(
          FirebaseException(plugin: 'cloud_firestore', code: 'not-found'),
        );
      final service = MessagingService(
        messaging: _TokenFirebaseMessaging(),
        firestore: _RecordingFirestore(document),
      );
      final delays = <Duration>[];
      final registrar = PushNotificationRegistrar(
        service,
        profileWaitDelays: const <Duration>[Duration.zero],
        delay: (duration) async {
          delays.add(duration);
        },
      );
      addTearDown(registrar.dispose);

      await registrar.register('user-1');

      expect(document.updateCalls, 2);
      expect(document.updateData?['fcmToken'], 'device-token');
      expect(document.setCalls, 0);
      expect(delays, [Duration.zero]);
    },
  );

  test('profile recovery stops when the auth session becomes stale', () async {
    final document = _RecordingDocumentReference()
      ..updateError = FirebaseException(
        plugin: 'cloud_firestore',
        code: 'not-found',
      );
    final service = MessagingService(
      messaging: _TokenFirebaseMessaging(),
      firestore: _RecordingFirestore(document),
    );
    final delayGate = Completer<void>();
    final registrar = PushNotificationRegistrar(
      service,
      profileWaitDelays: const <Duration>[Duration.zero],
      delay: (_) => delayGate.future,
    );
    addTearDown(registrar.dispose);

    final registration = registrar.register('user-1');
    await _waitUntil(() => document.updateCalls == 1);

    await registrar.unregister('user-1');
    delayGate.complete();
    await registration;

    // One registration attempt and one cleanup attempt. The stale session
    // must not continue the bounded backoff loop.
    expect(document.updateCalls, 2);
  });

  test('profile recovery has a bounded number of attempts', () async {
    final document = _RecordingDocumentReference()
      ..updateError = FirebaseException(
        plugin: 'cloud_firestore',
        code: 'not-found',
      );
    final service = MessagingService(
      messaging: _TokenFirebaseMessaging(),
      firestore: _RecordingFirestore(document),
    );
    final registrar = PushNotificationRegistrar(
      service,
      profileWaitDelays: const <Duration>[
        Duration.zero,
        Duration.zero,
        Duration.zero,
      ],
      delay: (_) async {},
    );
    addTearDown(registrar.dispose);

    await registrar.register('user-1');

    expect(document.updateCalls, 4);
    expect(document.setCalls, 0);
  });
}
