import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:stayserve/core/index.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/auth/presentation/screens/register_screen.dart';
import 'package:stayserve/firebase/otp/otp_service.dart';

class _FailingRegistrationController extends AuthController {
  final List<String> challenges = <String>[];

  @override
  Future<void> build() async {}

  @override
  Future<RegistrationResult?> signUp({
    required String email,
    required String password,
    required String name,
    required UserRole role,
    String? challenge,
  }) async {
    challenges.add(challenge ?? '');
    state = AsyncError(
      Exception('the registration failed'),
      StackTrace.current,
    );
    return null;
  }
}

Future<void> _waitForRegistrationAttempt(
  WidgetTester tester,
  _FailingRegistrationController controller, {
  int previousAttempts = 0,
}) async {
  for (var attempt = 0; attempt < 20; attempt++) {
    await tester.pump(const Duration(milliseconds: 50));
    if (controller.challenges.length > previousAttempts) return;
  }
  fail('The registration attempt did not start');
}

void main() {
  testWidgets('a failed registration requires the email to be verified again', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 2200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final controller = _FailingRegistrationController();
    var verificationVisits = 0;
    final router = GoRouter(
      initialLocation: '/register',
      routes: [
        GoRoute(path: '/register', builder: (_, __) => const RegisterScreen()),
        GoRoute(
          path: '/verify-otp',
          builder: (context, _) {
            verificationVisits++;
            final challenge = 'proof-$verificationVisits';
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (context.mounted) context.pop(challenge);
            });
            return const Scaffold(body: Text('Verifying the email'));
          },
        ),
      ],
    );
    addTearDown(router.dispose);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [authControllerProvider.overrideWith(() => controller)],
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pump();

    final fields = find.byType(TextFormField);
    expect(fields, findsNWidgets(4));
    await tester.enterText(fields.at(0), 'Test User');
    await tester.enterText(fields.at(1), 'student@example.test');
    await tester.enterText(fields.at(2), 'password123');
    await tester.enterText(fields.at(3), 'password123');

    final createAccount = find.widgetWithText(AppButton, 'Create Account');
    await tester.ensureVisible(createAccount);
    await tester.tap(createAccount);
    await tester.pump();
    await _waitForRegistrationAttempt(tester, controller);

    expect(verificationVisits, 1);
    expect(controller.challenges, ['proof-1']);

    // The first attempt failed. The retained one-time challenge must have
    // been cleared, so this attempt has to open the verification screen
    // again and receive a new challenge.
    await tester.ensureVisible(createAccount);
    await tester.tap(createAccount);
    await tester.pump();
    await _waitForRegistrationAttempt(tester, controller, previousAttempts: 1);

    expect(verificationVisits, 2);
    expect(controller.challenges, ['proof-1', 'proof-2']);
  });
}
