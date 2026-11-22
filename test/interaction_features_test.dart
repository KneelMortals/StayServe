import 'dart:async';

import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'package:stayserve/core/index.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/messaging/presentation/providers/messaging_providers.dart';
import 'package:stayserve/features/messaging/presentation/screens/chat_screen.dart';
import 'package:stayserve/features/messaging/presentation/screens/conversations_screen.dart';
import 'package:stayserve/features/owners/presentation/providers/owner_providers.dart'
    as owner;
import 'package:stayserve/features/owners/presentation/screens/owner_requests_screen.dart';
import 'package:stayserve/features/students/presentation/providers/student_providers.dart'
    as student;
import 'package:stayserve/features/students/presentation/screens/student_requests_screen.dart';
import 'package:stayserve/firebase/messaging/conversation_repository.dart';
import 'package:stayserve/firebase/owner/owner_repository.dart'
    as owner_repository;
import 'package:stayserve/models/interaction_model.dart';
import 'package:stayserve/models/join_request_model.dart';
import 'package:stayserve/models/messaging_model.dart';

import 'support/audit_fakes.dart';

void main() {
  group('the full-screen room photo viewer', () {
    testWidgets('opens at the selected photo and closes again', (tester) async {
      const images = [
        'https://example.test/room-1.jpg',
        'https://example.test/room-2.jpg',
        'https://example.test/room-3.jpg',
      ];

      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: Center(
                child: ElevatedButton(
                  onPressed: () => RoomImageViewer.show(
                    context,
                    imageUrls: images,
                    initialIndex: 1,
                  ),
                  child: const Text('Open photos'),
                ),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Open photos'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.byKey(const ValueKey('room-image-viewer')), findsOneWidget);
      expect(find.text('2 / 3'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('room-image-viewer-page-count')),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('room-image-viewer-close')));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();

      expect(find.byKey(const ValueKey('room-image-viewer')), findsNothing);
      expect(find.text('Open photos'), findsOneWidget);
    });

    testWidgets('covers shell navigation when opened from a nested navigator', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Navigator(
              key: const ValueKey('nested-shell-navigator'),
              onGenerateRoute: (_) => MaterialPageRoute<void>(
                builder: (context) => Scaffold(
                  body: Center(
                    child: ElevatedButton(
                      onPressed: () => RoomImageViewer.show(
                        context,
                        imageUrls: const ['https://example.test/room-1.jpg'],
                      ),
                      child: const Text('Open photos'),
                    ),
                  ),
                ),
              ),
            ),
            bottomNavigationBar: NavigationBar(
              destinations: [
                NavigationDestination(
                  icon: Icon(Icons.home_outlined),
                  label: 'Shell navigation',
                ),
                NavigationDestination(
                  icon: Icon(Icons.person_outline),
                  label: 'Profile',
                ),
              ],
            ),
          ),
        ),
      );

      expect(find.text('Shell navigation'), findsOneWidget);
      await tester.tap(find.text('Open photos'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.byKey(const ValueKey('room-image-viewer')), findsOneWidget);
      final rootNavigator = tester.state<NavigatorState>(
        find.byType(Navigator).first,
      );
      final nestedNavigator = tester.state<NavigatorState>(
        find.byKey(const ValueKey('nested-shell-navigator')),
      );
      expect(rootNavigator.canPop(), isTrue);
      expect(nestedNavigator.canPop(), isFalse);
    });
  });

  group('chat participant identity and blocking', () {
    testWidgets('an owner sees the student name and can block and unblock', (
      tester,
    ) async {
      final repository = _MutableConversationRepository(
        peerId: 'student-1',
        peerName: 'Arjun Shah',
        peerRole: 'student',
        roomTitle: 'Sunset Studio',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'owner-1', email: 'owner@example.test'),
            ),
            conversationRepositoryProvider.overrideWithValue(repository),
          ],
          child: const MaterialApp(
            home: ChatScreen(
              conversationId: 'conversation-1',
              peerId: 'student-1',
              requestId: 'request-1',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Arjun Shah'), findsOneWidget);
      expect(find.text('Sunset Studio'), findsOneWidget);
      expect(find.byTooltip('Block Arjun Shah'), findsOneWidget);

      await tester.tap(find.byTooltip('Block Arjun Shah'));
      await tester.pumpAndSettle();
      expect(find.text('Block Arjun Shah?'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Block'));
      await tester.pumpAndSettle();

      expect(repository.blockedByMe, isTrue);
      expect(
        find.text('You blocked Arjun Shah. Unblock them to send messages.'),
        findsOneWidget,
      );
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      expect(find.byTooltip('Unblock Arjun Shah'), findsOneWidget);

      await tester.tap(find.byTooltip('Unblock Arjun Shah'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Unblock'));
      await tester.pumpAndSettle();

      expect(repository.blockedByMe, isFalse);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
      expect(find.byTooltip('Block Arjun Shah'), findsOneWidget);
    });

    testWidgets('falls back to the participant uid when no name is available', (
      tester,
    ) async {
      final repository = _MutableConversationRepository(
        peerId: 'student-1',
        peerName: '',
        peerRole: 'student',
        roomTitle: '',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'owner-1', email: 'owner@example.test'),
            ),
            conversationRepositoryProvider.overrideWithValue(repository),
          ],
          child: const MaterialApp(
            home: ChatScreen(
              conversationId: 'conversation-1',
              peerId: 'student-1',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('student-1'), findsOneWidget);
      expect(find.text('Chat'), findsNothing);
      expect(find.text('Conversation'), findsNothing);
    });

    testWidgets('a peer block makes the conversation read-only', (
      tester,
    ) async {
      final repository = _MutableConversationRepository(
        peerId: 'owner-1',
        peerName: 'Meera Nair',
        peerRole: 'owner',
        roomTitle: 'Garden Flat',
        blockedMe: true,
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'student-1', email: 'student@example.test'),
            ),
            conversationRepositoryProvider.overrideWithValue(repository),
          ],
          child: const MaterialApp(
            home: ChatScreen(
              conversationId: 'conversation-1',
              peerId: 'owner-1',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Meera Nair'), findsOneWidget);
      expect(find.text('Garden Flat'), findsOneWidget);
      expect(
        find.text('Meera Nair blocked you. You cannot send new messages.'),
        findsOneWidget,
      );
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      expect(find.byTooltip('Meera Nair blocked you'), findsOneWidget);
    });

    testWidgets('a metadata refresh pauses the composer until it completes', (
      tester,
    ) async {
      final refresh = Completer<ConversationInteractionDetails>();
      var calls = 0;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'owner-1', email: 'owner@example.test'),
            ),
            conversationRepositoryProvider.overrideWithValue(
              _MutableConversationRepository(
                peerId: 'student-1',
                peerName: 'Arjun Shah',
                peerRole: 'student',
                roomTitle: 'Sunset Studio',
              ),
            ),
            conversationInteractionDetailsProvider.overrideWith((ref, key) {
              calls++;
              if (calls == 1) {
                return Future.value(
                  const ConversationInteractionDetails(
                    conversationId: 'conversation-1',
                    peerId: 'student-1',
                    peerName: 'Arjun Shah',
                    peerRole: 'student',
                    roomTitle: 'Sunset Studio',
                    canSend: true,
                  ),
                );
              }
              return refresh.future;
            }),
          ],
          child: const MaterialApp(
            home: ChatScreen(
              conversationId: 'conversation-1',
              peerId: 'student-1',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);

      final container = ProviderScope.containerOf(
        tester.element(find.byType(ChatScreen)),
      );
      container.invalidate(
        conversationInteractionDetailsProvider((
          conversationId: 'conversation-1',
          roomId: null,
          requestId: null,
        )),
      );
      await tester.pump();
      await tester.pump();

      expect(calls, greaterThan(1));
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);

      refresh.complete(
        const ConversationInteractionDetails(
          conversationId: 'conversation-1',
          peerId: 'student-1',
          peerName: 'Arjun Shah',
          peerRole: 'student',
          roomTitle: 'Sunset Studio',
          canSend: true,
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
    });
  });

  group('conversation-list participant identity', () {
    testWidgets('falls back to the participant uid when no name is available', (
      tester,
    ) async {
      final conversation = ConversationModel(
        conversationId: 'conversation-1',
        participants: const ['student-1', 'owner-1'],
        lastMessage: 'Hello',
        lastMessageAt: DateTime(2026, 1, 1),
        unreadCount: const {},
        createdAt: DateTime(2026, 1, 1),
        updatedAt: DateTime(2026, 1, 1),
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'student-1', email: 'student@example.test'),
            ),
            conversationsProvider.overrideWith(
              (ref) => Stream.value([conversation]),
            ),
            conversationInteractionDetailsProvider.overrideWith(
              (ref, key) async =>
                  throw Exception('interaction details unavailable'),
            ),
          ],
          child: const MaterialApp(home: ConversationsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('owner-1'), findsOneWidget);
      expect(find.text('Conversation'), findsNothing);
    });
  });

  group('cross-screen interaction invalidation', () {
    testWidgets('a block refreshes every mounted interaction context', (
      tester,
    ) async {
      final repository = _MutableConversationRepository(
        peerId: 'owner-1',
        peerName: 'Meera Nair',
        peerRole: 'owner',
        roomTitle: 'Garden Flat',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            conversationRepositoryProvider.overrideWithValue(repository),
          ],
          child: const MaterialApp(home: _InteractionInvalidationHarness()),
        ),
      );
      await tester.pumpAndSettle();

      expect(repository.conversationDetailCalls, 2);
      expect(repository.bookingDetailCalls, 2);
      expect(repository.roomContactCalls, 2);

      await tester.tap(find.text('Invalidate interactions'));
      await tester.pumpAndSettle();

      expect(repository.conversationDetailCalls, 4);
      expect(repository.bookingDetailCalls, 4);
      expect(repository.roomContactCalls, 4);
    });
  });

  group('booking participant identity and blocking', () {
    testWidgets('the owner sees the real student and listing names', (
      tester,
    ) async {
      final repository = _MutableConversationRepository(
        peerId: 'student-1',
        peerName: 'Arjun Shah',
        peerRole: 'student',
        roomTitle: 'Sunset Studio',
      );
      final request = _request(
        studentName: 'Old Student Name',
        ownerName: 'Meera Nair',
        roomTitle: 'Old Room Name',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'owner-1', email: 'owner@example.test'),
            ),
            conversationRepositoryProvider.overrideWithValue(repository),
            owner_repository.ownerRepositoryProvider.overrideWithValue(
              FakeOwnerRepository(),
            ),
            owner.myJoinRequestsProvider.overrideWith(
              (ref) => Stream.value([request]),
            ),
          ],
          child: const MaterialApp(home: OwnerRequestsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Arjun Shah'), findsOneWidget);
      expect(find.text('Sunset Studio'), findsOneWidget);
      expect(find.text('Old Student Name'), findsNothing);
      expect(find.text('Old Room Name'), findsNothing);

      await tester.tap(find.widgetWithText(AppButton, 'Block student'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Block'));
      await tester.pumpAndSettle();

      expect(repository.blockedByMe, isTrue);
      expect(find.widgetWithText(AppButton, 'Unblock student'), findsOneWidget);

      await tester.tap(find.widgetWithText(AppButton, 'Unblock student'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Unblock'));
      await tester.pumpAndSettle();

      expect(repository.blockedByMe, isFalse);
      expect(find.widgetWithText(AppButton, 'Block student'), findsOneWidget);
    });

    testWidgets('owner payment details fail closed while the pair is blocked', (
      tester,
    ) async {
      final repository = _MutableConversationRepository(
        peerId: 'student-1',
        peerName: 'Arjun Shah',
        peerRole: 'student',
        roomTitle: 'Sunset Studio',
        blockedByMe: true,
      );
      final request = _request(
        status: JoinRequestStatus.studentConfirmed,
        platformFeePayer: 'student',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'owner-1', email: 'owner@example.test'),
            ),
            conversationRepositoryProvider.overrideWithValue(repository),
            owner_repository.ownerRepositoryProvider.overrideWithValue(
              FakeOwnerRepository(),
            ),
            owner.myJoinRequestsProvider.overrideWith(
              (ref) => Stream.value([request]),
            ),
          ],
          child: const MaterialApp(home: OwnerRequestsScreen()),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('All Requests'));
      await tester.pumpAndSettle();

      final paymentDetails = find.widgetWithText(AppButton, 'Payment details');
      expect(paymentDetails, findsOneWidget);
      expect(
        tester.widget<AppButton>(paymentDetails).onPressed,
        isNull,
        reason:
            'The details sheet uses the protected payment-intent path, so it '
            'must not remain actionable while the pair is blocked.',
      );
    });

    testWidgets('the student sees the real owner and listing names', (
      tester,
    ) async {
      final repository = _MutableConversationRepository(
        peerId: 'owner-1',
        peerName: 'Meera Nair',
        peerRole: 'owner',
        roomTitle: 'Garden Flat',
      );
      final request = _request(
        studentName: 'Arjun Shah',
        ownerName: 'Old Owner Name',
        roomTitle: 'Old Room Name',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'student-1', email: 'student@example.test'),
            ),
            conversationRepositoryProvider.overrideWithValue(repository),
            student.myJoinRequestsProvider.overrideWith(
              (ref) => Stream.value([request]),
            ),
          ],
          child: const MaterialApp(home: StudentRequestsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Owner: Meera Nair'), findsOneWidget);
      expect(find.text('Garden Flat'), findsOneWidget);
      expect(find.text('Old Owner Name'), findsNothing);
      expect(find.text('Old Room Name'), findsNothing);

      await tester.tap(find.widgetWithText(AppButton, 'Block owner'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Block'));
      await tester.pumpAndSettle();

      expect(repository.blockedByMe, isTrue);
      expect(find.widgetWithText(AppButton, 'Unblock owner'), findsOneWidget);

      await tester.tap(find.widgetWithText(AppButton, 'Unblock owner'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Unblock'));
      await tester.pumpAndSettle();

      expect(repository.blockedByMe, isFalse);
      expect(find.widgetWithText(AppButton, 'Block owner'), findsOneWidget);
    });

    testWidgets('owner request fallbacks use the participant and listing ids', (
      tester,
    ) async {
      final request = _request(studentName: '', ownerName: '', roomTitle: '');

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'owner-1', email: 'owner@example.test'),
            ),
            owner_repository.ownerRepositoryProvider.overrideWithValue(
              FakeOwnerRepository(),
            ),
            owner.myJoinRequestsProvider.overrideWith(
              (ref) => Stream.value([request]),
            ),
            bookingInteractionDetailsProvider.overrideWith(
              (ref, requestId) async =>
                  throw Exception('interaction details unavailable'),
            ),
          ],
          child: const MaterialApp(home: OwnerRequestsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('student-1'), findsOneWidget);
      expect(find.text('room-1'), findsOneWidget);
      expect(find.text('Student'), findsNothing);
      expect(find.text('Room room-1'), findsNothing);
    });

    testWidgets(
      'student request fallbacks use the participant and listing ids',
      (tester) async {
        final request = _request(studentName: '', ownerName: '', roomTitle: '');

        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              currentUserProvider.overrideWithValue(
                MockUser(uid: 'student-1', email: 'student@example.test'),
              ),
              student.roomProvider.overrideWith(
                (ref, roomId) => Stream.value(null),
              ),
              student.myJoinRequestsProvider.overrideWith(
                (ref) => Stream.value([request]),
              ),
              bookingInteractionDetailsProvider.overrideWith(
                (ref, requestId) async =>
                    throw Exception('interaction details unavailable'),
              ),
            ],
            child: const MaterialApp(home: StudentRequestsScreen()),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Owner: owner-1'), findsOneWidget);
        expect(find.text('room-1'), findsOneWidget);
        expect(find.text('Owner'), findsNothing);
        expect(find.text('Room room-1'), findsNothing);
      },
    );

    testWidgets('an unavailable owner interaction fails closed', (
      tester,
    ) async {
      final request = _request();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'owner-1', email: 'owner@example.test'),
            ),
            owner_repository.ownerRepositoryProvider.overrideWithValue(
              FakeOwnerRepository(),
            ),
            owner.myJoinRequestsProvider.overrideWith(
              (ref) => Stream.value([request]),
            ),
            bookingInteractionDetailsProvider.overrideWith(
              (ref, requestId) async =>
                  throw Exception('interaction details unavailable'),
            ),
          ],
          child: const MaterialApp(home: OwnerRequestsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text(
          'Could not verify the participant status. New messages and booking '
          'progression are paused.',
        ),
        findsOneWidget,
      );
      expect(
        tester
            .widget<AppButton>(
              find.widgetWithText(AppButton, 'Message student'),
            )
            .onPressed,
        isNull,
      );
      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'Approve'))
            .onPressed,
        isNull,
      );
      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'Block student'))
            .onPressed,
        isNull,
      );
      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'Decline'))
            .onPressed,
        isNotNull,
      );
    });

    testWidgets('an owner metadata refresh pauses protected actions', (
      tester,
    ) async {
      final refresh = Completer<BookingInteractionDetails>();
      var calls = 0;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'owner-1', email: 'owner@example.test'),
            ),
            owner_repository.ownerRepositoryProvider.overrideWithValue(
              FakeOwnerRepository(),
            ),
            owner.myJoinRequestsProvider.overrideWith(
              (ref) => Stream.value([_request()]),
            ),
            bookingInteractionDetailsProvider.overrideWith((ref, requestId) {
              calls++;
              if (calls == 1) {
                return Future.value(
                  const BookingInteractionDetails(
                    requestId: 'request-1',
                    studentId: 'student-1',
                    ownerId: 'owner-1',
                    studentName: 'Arjun Shah',
                    ownerName: 'Meera Nair',
                    roomId: 'room-1',
                    roomTitle: 'Garden Flat',
                    canSend: true,
                  ),
                );
              }
              return refresh.future;
            }),
          ],
          child: const MaterialApp(home: OwnerRequestsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'Approve'))
            .onPressed,
        isNotNull,
      );

      final container = ProviderScope.containerOf(
        tester.element(find.byType(OwnerRequestsScreen)),
      );
      container.invalidate(bookingInteractionDetailsProvider('request-1'));
      await tester.pump();
      await tester.pump();

      expect(calls, greaterThan(1));
      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'Approve'))
            .onPressed,
        isNull,
      );
      expect(
        tester
            .widget<AppButton>(
              find.widgetWithText(AppButton, 'Message student'),
            )
            .onPressed,
        isNull,
      );

      refresh.complete(
        const BookingInteractionDetails(
          requestId: 'request-1',
          studentId: 'student-1',
          ownerId: 'owner-1',
          studentName: 'Arjun Shah',
          ownerName: 'Meera Nair',
          roomId: 'room-1',
          roomTitle: 'Garden Flat',
          canSend: true,
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'Approve'))
            .onPressed,
        isNotNull,
      );
    });

    testWidgets('an unavailable student interaction fails closed', (
      tester,
    ) async {
      final request = _request(status: JoinRequestStatus.ownerConfirmed);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'student-1', email: 'student@example.test'),
            ),
            student.myJoinRequestsProvider.overrideWith(
              (ref) => Stream.value([request]),
            ),
            bookingInteractionDetailsProvider.overrideWith(
              (ref, requestId) async =>
                  throw Exception('interaction details unavailable'),
            ),
          ],
          child: const MaterialApp(home: StudentRequestsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'Message owner'))
            .onPressed,
        isNull,
      );
      expect(
        tester
            .widget<AppButton>(
              find.widgetWithText(AppButton, 'Confirm Request'),
            )
            .onPressed,
        isNull,
      );
      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'Cancel'))
            .onPressed,
        isNotNull,
      );
    });

    testWidgets('a student metadata refresh pauses protected actions', (
      tester,
    ) async {
      final refresh = Completer<BookingInteractionDetails>();
      var calls = 0;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            currentUserProvider.overrideWithValue(
              MockUser(uid: 'student-1', email: 'student@example.test'),
            ),
            student.myJoinRequestsProvider.overrideWith(
              (ref) => Stream.value([
                _request(status: JoinRequestStatus.ownerConfirmed),
              ]),
            ),
            bookingInteractionDetailsProvider.overrideWith((ref, requestId) {
              calls++;
              if (calls == 1) {
                return Future.value(
                  const BookingInteractionDetails(
                    requestId: 'request-1',
                    studentId: 'student-1',
                    ownerId: 'owner-1',
                    studentName: 'Arjun Shah',
                    ownerName: 'Meera Nair',
                    roomId: 'room-1',
                    roomTitle: 'Garden Flat',
                    canSend: true,
                  ),
                );
              }
              return refresh.future;
            }),
          ],
          child: const MaterialApp(home: StudentRequestsScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        tester
            .widget<AppButton>(
              find.widgetWithText(AppButton, 'Confirm Request'),
            )
            .onPressed,
        isNotNull,
      );

      final container = ProviderScope.containerOf(
        tester.element(find.byType(StudentRequestsScreen)),
      );
      container.invalidate(bookingInteractionDetailsProvider('request-1'));
      await tester.pump();
      await tester.pump();

      expect(calls, greaterThan(1));
      expect(
        tester
            .widget<AppButton>(
              find.widgetWithText(AppButton, 'Confirm Request'),
            )
            .onPressed,
        isNull,
      );
      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'Message owner'))
            .onPressed,
        isNull,
      );

      refresh.complete(
        const BookingInteractionDetails(
          requestId: 'request-1',
          studentId: 'student-1',
          ownerId: 'owner-1',
          studentName: 'Arjun Shah',
          ownerName: 'Meera Nair',
          roomId: 'room-1',
          roomTitle: 'Garden Flat',
          canSend: true,
        ),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<AppButton>(
              find.widgetWithText(AppButton, 'Confirm Request'),
            )
            .onPressed,
        isNotNull,
      );
    });
  });

  test('malformed interaction responses fail closed', () {
    expect(
      () => ConversationInteractionDetails.fromJson({
        'conversationId': 'conversation-1',
        'peerId': 'owner-1',
        'peerName': 'Meera Nair',
        'blockedByMe': false,
        'blockedMe': false,
      }),
      throwsFormatException,
    );
    expect(
      () => BookingInteractionDetails.fromJson({
        'requestId': 'request-1',
        'studentId': 'student-1',
        'ownerId': 'owner-1',
        'studentName': 'Arjun Shah',
        'ownerName': 'Meera Nair',
        'blockedByMe': false,
        'blockedMe': false,
      }),
      throwsFormatException,
    );
    expect(
      () => RoomContactDetails.fromJson({
        'roomId': 'room-1',
        'ownerId': 'owner-1',
        'ownerName': 'Meera Nair',
        'blockedByMe': false,
        'blockedMe': false,
      }),
      throwsFormatException,
    );
  });

  test('interaction models preserve the directional block semantics', () {
    final details = ConversationInteractionDetails.fromJson({
      'conversationId': 'conversation-1',
      'peerId': 'owner-1',
      'peerName': 'Meera Nair',
      'blockedByMe': true,
      'blockedMe': false,
      'canSend': false,
    });

    expect(details.blockedByMe, isTrue);
    expect(details.blockedMe, isFalse);
    expect(details.isBlocked, isTrue);
  });
}

class _InteractionInvalidationHarness extends ConsumerWidget {
  const _InteractionInvalidationHarness();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(
      conversationInteractionDetailsProvider((
        conversationId: 'conversation-1',
        roomId: 'room-1',
        requestId: 'request-1',
      )),
    );
    ref.watch(
      conversationInteractionDetailsProvider((
        conversationId: 'conversation-1',
        roomId: 'room-1',
        requestId: null,
      )),
    );
    ref.watch(bookingInteractionDetailsProvider('request-1'));
    ref.watch(bookingInteractionDetailsProvider('request-2'));
    ref.watch(roomContactDetailsProvider('room-1'));
    ref.watch(roomContactDetailsProvider('room-2'));

    return Scaffold(
      body: ElevatedButton(
        onPressed: () => invalidateParticipantInteractionProviders(
          ref,
          conversationId: 'conversation-1',
          roomId: 'room-1',
          requestId: 'request-1',
        ),
        child: const Text('Invalidate interactions'),
      ),
    );
  }
}

JoinRequestModel _request({
  String studentName = 'Arjun Shah',
  String ownerName = 'Meera Nair',
  String roomTitle = 'Garden Flat',
  JoinRequestStatus status = JoinRequestStatus.pending,
  String platformFeePayer = 'owner',
}) {
  return JoinRequestModel(
    requestId: 'request-1',
    roomId: 'room-1',
    studentId: 'student-1',
    ownerId: 'owner-1',
    studentName: studentName,
    ownerName: ownerName,
    roomTitle: roomTitle,
    status: status,
    createdAt: DateTime(2026, 1, 1),
    updatedAt: DateTime(2026, 1, 1),
    monthlyRentAtJoin: 5000,
    commissionPercentageAtJoin: 30,
    platformFeePayer: platformFeePayer,
  );
}

/// A conversation repository whose interaction state can be changed by the
/// block and unblock callables used in the tests.
class _MutableConversationRepository extends ConversationRepository {
  final String peerId;
  final String peerName;
  final String peerRole;
  final String roomTitle;

  bool blockedByMe = false;
  bool blockedMe;

  final List<Map<String, dynamic>> sentMessages = [];

  int conversationDetailCalls = 0;
  int bookingDetailCalls = 0;
  int roomContactCalls = 0;

  _MutableConversationRepository({
    required this.peerId,
    required this.peerName,
    required this.peerRole,
    required this.roomTitle,
    this.blockedByMe = false,
    this.blockedMe = false,
  }) : super(
         firestore: FakeFirestore(),
         auth: MockFirebaseAuth(),
         functions: FakeFunctionsService(),
       );

  bool get canSend => !blockedByMe && !blockedMe;

  @override
  Stream<List<ConversationModel>> watchConversations() =>
      Stream.value(const []);

  @override
  Stream<List<MessageModel>> watchMessages(String conversationId) =>
      Stream.value(const []);

  @override
  Future<void> markConversationRead(String conversationId) async {}

  @override
  Future<void> sendMessage({
    required String conversationId,
    required String receiverId,
    required String content,
    MessageType type = MessageType.text,
    String? roomId,
    String? imageUrl,
  }) async {
    sentMessages.add({
      'conversationId': conversationId,
      'receiverId': receiverId,
      'content': content,
    });
  }

  @override
  Future<String?> getOtherParticipant(String conversationId) async => peerId;

  @override
  Future<ConversationInteractionDetails> getConversationInteractionDetails(
    String conversationId, {
    String? roomId,
    String? requestId,
  }) async {
    conversationDetailCalls++;
    return ConversationInteractionDetails(
      conversationId: conversationId,
      peerId: peerId,
      peerName: peerName,
      peerRole: peerRole,
      roomId: roomId ?? 'room-1',
      roomTitle: roomTitle,
      requestId: requestId,
      blockedByMe: blockedByMe,
      blockedMe: blockedMe,
      canSend: canSend,
    );
  }

  @override
  Future<BookingInteractionDetails> getBookingInteractionDetails(
    String requestId,
  ) async {
    bookingDetailCalls++;
    return BookingInteractionDetails(
      requestId: requestId,
      studentId: 'student-1',
      ownerId: 'owner-1',
      studentName: 'Arjun Shah',
      ownerName: 'Meera Nair',
      roomId: 'room-1',
      roomTitle: roomTitle,
      blockedByMe: blockedByMe,
      blockedMe: blockedMe,
      canSend: canSend,
    );
  }

  @override
  Future<RoomContactDetails> getRoomContactDetails(String roomId) async {
    roomContactCalls++;
    return RoomContactDetails(
      roomId: roomId,
      roomTitle: roomTitle,
      ownerId: peerId,
      ownerName: peerName,
      blockedByMe: blockedByMe,
      blockedMe: blockedMe,
      canContact: canSend,
    );
  }

  @override
  Future<UserBlockResult> blockUser(
    String otherUserId, {
    String? requestId,
    String? conversationId,
  }) async {
    blockedByMe = true;
    return UserBlockResult(
      otherUserId: otherUserId,
      otherName: peerName,
      blockedByMe: true,
      blockedMe: blockedMe,
      canSend: canSend,
    );
  }

  @override
  Future<UserBlockResult> unblockUser(String otherUserId) async {
    blockedByMe = false;
    return UserBlockResult(
      otherUserId: otherUserId,
      otherName: peerName,
      blockedByMe: false,
      blockedMe: blockedMe,
      canSend: canSend,
    );
  }
}
