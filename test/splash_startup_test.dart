import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/features/auth/presentation/providers/remote_config_providers.dart';
import 'package:stayserve/features/auth/presentation/screens/splash_screen.dart';
import 'package:stayserve/firebase/admin/admin_repository.dart';
import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/services/location_service.dart';

import 'support/audit_fakes.dart';

void main() {
  testWidgets(
    'an internal start-up failure is not reported as a connection error',
    (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            authRepositoryProvider.overrideWithValue(FakeAuthRepository()),
            authStateProvider.overrideWith((ref) => Stream.value(null)),
            forceUpdateCheckProvider.overrideWith(
              (ref) async => ForceUpdateResult(
                isUpdateRequired: false,
                isForceUpdate: false,
                currentVersion: '1.0.0',
                latestVersion: '1.0.0',
                minVersion: '1.0.0',
                message: '',
                updateUrlAndroid: '',
                updateUrlIos: '',
                maintenanceMode: false,
                maintenanceMessage: '',
              ),
            ),
            adminRepositoryProvider.overrideWithValue(FakeAdminRepository()),
            locationServiceProvider.overrideWith(
              (ref) => throw StateError('A deliberate start-up failure'),
            ),
          ],
          child: const MaterialApp(home: SplashScreen()),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('StayServe could not finish starting. Please try again.'),
        findsOneWidget,
      );
      expect(find.textContaining('Check your connection'), findsNothing);
      expect(find.text('Try again'), findsOneWidget);
    },
  );
}
