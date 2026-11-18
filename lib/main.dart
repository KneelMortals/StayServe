import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'core/constants/app_constants.dart';
import 'core/theme/app_theme.dart';
import 'core/theme/theme_controller.dart';
import 'core/routing/app_router.dart';
import 'core/routing/back_to_dashboard.dart';
import 'features/notifications/presentation/providers/notification_tap_handler.dart';
import 'firebase/firebase_config.dart';
import 'firebase/app_check/app_check_service.dart';
import 'firebase/auth/auth_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  try {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );
  } catch (e) {
    // Swallowing this error leaves the app running against a half
    // initialised Firebase: every screen then fails with confusing
    // "no Firebase App" errors. Fail loudly instead.
    debugPrint('Firebase initialization failed: $e');
    runApp(const _FirebaseInitErrorApp());
    return;
  }

  // App Check has to be ready before the first Firestore, Storage or callable
  // request. Activation failures are deliberately non-fatal while the
  // provider is being rolled out; the server-side switch is the final gate.
  await AppCheckService.activate();

  // Configure persistence before the first frame. On native platforms Firebase
  // already persists Auth state locally; the web build has to request it
  // explicitly. A persistence failure must not stop the app from opening,
  // but it has to be visible in the logs.
  try {
    await configureAuthPersistence(FirebaseAuth.instance);
  } catch (e) {
    debugPrint('Firebase Auth persistence could not be configured: $e');
  }

  // The theme mode is read **before** the first frame, so the app never
  // flashes the light theme before switching to the dark one.
  final storedMode = await ThemeModeController.load();

  runApp(
    ProviderScope(
      overrides: [
        themeModeProvider.overrideWith(() => ThemeModeController(storedMode)),
      ],
      child: const StayServeApp(),
    ),
  );
}

class StayServeApp extends ConsumerWidget {
  const StayServeApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    final lightTheme = ref.watch(lightThemeProvider);
    final darkTheme = ref.watch(darkThemeProvider);
    final themeMode = ref.watch(themeModeProvider);

    // A tap on a push notification opens the screen the notification came
    // from. Without this the notification arrived, the phone showed it and
    // the tap did nothing at all.
    ref.watch(notificationTapHandlerProvider);

    return MaterialApp.router(
      title: AppConstants.appName,
      debugShowCheckedModeBanner: false,
      theme: lightTheme,
      darkTheme: darkTheme,
      themeMode: themeMode,
      routerConfig: router,
      onNavigationNotification: handleNavigationNotification,
      builder: (context, child) {
        return MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(1.0)),
          child: child!,
        );
      },
    );
  }
}

/// Shown when Firebase could not be initialised, so the failure is obvious
/// instead of surfacing as broken screens later on.
class _FirebaseInitErrorApp extends StatelessWidget {
  const _FirebaseInitErrorApp();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: AppConstants.appName,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.green),
        useMaterial3: true,
      ),
      home: Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.cloud_off, size: 64, color: Colors.red),
                const SizedBox(height: 16),
                Text(
                  'StayServe could not start',
                  style: Theme.of(context).textTheme.headlineSmall,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Firebase failed to initialise. Check your internet '
                  'connection and the Firebase configuration, then restart '
                  'the app.',
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
