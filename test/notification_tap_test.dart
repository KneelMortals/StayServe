import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/routing/app_router.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/notifications/presentation/providers/notification_tap_handler.dart';
import 'package:stayserve/features/notifications/presentation/providers/pending_notification_route.dart';
import 'package:stayserve/firebase/messaging/messaging_service.dart';
import 'package:stayserve/models/user_model.dart';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class _FakeFirestore implements FirebaseFirestore {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Firestore is not available in the test');
}

class _FakeFirebaseMessaging implements FirebaseMessaging {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError(
    'Firebase Messaging is not available in the test',
  );
}

/// A messaging service that lets the test fire the taps.
class _FakeMessagingService extends MessagingService {
  _FakeMessagingService()
    : super(messaging: _FakeFirebaseMessaging(), firestore: _FakeFirestore());

  final StreamController<RemoteMessage> _opened =
      StreamController<RemoteMessage>.broadcast();

  /// The message the app was **opened** with.
  RemoteMessage? initialMessage;

  @override
  Stream<RemoteMessage> get onMessageOpenedApp => _opened.stream;

  @override
  Future<RemoteMessage?> getInitialMessage() async => initialMessage;

  void tap(RemoteMessage message) => _opened.add(message);

  Future<void> close() => _opened.close();
}

UserModel _profile(UserRole role) {
  return UserModel(
    uid: 'user-1',
    name: 'Asha',
    email: 'asha@example.com',
    role: role,
    createdAt: DateTime(2026, 1, 1),
    updatedAt: DateTime(2026, 1, 1),
  );
}

RemoteMessage _message(String type, Map<String, String> data) {
  return RemoteMessage(
    messageId: 'm1',
    data: {'type': type, ...data},
    notification: const RemoteNotification(title: 'Title', body: 'Body'),
  );
}

void main() {
  GoRouter buildRouter() {
    return GoRouter(
      initialLocation: '/owner/dashboard',
      routes: [
        GoRoute(
          path: '/splash',
          builder: (context, state) =>
              const Scaffold(body: Center(child: Text('SPLASH'))),
        ),
        GoRoute(
          path: '/owner/dashboard',
          builder: (context, state) =>
              const Scaffold(body: Center(child: Text('OWNER DASHBOARD'))),
        ),
        GoRoute(
          path: '/owner/requests',
          builder: (context, state) =>
              const Scaffold(body: Center(child: Text('OWNER REQUESTS'))),
        ),
        GoRoute(
          path: '/owner/invoices',
          builder: (context, state) =>
              const Scaffold(body: Center(child: Text('OWNER INVOICES'))),
        ),
      ],
    );
  }

  testWidgets('the tap opens the screen the notification came from', (
    tester,
  ) async {
    final messaging = _FakeMessagingService();
    final session = StreamController<AuthSession?>();
    addTearDown(session.close);

    final router = buildRouter();
    addTearDown(router.dispose);

    final container = ProviderContainer(
      overrides: [
        // The handler navigates with the router of the app — the test
        // brings its own.
        routerProvider.overrideWithValue(router),
        messagingServiceProvider.overrideWithValue(messaging),
        authSessionProvider.overrideWith((ref) => session.stream),
        currentUserProvider.overrideWithValue(
          MockUser(uid: 'user-1', email: 'asha@example.com'),
        ),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(messaging.close);

    // The handler is created by the app itself (`main.dart` watches it) —
    // the test has to do the same.
    container.read(notificationTapHandlerProvider);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();

    // The user signs in as an owner.
    session.add(
      AuthSession(
        user: MockUser(uid: 'user-1', email: 'asha@example.com'),
        profile: _profile(UserRole.owner),
      ),
    );
    await tester.pumpAndSettle();

    // The tap on the push message.
    messaging.tap(_message('joinRequest', {'requestId': 'JRQ-1'}));
    await tester.pumpAndSettle();

    expect(find.text('OWNER REQUESTS'), findsOneWidget);
    expect(
      router.routerDelegate.currentConfiguration.uri.path,
      '/owner/requests',
    );
  });

  testWidgets('the tap opens the invoices of the owner', (tester) async {
    final messaging = _FakeMessagingService();
    final session = StreamController<AuthSession?>();
    addTearDown(session.close);

    final router = buildRouter();
    addTearDown(router.dispose);

    final container = ProviderContainer(
      overrides: [
        // The handler navigates with the router of the app — the test
        // brings its own.
        routerProvider.overrideWithValue(router),
        messagingServiceProvider.overrideWithValue(messaging),
        authSessionProvider.overrideWith((ref) => session.stream),
        currentUserProvider.overrideWithValue(
          MockUser(uid: 'user-1', email: 'asha@example.com'),
        ),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(messaging.close);

    // The handler is created by the app itself (`main.dart` watches it) —
    // the test has to do the same.
    container.read(notificationTapHandlerProvider);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();

    session.add(
      AuthSession(
        user: MockUser(uid: 'user-1', email: 'asha@example.com'),
        profile: _profile(UserRole.owner),
      ),
    );
    await tester.pumpAndSettle();

    messaging.tap(_message('invoicePaid', {'requestId': 'JRQ-1'}));
    await tester.pumpAndSettle();

    expect(find.text('OWNER INVOICES'), findsOneWidget);
  });

  testWidgets('the app that was opened by a tap waits for the splash screen', (
    tester,
  ) async {
    final messaging = _FakeMessagingService();
    final session = StreamController<AuthSession?>();
    addTearDown(session.close);

    final router = buildRouter();
    addTearDown(router.dispose);

    final container = ProviderContainer(
      overrides: [
        // The handler navigates with the router of the app — the test
        // brings its own.
        routerProvider.overrideWithValue(router),
        messagingServiceProvider.overrideWithValue(messaging),
        authSessionProvider.overrideWith((ref) => session.stream),
        currentUserProvider.overrideWithValue(
          MockUser(uid: 'user-1', email: 'asha@example.com'),
        ),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(messaging.close);

    // The handler is created by the app itself (`main.dart` watches it) —
    // the test has to do the same.
    container.read(notificationTapHandlerProvider);
    router.go('/splash');

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();

    session.add(
      AuthSession(
        user: MockUser(uid: 'user-1', email: 'asha@example.com'),
        profile: _profile(UserRole.owner),
      ),
    );
    await tester.pumpAndSettle();

    messaging.tap(_message('joinRequest', {'requestId': 'JRQ-1'}));
    await tester.pumpAndSettle();

    // The splash screen is still running — it would navigate to the home
    // screen of the role. The route of the notification is remembered, so
    // that the splash screen opens **that** screen instead.
    expect(find.text('SPLASH'), findsOneWidget);
    expect(container.read(pendingNotificationRouteProvider), '/owner/requests');
  });

  testWidgets('the app that was opened with a message opens that screen', (
    tester,
  ) async {
    final messaging = _FakeMessagingService();
    messaging.initialMessage = _message('joinRequest', {'requestId': 'JRQ-1'});
    final session = StreamController<AuthSession?>();
    addTearDown(session.close);

    final router = buildRouter();
    addTearDown(router.dispose);

    final container = ProviderContainer(
      overrides: [
        // The handler navigates with the router of the app — the test
        // brings its own.
        routerProvider.overrideWithValue(router),
        messagingServiceProvider.overrideWithValue(messaging),
        authSessionProvider.overrideWith((ref) => session.stream),
        currentUserProvider.overrideWithValue(
          MockUser(uid: 'user-1', email: 'asha@example.com'),
        ),
      ],
    );
    addTearDown(container.dispose);
    addTearDown(messaging.close);

    // The handler is created by the app itself (`main.dart` watches it) —
    // the test has to do the same.
    container.read(notificationTapHandlerProvider);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();

    session.add(
      AuthSession(
        user: MockUser(uid: 'user-1', email: 'asha@example.com'),
        profile: _profile(UserRole.owner),
      ),
    );
    await tester.pumpAndSettle();

    // The message the app was opened with is handled as well.
    expect(find.text('OWNER REQUESTS'), findsOneWidget);
  });
}
