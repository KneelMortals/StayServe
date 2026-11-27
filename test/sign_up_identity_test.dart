import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'package:stayserve/core/index.dart';
import 'package:stayserve/features/auth/presentation/screens/role_selection_screen.dart';
import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/models/user_model.dart';

/// An auth repository which exposes one signed-in account.
class _SignedInRepository implements AuthRepository {
  _SignedInRepository(this.user, {this.profile});

  final User? user;

  /// The profile of the account, if the server already wrote one.
  final UserModel? profile;

  @override
  User? get currentUser => user;

  @override
  Future<UserModel?> getUserProfile(String uid) async => profile;

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

Future<void> _pumpRoleSelection(
  WidgetTester tester, {
  required User? user,
  UserModel? profile,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        authRepositoryProvider.overrideWithValue(
          _SignedInRepository(user, profile: profile),
        ),
      ],
      child: const MaterialApp(home: RoleSelectionScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

/// The text of the name field of the role-selection screen.
String _nameOf(WidgetTester tester) {
  final nameField = find.widgetWithText(AppTextField, 'Full name');
  expect(nameField, findsOneWidget);
  return tester.widget<AppTextField>(nameField).controller?.text ?? '';
}

void main() {
  group('the name of a new account', () {
    testWidgets('a phone account has to tell its name', (tester) async {
      await _pumpRoleSelection(
        tester,
        user: MockUser(
          uid: 'phone-user',
          phoneNumber: '+919876500001',
          displayName: null,
        ),
      );

      // The name is asked for: a phone number says nothing about the name of
      // its owner.
      expect(_nameOf(tester), '');
    });

    testWidgets('a Google account starts with the name of Google', (
      tester,
    ) async {
      await _pumpRoleSelection(
        tester,
        user: MockUser(
          uid: 'google-user',
          email: 'google-user@example.test',
          displayName: 'Google Person',
        ),
      );

      expect(_nameOf(tester), 'Google Person');
    });

    testWidgets('a phone account keeps the name of its profile', (
      tester,
    ) async {
      await _pumpRoleSelection(
        tester,
        user: MockUser(
          uid: 'phone-user',
          phoneNumber: '+919876500001',
          displayName: null,
        ),
        profile: UserModel(
          uid: 'phone-user',
          name: 'Known Person',
          email: '',
          role: UserRole.student,
          createdAt: DateTime.utc(2026),
          updatedAt: DateTime.utc(2026),
        ),
      );

      // The registration is repeated — for example after a rollback. The name
      // which the profile already carries is offered again.
      expect(_nameOf(tester), 'Known Person');
    });

    testWidgets('the placeholder of the bootstrap is not a name', (
      tester,
    ) async {
      await _pumpRoleSelection(
        tester,
        user: MockUser(
          uid: 'phone-user',
          phoneNumber: '+919876500001',
          displayName: null,
        ),
        profile: UserModel(
          uid: 'phone-user',
          name: 'User',
          email: '',
          role: UserRole.student,
          createdAt: DateTime.utc(2026),
          updatedAt: DateTime.utc(2026),
        ),
      );

      expect(_nameOf(tester), '');
    });
  });
}
