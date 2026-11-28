// The words of the sign-in screens must never be drawn on top of each other.
//
// A phone which is small, or a user who has made the letters of the system
// larger, must still be able to read every screen of the sign-in flow. The
// test pumps every screen of that flow at the sizes and font sizes which a
// phone may use. It fails when two words are drawn on the same place, and
// when a page reports an overflow — Flutter raises an error for a word which
// does not fit.
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/auth/presentation/screens/forgot_password_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/login_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/phone_verification_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/register_screen.dart';
import 'package:stayserve/features/auth/presentation/screens/role_selection_screen.dart';
import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/models/user_model.dart';

/// An auth repository which exposes one account (or none).
class _AuthRepository implements AuthRepository {
  _AuthRepository(this.user);

  final User? user;

  @override
  User? get currentUser => user;

  @override
  Stream<User?> get authStateChanges => Stream<User?>.value(user);

  @override
  Future<UserModel?> getUserProfile(String uid) async => null;

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// The sizes of the phones which the screens have to survive.
const _sizes = <Size>[Size(320, 568), Size(360, 640), Size(412, 732)];

/// The font sizes which a user may have set.
const _fontScales = <double>[1.0, 1.3, 1.6];

/// Whether the word is painted at all.
bool _isHidden(RenderParagraph paragraph) {
  RenderObject? parent = paragraph.parent;
  while (parent != null) {
    if (parent is RenderOpacity && parent.opacity == 0) return true;
    parent = parent.parent;
  }
  return false;
}

/// Fails when two words of the screen are drawn on top of each other.
void _expectNoWordIsDrawnOnAnother(WidgetTester tester) {
  final boxes = <({RenderObject? parent, String text, Rect box})>[];
  final seen = <RenderParagraph>{};
  for (final paragraph
      in tester.allRenderObjects.whereType<RenderParagraph>()) {
    // The same paragraph is reported more than once.
    if (!seen.add(paragraph)) continue;
    final span = paragraph.text;
    final words = span.toPlainText();
    final length = words.length;
    if (length == 0) continue;
    // The icons are drawn as letters of a private range. Their box is much
    // wider than the shape which is seen, so they are no words.
    if (words.runes.every((rune) => rune >= 0xE000 && rune <= 0xF8FF)) {
      continue;
    }
    // A word which is not painted at all cannot overlap another word. The
    // hint of a field is such a word while the name of the field stands in
    // its place.
    if (_isHidden(paragraph)) continue;
    for (final box in paragraph.getBoxesForSelection(
      TextSelection(baseOffset: 0, extentOffset: length),
    )) {
      // The boxes of a paragraph are measured from its own corner, so they
      // are moved to the place of the screen.
      final start = paragraph.localToGlobal(Offset(box.left, box.top));
      final end = paragraph.localToGlobal(Offset(box.right, box.bottom));
      boxes.add((
        parent: paragraph.parent,
        text: words,
        box: Rect.fromLTRB(start.dx, start.dy, end.dx, end.dy),
      ));
    }
  }

  for (var i = 0; i < boxes.length; i++) {
    for (var j = i + 1; j < boxes.length; j++) {
      final first = boxes[i];
      final second = boxes[j];
      // Words of different groups are kept apart by their group, so their
      // places may touch without their letters touching.
      if (!identical(first.parent, second.parent)) continue;
      final shared = first.box.intersect(second.box);
      if (shared.isEmpty) continue;
      final smaller =
          first.box.width * first.box.height <
              second.box.width * second.box.height
          ? first.box.width * first.box.height
          : second.box.width * second.box.height;
      if (smaller <= 0) continue;
      final share = shared.width * shared.height / smaller;
      if (share > 0.3) {
        fail(
          'the words "${first.text}" and "${second.text}" are drawn on top '
          'of each other',
        );
      }
    }
  }
}

void main() {
  group('the sign-in screens', () {
    for (final size in _sizes) {
      for (final scale in _fontScales) {
        final name = 'on $size with the font $scale';

        testWidgets('the words of the login screen do not overlap $name', (
          tester,
        ) async {
          await tester.binding.setSurfaceSize(size);
          addTearDown(() => tester.binding.setSurfaceSize(null));

          await tester.pumpWidget(
            ProviderScope(
              overrides: [
                authRepositoryProvider.overrideWithValue(_AuthRepository(null)),
              ],
              child: MaterialApp(
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: TextScaler.linear(scale)),
                  child: child!,
                ),
                home: const LoginScreen(),
              ),
            ),
          );
          await tester.pumpAndSettle();

          expect(tester.takeException(), isNull);
          _expectNoWordIsDrawnOnAnother(tester);

          // The Google button is the one which carries the longest words.
          expect(find.text('Continue with Google'), findsOneWidget);
          expect(find.text('Sign in with Phone'), findsOneWidget);
        });

        testWidgets('the words of the phone screen do not overlap $name', (
          tester,
        ) async {
          await tester.binding.setSurfaceSize(size);
          addTearDown(() => tester.binding.setSurfaceSize(null));

          await tester.pumpWidget(
            ProviderScope(
              overrides: [
                authRepositoryProvider.overrideWithValue(_AuthRepository(null)),
              ],
              child: MaterialApp(
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: TextScaler.linear(scale)),
                  child: child!,
                ),
                home: const PhoneVerificationScreen(
                  mode: PhoneVerificationMode.signIn,
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();

          expect(tester.takeException(), isNull);
          _expectNoWordIsDrawnOnAnother(tester);
          expect(find.text('Sign in with Phone'), findsOneWidget);
        });

        testWidgets(
          'the words of the role choice of a Google account do not overlap '
          '$name',
          (tester) async {
            await tester.binding.setSurfaceSize(size);
            addTearDown(() => tester.binding.setSurfaceSize(null));

            await tester.pumpWidget(
              ProviderScope(
                overrides: [
                  authRepositoryProvider.overrideWithValue(
                    _AuthRepository(
                      MockUser(
                        uid: 'google-user',
                        email: 'owner@example.com',
                        isEmailVerified: true,
                        displayName: 'A Google Account',
                      ),
                    ),
                  ),
                  userProfileStreamProvider.overrideWithValue(
                    (uid) => Stream<UserModel?>.value(null),
                  ),
                ],
                child: MaterialApp(
                  builder: (context, child) => MediaQuery(
                    data: MediaQuery.of(
                      context,
                    ).copyWith(textScaler: TextScaler.linear(scale)),
                    child: child!,
                  ),
                  home: const RoleSelectionScreen(),
                ),
              ),
            );
            await tester.pumpAndSettle();

            expect(tester.takeException(), isNull);
            _expectNoWordIsDrawnOnAnother(tester);

            expect(find.text('Student'), findsOneWidget);
            expect(find.text('Room Owner'), findsOneWidget);
          },
        );

        testWidgets('the words of the registration do not overlap $name', (
          tester,
        ) async {
          await tester.binding.setSurfaceSize(size);
          addTearDown(() => tester.binding.setSurfaceSize(null));

          await tester.pumpWidget(
            ProviderScope(
              overrides: [
                authRepositoryProvider.overrideWithValue(_AuthRepository(null)),
              ],
              child: MaterialApp(
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: TextScaler.linear(scale)),
                  child: child!,
                ),
                home: const RegisterScreen(),
              ),
            ),
          );
          await tester.pumpAndSettle();

          expect(tester.takeException(), isNull);
          _expectNoWordIsDrawnOnAnother(tester);
        });
      }
    }

    testWidgets('the words of the forgotten password do not overlap', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(320, 568));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authRepositoryProvider.overrideWithValue(
              _AuthRepository(
                MockUser(
                  uid: 'email-user',
                  email: 'owner@example.com',
                  isEmailVerified: true,
                ),
              ),
            ),
            userProfileStreamProvider.overrideWithValue(
              (uid) => Stream<UserModel?>.value(null),
            ),
          ],
          child: const MaterialApp(home: ForgotPasswordScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      _expectNoWordIsDrawnOnAnother(tester);
    });
  });
}
