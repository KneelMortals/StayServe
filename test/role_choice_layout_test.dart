import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'package:stayserve/core/index.dart';
import 'package:stayserve/features/auth/presentation/screens/register_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/role_selection_screen.dart';
import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/models/user_model.dart';

/// An auth repository which exposes one signed-in account.
class _SignedInRepository implements AuthRepository {
  _SignedInRepository(this.user);

  final User? user;

  @override
  User? get currentUser => user;

  @override
  Future<UserModel?> getUserProfile(String uid) async => null;

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// The sizes of the small phones which the layout has to survive.
const _sizes = <Size>[Size(360, 640), Size(320, 568), Size(412, 732)];

void main() {
  group('the role choice of the login', () {
    for (final size in _sizes) {
      testWidgets('the words of the role cards do not overlap on $size', (
        tester,
      ) async {
        await tester.binding.setSurfaceSize(size);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.pumpWidget(
          ProviderScope(
            overrides: [
              authRepositoryProvider.overrideWithValue(
                _SignedInRepository(
                  MockUser(
                    uid: 'phone-user',
                    phoneNumber: '+919876500001',
                    displayName: null,
                  ),
                ),
              ),
            ],
            child: const MaterialApp(home: RoleSelectionScreen()),
          ),
        );
        await tester.pumpAndSettle();

        // An overflow is reported as an exception by the test framework.
        expect(tester.takeException(), isNull);

        // Both roles are named and readable.
        expect(find.text('Student'), findsOneWidget);
        expect(find.text('Room Owner'), findsOneWidget);
        expect(find.text('Looking for a room to rent'), findsOneWidget);
        expect(find.text('Have rooms to rent out'), findsOneWidget);

        // The button is on the screen and is reachable.
        final continueButton = find.widgetWithText(AppButton, 'Continue');
        expect(continueButton, findsOneWidget);
        await tester.ensureVisible(continueButton);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('the words survive a large font', (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 640));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authRepositoryProvider.overrideWithValue(
              _SignedInRepository(
                MockUser(
                  uid: 'phone-user',
                  phoneNumber: '+919876500001',
                  displayName: null,
                ),
              ),
            ),
          ],
          child: MediaQuery(
            data: const MediaQueryData(textScaler: TextScaler.linear(1.6)),
            child: const MaterialApp(home: RoleSelectionScreen()),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(find.text('Student'), findsOneWidget);
      expect(find.text('Room Owner'), findsOneWidget);
    });

    testWidgets('the page scrolls when the screen is short', (tester) async {
      await tester.binding.setSurfaceSize(const Size(320, 480));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authRepositoryProvider.overrideWithValue(
              _SignedInRepository(
                MockUser(
                  uid: 'phone-user',
                  phoneNumber: '+919876500001',
                  displayName: null,
                ),
              ),
            ),
          ],
          child: const MaterialApp(home: RoleSelectionScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);

      // The page can be scrolled, so nothing is cut off.
      await tester.drag(
        find.byType(SingleChildScrollView),
        const Offset(0, -300),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  });

  group('the role choice of the registration', () {
    for (final size in _sizes) {
      testWidgets('the two cards fit on $size', (tester) async {
        await tester.binding.setSurfaceSize(size);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.pumpWidget(
          ProviderScope(child: const MaterialApp(home: RegisterScreen())),
        );
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
        expect(find.text('Student'), findsOneWidget);
        expect(find.text('Room Owner'), findsOneWidget);
        expect(find.text('Looking for a room to rent'), findsOneWidget);
        expect(find.text('Have rooms to rent out'), findsOneWidget);
      });
    }
  });
}
