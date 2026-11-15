import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/routing/app_router.dart';
import 'package:stayserve/core/routing/back_to_dashboard.dart';
import 'package:stayserve/core/widgets/common_widgets.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/students/presentation/providers/student_providers.dart';
import 'package:stayserve/features/students/presentation/screens/room_detail_screen.dart';
import 'package:stayserve/firebase/functions/functions_service.dart';
import 'package:stayserve/firebase/payments/payment_repository.dart';
import 'package:stayserve/firebase/student/student_join_request_repository.dart';
import 'package:stayserve/firebase/student/student_repository.dart';
import 'package:stayserve/models/room_model.dart';
import 'package:stayserve/models/user_model.dart';
import 'package:stayserve/services/payment_service.dart';
import 'package:stayserve/services/user_location_provider.dart';

// ---------------------------------------------------------------------------
// Test doubles.
// ---------------------------------------------------------------------------

class _FakeFirestore implements FirebaseFirestore {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Firestore is not available in the test');
}

class _FakeStudentRepository extends StudentRepository {
  _FakeStudentRepository()
      : super(firestore: _FakeFirestore(), auth: MockFirebaseAuth());

  @override
  Future<bool> isRoomSaved(String roomId) async => false;
}

class _FakeLocationNotifier extends UserLocationNotifier {
  @override
  UserLocation? build() => null;
}

RoomModel _room({String ownerId = 'owner-1'}) {
  final now = DateTime(2026, 1, 1);
  return RoomModel(
    roomId: 'room-1',
    ownerId: ownerId,
    title: 'Test room',
    description: 'A room for the test',
    monthlyRent: 12000,
    securityDeposit: 30000,
    location: const Location(
      address: 'MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
    ),
    roomType: RoomType.single,
    furnishing: FurnishingType.semi,
    availableFrom: now,
    amenities: const ['WiFi'],
    occupancy: 1,
    genderPreference: GenderPreference.any,
    status: RoomStatus.available,
    createdAt: now,
    updatedAt: now,
  );
}

void main() {
  group('the owner cannot book their own room', () {
    testWidgets('the booking buttons are gone on their own listing',
        (tester) async {
      final user = MockUser(uid: 'owner-1', email: 'owner@example.com');

      final router = GoRouter(
        initialLocation: '/room/room-1',
        routes: [
          GoRoute(
            path: '/room/:roomId',
            builder: (context, state) =>
                RoomDetailScreen(roomId: state.pathParameters['roomId']!),
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(user),
            authStateProvider.overrideWith((ref) => Stream.value(user)),
            roomProvider.overrideWith((ref, roomId) => Stream.value(_room())),
            userLocationProvider.overrideWith(_FakeLocationNotifier.new),
            studentRepositoryProvider
                .overrideWithValue(_FakeStudentRepository()),
            studentJoinRequestProvider
                .overrideWithValue(StudentJoinRequestRepository(
              firestore: _FakeFirestore(),
              auth: MockFirebaseAuth(),
              functions: _NeverCalledFunctionsService(),
            )),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      // The owner sees their own listing — not a booking button.
      expect(find.text('This is your listing. You cannot book your own room.'),
          findsOneWidget);
      expect(
        find.widgetWithText(AppButton, 'Request to Book'),
        findsNothing,
      );
      expect(
        find.widgetWithText(AppButton, 'Contact Owner'),
        findsNothing,
      );
    });

    testWidgets('a student still gets the booking button', (tester) async {
      final user = MockUser(uid: 'student-1', email: 'student@example.com');

      final router = GoRouter(
        initialLocation: '/room/room-1',
        routes: [
          GoRoute(
            path: '/room/:roomId',
            builder: (context, state) =>
                RoomDetailScreen(roomId: state.pathParameters['roomId']!),
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(user),
            authStateProvider.overrideWith((ref) => Stream.value(user)),
            roomProvider.overrideWith((ref, roomId) => Stream.value(_room())),
            userLocationProvider.overrideWith(_FakeLocationNotifier.new),
            studentRepositoryProvider
                .overrideWithValue(_FakeStudentRepository()),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.widgetWithText(AppButton, 'Request to Book'),
        findsOneWidget,
      );
    });
  });

  group('the back button', () {
    /// A router with a shell — the shape of the real navigation.
    GoRouter buildRouter({String initialLocation = '/student/home'}) {
      return GoRouter(
        initialLocation: initialLocation,
        routes: [
          ShellRoute(
            builder: (context, state, child) => BackToPreviousPage(
              location: state.uri.path,
              child: Scaffold(body: child),
            ),
            routes: [
              GoRoute(
                path: '/student/home',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Student Home'))),
              ),
              GoRoute(
                path: '/student/search',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Student Search'))),
              ),
              GoRoute(
                path: '/student/requests',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Student Requests'))),
              ),
            ],
          ),
        ],
      );
    }

    Future<void> pumpApp(
      WidgetTester tester,
      GoRouter router,
      MockUser user,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(user),
            authStateProvider.overrideWith((ref) => Stream.value(user)),
            authSessionProvider.overrideWith((ref) => Stream.value(
                  AuthSession(user: user),
                )),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();
    }

    /// The **system back button** — the same way Android delivers it.
    Future<void> pressSystemBack(WidgetTester tester) async {
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
    }

    testWidgets('goes back to the previous page', (tester) async {
      final user = MockUser(uid: 'student-1', email: 'student@example.com');
      final router = buildRouter();

      await pumpApp(tester, router, user);
      expect(find.text('Student Home'), findsOneWidget);

      // The user opens the search.
      router.go('/student/search');
      await tester.pumpAndSettle();
      expect(find.text('Student Search'), findsOneWidget);

      // The system back button.
      await pressSystemBack(tester);

      // The user is back on the page they came from — not out of the app.
      expect(find.text('Student Home'), findsOneWidget);
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/student/home',
      );
    });

    testWidgets('goes back through the whole history', (tester) async {
      final user = MockUser(uid: 'student-1', email: 'student@example.com');
      final router = buildRouter();

      await pumpApp(tester, router, user);

      router.go('/student/search');
      await tester.pumpAndSettle();
      router.go('/student/requests');
      await tester.pumpAndSettle();
      expect(find.text('Student Requests'), findsOneWidget);

      await pressSystemBack(tester);
      expect(find.text('Student Search'), findsOneWidget);

      await pressSystemBack(tester);
      expect(find.text('Student Home'), findsOneWidget);
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/student/home',
      );
    });

    testWidgets('after the sign-in the back button does not lead to the login '
        'screen', (tester) async {
      final user = MockUser(uid: 'student-1', email: 'student@example.com');

      final router = GoRouter(
        initialLocation: '/login',
        routes: [
          GoRoute(
            path: '/login',
            builder: (context, state) => const BackToPreviousPage(
              location: '/login',
              child: Scaffold(body: Center(child: Text('Login'))),
            ),
          ),
          ShellRoute(
            builder: (context, state, child) => BackToPreviousPage(
              location: state.uri.path,
              child: Scaffold(body: child),
            ),
            routes: [
              GoRoute(
                path: '/student/home',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Student Home'))),
              ),
              GoRoute(
                path: '/student/search',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Student Search'))),
              ),
            ],
          ),
        ],
      );

      await pumpApp(tester, router, user);
      expect(find.text('Login'), findsOneWidget);

      // The user signs in — the app lands on the dashboard.
      router.go('/student/home');
      await tester.pumpAndSettle();

      router.go('/student/search');
      await tester.pumpAndSettle();

      // The back button leads to the dashboard — not to the login screen.
      await pressSystemBack(tester);

      expect(find.text('Student Home'), findsOneWidget);
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/student/home',
      );
    });

    testWidgets('on the first page it asks for a second press before the app '
        'closes', (tester) async {
      final user = MockUser(uid: 'student-1', email: 'student@example.com');
      final router = buildRouter();

      // The calls to the platform — `SystemNavigator.pop` closes the app.
      final platformCalls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
        platformCalls.add(call);
        return null;
      });
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(SystemChannels.platform, null);
      });

      await pumpApp(tester, router, user);
      expect(find.text('Student Home'), findsOneWidget);

      // The first press — the app stays open and asks for a confirmation.
      await tester.binding.handlePopRoute();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(
        find.text('Press back again to leave StayServe'),
        findsOneWidget,
      );
      expect(
        platformCalls.where((c) => c.method == 'SystemNavigator.pop'),
        isEmpty,
      );
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/student/home',
      );

      // The second press — now the app really closes.
      await tester.binding.handlePopRoute();
      await tester.pump();

      expect(
        platformCalls.where((c) => c.method == 'SystemNavigator.pop').length,
        1,
      );
    });
  });

  group('the back button on a section screen', () {
    /// The real shells — they know which screen is a section and which one
    /// is the dashboard of the role.
    GoRouter buildOwnerRouter() {
      return GoRouter(
        initialLocation: '/owner/dashboard',
        routes: [
          ShellRoute(
            builder: (context, state, child) => OwnerShell(
              location: state.uri.path,
              child: child,
            ),
            routes: [
              GoRoute(
                path: '/owner/dashboard',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Owner Dashboard'))),
              ),
              GoRoute(
                path: '/owner/rooms',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Owner Rooms'))),
              ),
              GoRoute(
                path: '/owner/requests',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Owner Requests'))),
              ),
              GoRoute(
                path: '/owner/invoices',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Owner Invoices'))),
              ),
            ],
          ),
        ],
      );
    }

    GoRouter buildAdminRouter() {
      return GoRouter(
        initialLocation: '/admin/dashboard',
        routes: [
          ShellRoute(
            builder: (context, state, child) => AdminShell(
              location: state.uri.path,
              child: child,
            ),
            routes: [
              GoRoute(
                path: '/admin/dashboard',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Admin Dashboard'))),
              ),
              GoRoute(
                path: '/admin/payments',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Admin Payments'))),
              ),
              GoRoute(
                path: '/admin/users',
                builder: (context, state) =>
                    const Scaffold(body: Center(child: Text('Admin Users'))),
              ),
            ],
          ),
        ],
      );
    }

    Future<void> pumpApp(
      WidgetTester tester,
      GoRouter router,
      MockUser user,
    ) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(user),
            authStateProvider.overrideWith((ref) => Stream.value(user)),
          ],
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();
    }

    Future<void> pressSystemBack(WidgetTester tester) async {
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
    }

    for (final section in [
      '/owner/rooms',
      '/owner/requests',
      '/owner/invoices',
    ]) {
      testWidgets('the back button on $section leads to the dashboard',
          (tester) async {
        final user = MockUser(uid: 'owner-1', email: 'owner@example.com');
        final router = buildOwnerRouter();
        addTearDown(router.dispose);

        await pumpApp(tester, router, user);

        router.go(section);
        await tester.pumpAndSettle();

        await pressSystemBack(tester);

        // The dashboard — and **not** out of the app.
        expect(find.text('Owner Dashboard'), findsOneWidget);
        expect(
          router.routerDelegate.currentConfiguration.uri.path,
          '/owner/dashboard',
        );
      });
    }

    testWidgets('the back button on an admin screen leads to the dashboard',
        (tester) async {
      final user = MockUser(uid: 'admin-1', email: 'admin@example.com');
      final router = buildAdminRouter();
      addTearDown(router.dispose);

      await pumpApp(tester, router, user);

      router.go('/admin/payments');
      await tester.pumpAndSettle();
      expect(find.text('Admin Payments'), findsOneWidget);

      await pressSystemBack(tester);

      expect(find.text('Admin Dashboard'), findsOneWidget);
      expect(
        router.routerDelegate.currentConfiguration.uri.path,
        '/admin/dashboard',
      );
    });

    testWidgets('the back button on a section does not walk through the '
        'other tabs', (tester) async {
      final user = MockUser(uid: 'owner-1', email: 'owner@example.com');
      final router = buildOwnerRouter();
      addTearDown(router.dispose);

      await pumpApp(tester, router, user);

      // The owner walks through the tabs …
      router.go('/owner/rooms');
      await tester.pumpAndSettle();
      router.go('/owner/requests');
      await tester.pumpAndSettle();
      router.go('/owner/invoices');
      await tester.pumpAndSettle();

      // … and the back button leads to the **dashboard**, not to the tab
      // they came from.
      await pressSystemBack(tester);

      expect(find.text('Owner Dashboard'), findsOneWidget);
    });

    testWidgets('a second back press on the dashboard asks to leave the app',
        (tester) async {
      final user = MockUser(uid: 'owner-1', email: 'owner@example.com');
      final router = buildOwnerRouter();
      addTearDown(router.dispose);

      final platformCalls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
        platformCalls.add(call);
        return null;
      });
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(SystemChannels.platform, null);
      });

      await pumpApp(tester, router, user);

      router.go('/owner/rooms');
      await tester.pumpAndSettle();

      // The first back press leads to the dashboard …
      await pressSystemBack(tester);
      expect(find.text('Owner Dashboard'), findsOneWidget);

      // … and the history is reset, so the next press asks to leave the
      // app instead of going back to "My Rooms".
      await tester.binding.handlePopRoute();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(
        find.text('Press back again to leave StayServe'),
        findsOneWidget,
      );
      expect(
        platformCalls.where((c) => c.method == 'SystemNavigator.pop'),
        isEmpty,
      );
    });
  });

  group('the UPI payment intent', () {
    test('knows whether this caller has to pay', () {
      final intent = UpiPaymentIntent.fromData({
        'uri': 'upi://pay?pa=x',
        'amount': 3600.0,
        'feePercentage': 30.0,
        'payeeVpa': 'shauryaprataprai461-2@oksbi',
        'payeeName': 'StayServe',
        'transactionRef': 'SS123',
        'payer': 'owner',
        'studentPays': false,
        'youPay': true,
      });

      // The owner has to pay — the sheet shows the real UPI button.
      expect(intent.youPay, isTrue);
      expect(intent.studentPays, isFalse);
      expect(intent.payer, 'owner');
    });

    test('the student only sees who has to pay', () {
      final intent = UpiPaymentIntent.fromData({
        'uri': '',
        'amount': 3600.0,
        'feePercentage': 30.0,
        'payeeVpa': 'shauryaprataprai461-2@oksbi',
        'payeeName': 'StayServe',
        'transactionRef': '',
        'payer': 'owner',
        'studentPays': false,
        'youPay': false,
      });

      expect(intent.youPay, isFalse);
      expect(intent.alreadySettled, isFalse);
    });
  });

  group('the UPI intent of the platform', () {
    /// The intent the server builds for a request of the real app.
    String buildIntent({
      String note = 'StayServe fee JRQ-1794561182291',
      String ref = 'SS794561182291',
    }) {
      return Uri(
        scheme: 'upi',
        path: 'pay',
        queryParameters: {
          'pa': 'shauryaprataprai461-2@oksbi',
          'pn': 'StayServe',
          'am': '133.00',
          'cu': 'INR',
          'tr': ref,
          'tn': note,
        },
      ).toString();
    }

    test('the intent of the platform is valid', () {
      expect(UpiIntentValidator.validate(buildIntent()), isNull);
    });

    test('a transaction note that is too long is refused', () {
      // The note used to be "StayServe platform fee for request
      // JRQ-1794561182291" — 52 characters. The UPI specification allows
      // only 50, and the UPI apps refused the whole payment with a
      // misleading "the amount exceeds the limit".
      final note = 'StayServe platform fee for request JRQ-1794561182291';
      expect(note.length, greaterThan(UpiIntentLimits.transactionNote));

      final problem = UpiIntentValidator.validate(buildIntent(note: note));
      expect(problem, isNotNull);
      expect(problem, contains('transaction note'));
    });

    test('a transaction reference that is too long is refused', () {
      final problem = UpiIntentValidator.validate(
        buildIntent(ref: 'S' * (UpiIntentLimits.transactionRef + 1)),
      );
      expect(problem, isNotNull);
      expect(problem, contains('transaction reference'));
    });

    test('an intent without a payee is refused', () {
      expect(
        UpiIntentValidator.validate('upi://pay?am=133.00'),
        isNotNull,
      );
    });

    test('an intent that is not a UPI link is refused', () {
      expect(
        UpiIntentValidator.validate('https://example.com/pay'),
        isNotNull,
      );
    });

    test('an empty intent is refused', () {
      expect(UpiIntentValidator.validate(''), isNotNull);
    });
  });

  group('the user model', () {
    test('reads the scheduled deletion', () {
      final deleteAfter = DateTime(2026, 2, 1);
      final user = UserModel.fromJson({
        'uid': 'u1',
        'name': 'Test',
        'email': 'test@example.com',
        'role': 'student',
        'createdAt': Timestamp.fromDate(DateTime(2026, 1, 1)),
        'updatedAt': Timestamp.fromDate(DateTime(2026, 1, 1)),
        'deletionScheduled': true,
        'deleteAfter': Timestamp.fromDate(deleteAfter),
      });

      expect(user.deletionScheduled, isTrue);
      expect(user.deleteAfter, isNotNull);
      expect(user.deleteAfter!.day, deleteAfter.day);
    });

    test('a user without the fields is not scheduled', () {
      final user = UserModel.fromJson({
        'uid': 'u1',
        'name': 'Test',
        'email': 'test@example.com',
        'role': 'student',
        'createdAt': Timestamp.fromDate(DateTime(2026, 1, 1)),
        'updatedAt': Timestamp.fromDate(DateTime(2026, 1, 1)),
      });

      expect(user.deletionScheduled, isFalse);
      expect(user.deleteAfter, isNull);
    });
  });
}

/// A functions service that must never be called.
class _NeverCalledFunctionsService extends FunctionsService {
  _NeverCalledFunctionsService() : super(_FakeFirebaseFunctions());
}

class _FakeFirebaseFunctions implements FirebaseFunctions {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Functions are not available in the test');
}
