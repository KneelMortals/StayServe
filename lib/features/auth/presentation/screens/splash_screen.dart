import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/index.dart';
import '../../../../../services/index.dart';
import '../../../../../models/launch_pincode_config.dart';
import '../../../notifications/presentation/providers/pending_notification_route.dart';
import '../providers/remote_config_providers.dart';

/// What the user chose in one of the launch-gate dialogs.
enum _LaunchGateAction {
  /// Try to determine the location again.
  retry,

  /// Close the app.
  exit,

  /// Type the location by hand.
  manualLocation,

  /// Open the system settings so the location service can be switched on.
  openSettings,
}

class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen> {
  String _statusMessage = 'Initializing...';

  /// The longest the splash screen may spend on the **pre-flight** — the
  /// remote-config check and the session lookup.
  ///
  /// Everything the splash does is a network call (remote config, the
  /// maintenance switch, the session, the launch-area configuration and the
  /// location lookup). If **any** of them hangs — a flaky connection, a
  /// device without a GPS fix, a broken DNS server — the user would stare
  /// at the splash screen forever with no way into the app.
  ///
  /// The budget only covers the pre-flight. The launch-area check has its
  /// own timeouts and is **always** run: a slow network must never let a
  /// user past the launch gate, because that gate is the only thing that
  /// keeps StayServe out of the areas it has not been launched in yet.
  static const Duration preflightTimeout = Duration(seconds: 30);

  /// Set as soon as the app leaves the splash screen.
  ///
  /// A slow network call may still be in flight when the app moves on. When
  /// it finally returns it must **not** show a dialog (the maintenance
  /// notice, the location warning, the pincode block) on top of the login
  /// screen — the user would be stuck behind a dialog that has nothing to
  /// do with the page they are on.
  bool _hasLeftSplash = false;

  /// Whether the start-up failed while Firebase Auth still reports a
  /// signed-in user.
  ///
  /// A network or profile-read failure must not be treated as a logout. The
  /// user stays on the splash screen and can retry instead of being sent to
  /// the login screen every time the app is opened with a flaky connection.
  bool _restoreFailed = false;

  /// Prevents two start-up attempts from running at the same time when the
  /// user taps **Try again**.
  bool _isInitializing = false;

  @override
  void initState() {
    super.initState();
    _initializeApp();
  }

  Future<void> _initializeApp() async {
    if (!mounted || _isInitializing) return;
    _isInitializing = true;

    if (_restoreFailed && mounted) {
      setState(() => _restoreFailed = false);
    }

    User? authenticatedUser;

    try {
      // 1. Resolve authentication **before** any network work.
      //
      //    Firebase Auth restores the persisted user from the device, so this
      //    does not need the network. It must also happen before the
      //    remote-config check: that check used to be able to consume the
      //    whole 30-second budget, after which the missing session was
      //    mistaken for a logout and the user was sent to the login screen.
      authenticatedUser = await _resolveAuthenticatedUser();
      if (!mounted) return;

      // The pre-flight gets **one** budget for its network steps, so a slow
      // network cannot stretch the splash screen to twice the limit.
      final deadline = DateTime.now().add(preflightTimeout);

      // 2. Check for force update / maintenance.
      //
      //    A broken or slow remote config must not lock everybody out of
      //    the app, so the check is given up when the budget runs out and
      //    the app continues as if the service were available.
      final mayContinue = await _withPreflightBudget(
        _checkForceUpdateAndMaintenance(),
        true,
        deadline: deadline,
        description: 'The remote-config check',
      );
      if (!mounted) return;
      if (!mayContinue) {
        // Maintenance mode or a forced update: the app stays on the splash
        // screen behind the dialog. Navigating away anyway would show the
        // login screen *underneath* the dialog, which is broken.
        return;
      }

      // 3. Resolve the profile-enriched session when the user is signed in.
      //    Waiting for the first value is required — reading the provider
      //    synchronously returns null while the auth stream has not emitted
      //    yet.
      AuthSession? session;
      if (authenticatedUser != null) {
        session = await _withPreflightBudget<AuthSession?>(
          ref.read(authSessionProvider.future),
          null,
          deadline: deadline,
          description: 'The session lookup',
        );
      }
      if (!mounted) return;

      // 4. Ask for the location and check whether StayServe runs there.
      //    This happens on **every** start, not only on the first one.
      //
      //    This step is deliberately **not** covered by the pre-flight
      //    budget. It used to be: a watchdog navigated straight to the
      //    login screen when the start-up took longer than 30 seconds, which
      //    skipped the launch gate completely — a slow network (or simply a
      //    cold, slow device) let anybody into the app, whatever pincode
      //    they were in. The gate now always runs.
      final mayEnter = await _checkLaunchArea(session);
      if (!mounted) return;
      if (!mayEnter) {
        // The user is not in a launch area (or the location could not be
        // determined). The gate dialog stays on top until they retry.
        return;
      }

      // 5. Let the user in.
      if (session != null) {
        await _checkLoggedInUser(session);
      } else if (authenticatedUser != null) {
        // The Auth user is still signed in, but the profile did not arrive
        // within the budget. Restore the profile directly. A failure here
        // is a temporary connection problem — it is **not** a logout.
        await _restoreAuthenticatedUser(authenticatedUser);
      } else {
        _navigateToLogin();
      }
    } catch (e) {
      AppLogger.warning('The start-up failed', error: e);
      if (!mounted) return;

      // Never turn a server/network failure into a logout. If Firebase Auth
      // still has a user, keep the session and offer a retry. Reading the
      // cached user can itself fail (for example when the Firebase app is
      // unavailable), so that lookup must not escape this catch block.
      User? stillAuthenticated = authenticatedUser;
      if (stillAuthenticated == null) {
        try {
          stillAuthenticated = ref.read(authRepositoryProvider).currentUser;
        } catch (error) {
          AppLogger.warning(
            'Could not read the cached Auth user while recovering from a '
            'start-up failure',
            error: error,
          );
        }
      }
      if (stillAuthenticated != null) {
        _showSessionRestoreFailure();
      } else {
        _navigateToLogin();
      }
    } finally {
      _isInitializing = false;
    }
  }

  /// Returns the user restored from Firebase Auth, if there is one.
  ///
  /// The synchronous `currentUser` is checked first because it is available
  /// immediately on native platforms. The auth-state stream is the fallback
  /// for the short interval in which the native SDK is still restoring its
  /// persisted session.
  Future<User?> _resolveAuthenticatedUser() async {
    final cachedUser = ref.read(authRepositoryProvider).currentUser;
    if (cachedUser != null) return cachedUser;

    try {
      return await ref
          .read(authStateProvider.future)
          .timeout(const Duration(seconds: 5));
    } catch (e) {
      AppLogger.warning('Could not resolve the restored Auth user', error: e);
      return ref.read(authRepositoryProvider).currentUser;
    }
  }

  /// Restores the profile of an already authenticated user.
  ///
  /// This is the fallback for a start-up in which the profile stream did not
  /// produce a value before the pre-flight budget ended. It deliberately
  /// keeps the Auth session intact when the read fails.
  Future<void> _restoreAuthenticatedUser(User user) async {
    try {
      final currentProfile = ref.read(authSessionProvider).valueOrNull?.profile;
      if (currentProfile != null && currentProfile.uid == user.uid) {
        _navigateToRoleHome(currentProfile.role);
        return;
      }

      final profile = await ref
          .read(authRepositoryProvider)
          .getUserProfile(user.uid)
          .timeout(const Duration(seconds: 10));
      if (!mounted) return;

      if (profile != null) {
        _navigateToRoleHome(profile.role);
      } else {
        // The Auth account exists but the server-side profile does not.
        // The user still has to complete role selection; this is not a
        // logout.
        context.go('/role-selection');
      }
    } catch (e) {
      AppLogger.warning(
        'Could not restore the profile of ${user.uid}',
        error: e,
      );
      if (!mounted) return;
      _showSessionRestoreFailure();
    }
  }

  void _showSessionRestoreFailure() {
    if (!mounted) return;
    setState(() => _restoreFailed = true);
    _updateStatus(
      'Your session is still saved, but it could not be restored. '
      'Check your connection and try again.',
    );
  }

  void _retryStartup() {
    if (_isInitializing) return;
    _updateStatus('Retrying...');
    _initializeApp();
  }

  /// Runs [work] with the time that is left of the pre-flight budget.
  ///
  /// When the work does not finish in time — or fails — the [fallback] is
  /// returned and the app carries on. This keeps a hanging network call
  /// from pinning the user on the splash screen.
  ///
  /// Only the pre-flight uses this. The launch-area check must never be
  /// skipped, so it has its own, separate timeouts.
  Future<T> _withPreflightBudget<T>(
    Future<T> work,
    T fallback, {
    required DateTime deadline,
    required String description,
  }) async {
    final remaining = deadline.difference(DateTime.now());
    if (remaining <= Duration.zero) {
      AppLogger.warning(
        '$description was skipped — the start-up budget of '
        '${preflightTimeout.inSeconds}s was already used up',
      );
      return fallback;
    }

    try {
      return await work.timeout(remaining);
    } on TimeoutException {
      AppLogger.warning(
        '$description did not finish within ${remaining.inSeconds}s — '
        'continuing without it',
      );
      return fallback;
    } catch (e) {
      AppLogger.warning('$description failed', error: e);
      return fallback;
    }
  }

  /// Returns `false` when the app must stay on the splash screen (because a
  /// maintenance or update dialog is open).
  Future<bool> _checkForceUpdateAndMaintenance() async {
    try {
      final forceUpdateResult = await ref.read(forceUpdateCheckProvider.future);
      if (!mounted) return false;

      if (forceUpdateResult.maintenanceMode) {
        _showMaintenanceDialog(forceUpdateResult.maintenanceMessage);
        return false;
      }

      if (forceUpdateResult.isForceUpdate) {
        _showForceUpdateDialog(forceUpdateResult);
        return false;
      }

      if (forceUpdateResult.isUpdateRequired &&
          !forceUpdateResult.isForceUpdate) {
        _showOptionalUpdateDialog(forceUpdateResult);
      }
    } catch (e) {
      // Fail open on remote config errors
      AppLogger.warning('Remote config check failed', error: e);
    }

    if (!mounted) return false;

    // ---------------------------------------------------------------
    // The admin switch in the app writes the maintenance flag to
    // `publicSettings/platform` — a document that is readable before the
    // user signs in. The remote-config check above only knows about the
    // `maintenance_mode` remote parameter, so without this second check
    // the switch in Admin → Settings had **no effect** at all.
    // ---------------------------------------------------------------
    try {
      final adminRepo = ref.read(adminRepositoryProvider);
      final inMaintenance = await adminRepo.getMaintenanceMode();
      if (!mounted) return false;
      if (inMaintenance) {
        final message = await adminRepo.getMaintenanceMessage();
        _showMaintenanceDialog(
          message.isNotEmpty
              ? message
              : 'StayServe is under maintenance right now. '
                    'Please try again in a little while.',
        );
        return false;
      }
    } catch (e) {
      AppLogger.warning('Could not read the maintenance mode', error: e);
    }

    return true;
  }

  /// Asks for the location and checks the launch-area configuration.
  ///
  /// Returns `false` when the user may **not** enter the app — the gate
  /// dialog is shown in that case and the splash screen keeps waiting.
  Future<bool> _checkLaunchArea(AuthSession? session) async {
    _updateStatus('Checking your location...');

    final adminRepo = ref.read(adminRepositoryProvider);
    final locationService = ref.read(locationServiceProvider);

    // The launch-area configuration lives in a publicly readable document,
    // so this works before the user signs in.
    LaunchPincodeConfig config;
    try {
      config = await adminRepo.getLaunchPincodeConfig();
    } catch (e) {
      AppLogger.warning('Could not read the launch pincode config', error: e);
      // Without the configuration the service runs everywhere.
      config = const LaunchPincodeConfig();
    }
    if (!mounted) return false;

    // The decision that lets somebody in — or keeps them out — is logged, so
    // a report of "the app let me in even though I am not in a launch area"
    // can be traced without a debugger.
    AppLogger.info(
      'Launch-area check: configured=${config.configured}, '
      'mode=${config.mode}, '
      'enabled=${config.enabledPincodes.length}, '
      'disabled=${config.disabledPincodes.length}',
    );

    // The service has not been restricted to certain areas yet — everybody
    // may use the app. The location is still resolved (in the background)
    // so the distances in the search results are correct.
    if (!config.configured) {
      AppLogger.info(
        'Launch-area check: no configuration saved — the app is open to '
        'everybody',
      );
      unawaited(_resolveLocationOnly());
      return true;
    }

    while (mounted && !_hasLeftSplash) {
      _updateStatus('Checking your location...');

      final result = await locationService.getUserLocation();
      if (!mounted || _hasLeftSplash) return false;

      if (result.success && result.location != null) {
        // Remember the location — the search screen uses it to calculate
        // the distance to every room.
        ref.read(userLocationProvider.notifier).setLocation(result.location!);

        final pincode = result.pincode;
        AppLogger.info(
          'Launch-area check: the device is in '
          '${result.location!.latitude}, ${result.location!.longitude} '
          '(pincode: ${pincode ?? "unknown"})',
        );
        if (pincode != null && pincode.trim().isNotEmpty) {
          if (config.allows(pincode)) {
            AppLogger.info('Launch-area check: $pincode is allowed');
            await _syncProfilePincode(pincode);
            return true;
          }

          // The service does not run in this pincode.
          AppLogger.info('Launch-area check: $pincode is NOT allowed');
          final action = await _showNotLaunchedDialog(pincode: pincode);
          if (action == _LaunchGateAction.exit) {
            await quitApp();
            return false;
          }
          if (action == _LaunchGateAction.manualLocation) {
            if (await _acceptManualPincode(config)) return true;
            continue;
          }
          continue;
        }

        // The position is known but the pincode could not be derived from
        // it — fall back to the pincode of the profile.
        final profilePincode = session?.profile?.pincode;
        if (profilePincode != null && profilePincode.trim().isNotEmpty) {
          if (config.allows(profilePincode)) {
            AppLogger.info(
              'Launch-area check: using the pincode of the profile '
              '($profilePincode) — allowed',
            );
            await _syncProfilePincode(profilePincode);
            return true;
          }
          AppLogger.info(
            'Launch-area check: using the pincode of the profile '
            '($profilePincode) — NOT allowed',
          );
          final action = await _showNotLaunchedDialog(pincode: profilePincode);
          if (action == _LaunchGateAction.exit) {
            await quitApp();
            return false;
          }
          if (action == _LaunchGateAction.manualLocation) {
            if (await _acceptManualPincode(config)) return true;
            continue;
          }
          continue;
        }
      }

      // The location could not be determined at all.
      AppLogger.info(
        'Launch-area check: the location could not be determined '
        '(${result.error ?? "no reason given"})',
      );
      final action = await _showLocationUnavailableDialog();
      if (action == _LaunchGateAction.exit) {
        await quitApp();
        return false;
      }
      if (action == _LaunchGateAction.manualLocation) {
        if (await _acceptManualPincode(config)) return true;
        continue;
      }
      if (action == _LaunchGateAction.openSettings) {
        await ref.read(locationServiceProvider).openAppSettings();
        // Give the user a moment to flip the switch, then check again.
        await Future<void>.delayed(const Duration(seconds: 1));
        continue;
      }
    }

    return false;
  }

  /// Asks the user for a pincode and checks it against the launch areas.
  ///
  /// Returns `true` when the pincode the user typed is one StayServe runs
  /// in — the app then carries on and the login screen appears.
  ///
  /// This is the escape hatch for a user whose phone reports the wrong
  /// location (a GPS fix in the wrong city, a VPN, a device with a broken
  /// location chip): instead of being locked out they can simply type the
  /// pincode they live in.
  Future<bool> _acceptManualPincode(LaunchPincodeConfig config) async {
    final entered = await _promptForPincode();
    if (entered == null) return false;

    final pincode = LaunchPincodeConfig.normalise(entered);
    if (pincode.isEmpty) return false;

    if (!config.allows(pincode)) {
      AppLogger.info(
        'Launch-area check: the manually entered pincode $pincode is NOT '
        'allowed',
      );
      _showSnack(
        'StayServe has not been launched in $pincode yet. Please check back '
        'later.',
      );
      return false;
    }

    AppLogger.info(
      'Launch-area check: the manually entered pincode $pincode is allowed',
    );
    await _syncProfilePincode(pincode);
    await _applyManualPincodeLocation(pincode);
    return true;
  }

  /// Uses the manually entered pincode as the position of the user.
  ///
  /// The pincode is the one place the user *tells* the app where they are.
  /// If it is not turned into coordinates, the app keeps the raw GPS fix —
  /// and every distance is then calculated from the wrong place (a room
  /// two streets away showed up as "13822 km away").
  ///
  /// The lookup is best-effort: when it fails the app simply keeps the
  /// position it already had.
  Future<void> _applyManualPincodeLocation(String pincode) async {
    try {
      final location = await ref
          .read(locationServiceProvider)
          .resolvePincodeLocation(pincode);
      if (location == null) {
        AppLogger.warning(
          'The pincode $pincode could not be turned into coordinates — the '
          'distances keep using the GPS position',
        );
        return;
      }
      if (!mounted) return;
      ref.read(userLocationProvider.notifier).setLocation(location);
      AppLogger.info(
        'The position of the user was set from the pincode $pincode '
        '(${location.latitude}, ${location.longitude})',
      );
    } catch (e) {
      AppLogger.warning('Could not apply the manual pincode', error: e);
    }
  }

  /// Asks the user to type the pincode of their area.
  ///
  /// Returns `null` when the user cancels the dialog.
  Future<String?> _promptForPincode() async {
    if (!mounted) return null;

    return showDialog<String>(
      context: context,
      builder: (dialogContext) => const _ManualPincodeDialog(),
    );
  }

  /// Shows a short message at the bottom of the screen.
  void _showSnack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  /// Resolves the location without checking the launch areas.
  Future<void> _resolveLocationOnly() async {
    try {
      final result = await ref.read(locationServiceProvider).getUserLocation();
      if (!result.success || result.location == null) return;
      if (!mounted) return;
      ref.read(userLocationProvider.notifier).setLocation(result.location!);
    } catch (e) {
      AppLogger.warning('Could not resolve the location', error: e);
    }
  }

  /// Writes the freshly detected pincode to the user's profile.
  ///
  /// The Firestore rules allow a user to change their own `pincode`, and it
  /// keeps the profile in sync with the place the user actually is.
  Future<void> _syncProfilePincode(String pincode) async {
    final session = ref.read(authSessionProvider).valueOrNull;
    final profile = session?.profile;
    if (profile == null) return;
    if (profile.pincode == pincode) return;

    try {
      await ref.read(authRepositoryProvider).updateUserProfile(profile.uid, {
        'pincode': pincode,
      });
    } catch (e) {
      AppLogger.warning('Could not store the pincode on the profile', error: e);
    }
  }

  Future<void> _checkLoggedInUser(AuthSession session) async {
    try {
      final userProfile =
          session.profile ??
          await ref
              .read(authRepositoryProvider)
              .getUserProfile(session.user.uid);
      if (!mounted) return;

      if (userProfile != null) {
        _navigateToRoleHome(userProfile.role);
      } else {
        context.go('/role-selection');
      }
    } catch (e) {
      AppLogger.warning('Could not restore the signed-in user', error: e);
      if (!mounted) return;

      // The account is still authenticated. A failed profile read is a
      // temporary failure, not a logout, so keep the session and let the
      // user retry.
      _showSessionRestoreFailure();
    }
  }

  void _navigateToRoleHome(UserRole role) {
    if (_hasLeftSplash) return;
    _hasLeftSplash = true;

    // ---------------------------------------------------------------------
    // The app may have been **started** by a tap on a push notification.
    //
    // The notification asked for a specific screen — and the splash screen
    // must not navigate to the home screen instead: the user tapped the
    // notification, the app opened … on the home screen, and the tap looked
    // like it did nothing at all.
    // ---------------------------------------------------------------------
    final pending = ref.read(pendingNotificationRouteProvider.notifier).state;
    if (pending != null && pending.isNotEmpty) {
      ref.read(pendingNotificationRouteProvider.notifier).state = null;
      context.go(pending);
      return;
    }

    switch (role) {
      case UserRole.admin:
        context.go('/admin/dashboard');
        break;
      case UserRole.owner:
        context.go('/owner/dashboard');
        break;
      case UserRole.student:
        context.go('/student/home');
        break;
    }
  }

  void _navigateToLogin() {
    if (_hasLeftSplash) return;
    _hasLeftSplash = true;

    // Nobody is signed in — the route of a notification means nothing now.
    ref.read(pendingNotificationRouteProvider.notifier).state = null;
    context.go('/login');
  }

  /// Shows the "we do not run here yet" dialog.
  ///
  /// The user can try again, type the location by hand, or leave the app.
  Future<_LaunchGateAction> _showNotLaunchedDialog({
    required String pincode,
  }) async {
    if (_hasLeftSplash) return _LaunchGateAction.exit;

    _updateStatus('StayServe is not available in your location');

    final action = await showDialog<_LaunchGateAction>(
      context: context,
      // The dialog may **not** be dismissed by tapping outside: that would
      // leave the user on the splash screen with no way forward.
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        icon: Icon(
          Icons.location_off_outlined,
          size: 40,
          color: Theme.of(dialogContext).colorScheme.error,
        ),
        title: const Text('Not launched in your location'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'StayServe has not been launched in your area yet. We are '
              'expanding our service, so please check back later.',
            ),
            const SizedBox(height: AppSpacing.md),
            Container(
              padding: const EdgeInsets.all(AppSpacing.sm),
              decoration: BoxDecoration(
                color: Theme.of(
                  dialogContext,
                ).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(AppBorderRadius.md),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.location_on_outlined,
                    size: 18,
                    color: Theme.of(dialogContext).colorScheme.primary,
                  ),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(
                      'Your location: $pincode',
                      style: Theme.of(dialogContext).textTheme.labelLarge,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              'If your phone reports the wrong location, you can type your '
              'own pincode instead.',
              style: Theme.of(dialogContext).textTheme.bodySmall,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () =>
                Navigator.pop(dialogContext, _LaunchGateAction.exit),
            child: const Text('Exit'),
          ),
          TextButton(
            onPressed: () =>
                Navigator.pop(dialogContext, _LaunchGateAction.manualLocation),
            child: const Text('Enter location manually'),
          ),
          FilledButton.icon(
            onPressed: () =>
                Navigator.pop(dialogContext, _LaunchGateAction.retry),
            icon: const Icon(Icons.refresh),
            label: const Text('Try again'),
          ),
        ],
      ),
    );

    return action ?? _LaunchGateAction.exit;
  }

  /// Shows the "we could not detect your location" dialog.
  ///
  /// The user can try again, type the location by hand, open the system
  /// settings or leave the app.
  Future<_LaunchGateAction> _showLocationUnavailableDialog() async {
    if (_hasLeftSplash) return _LaunchGateAction.exit;

    _updateStatus('Could not detect your location');

    final action = await showDialog<_LaunchGateAction>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        icon: Icon(
          Icons.my_location,
          size: 40,
          color: Theme.of(dialogContext).colorScheme.primary,
        ),
        title: const Text('Location access needed'),
        content: const Text(
          'StayServe needs your location to check whether the service is '
          'running in your area. Please turn on your location services and '
          'allow the app to use them — or type your pincode by hand.',
        ),
        actions: [
          TextButton(
            onPressed: () =>
                Navigator.pop(dialogContext, _LaunchGateAction.exit),
            child: const Text('Exit'),
          ),
          TextButton(
            onPressed: () =>
                Navigator.pop(dialogContext, _LaunchGateAction.manualLocation),
            child: const Text('Enter location manually'),
          ),
          TextButton(
            onPressed: () =>
                Navigator.pop(dialogContext, _LaunchGateAction.openSettings),
            child: const Text('Open settings'),
          ),
          FilledButton.icon(
            onPressed: () =>
                Navigator.pop(dialogContext, _LaunchGateAction.retry),
            icon: const Icon(Icons.refresh),
            label: const Text('Try again'),
          ),
        ],
      ),
    );

    return action ?? _LaunchGateAction.exit;
  }

  void _showForceUpdateDialog(ForceUpdateResult result) {
    // The pre-flight may have been given up on while the remote-config call
    // was still in flight. A dialog that arrives after the app has moved on
    // must not block the page the user is on.
    if (_hasLeftSplash) return;
    showDialog(
      context: context,
      barrierDismissible: !result.isForceUpdate,
      builder: (context) => AlertDialog(
        title: Text(
          result.isForceUpdate ? 'Update Required' : 'Update Available',
        ),
        content: Text(result.message),
        actions: [
          if (!result.isForceUpdate)
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Later'),
            ),
          TextButton(
            onPressed: () => _launchUpdateUrl(result),
            child: Text(result.isForceUpdate ? 'Update Now' : 'Update'),
          ),
        ],
      ),
    );
  }

  void _showOptionalUpdateDialog(ForceUpdateResult result) {
    if (_hasLeftSplash) return;
    showDialog(
      context: context,
      barrierDismissible: true,
      builder: (context) => AlertDialog(
        title: const Text('Update Available'),
        content: Text(result.message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Later'),
          ),
          TextButton(
            onPressed: () => _launchUpdateUrl(result),
            child: const Text('Update'),
          ),
        ],
      ),
    );
  }

  void _showMaintenanceDialog(String message) {
    if (_hasLeftSplash) return;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: const Text('Under Maintenance'),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  Future<void> _launchUpdateUrl(ForceUpdateResult result) async {
    final url = result.updateUrlAndroid.isNotEmpty
        ? result.updateUrlAndroid
        : result.updateUrlIos;

    if (url.isEmpty) {
      // There is no link to open — the user would sit in front of the
      // dialog and wait for an update that never starts.
      if (mounted) {
        _showSnack(
          'The update link is not available. Please update StayServe from '
          'the Play Store.',
        );
      }
      return;
    }

    try {
      final opened = await launchUrl(
        Uri.parse(url),
        mode: LaunchMode.externalApplication,
      );
      if (!opened && mounted) {
        // The device has no app that can open the link (or the user
        // cancelled). Without this the dialog looked like a dead end.
        _showSnack(
          'Could not open the update link. Please update StayServe from the '
          'Play Store.',
        );
      }
    } catch (e) {
      AppLogger.warning('Could not open the update link', error: e);
      if (mounted) {
        _showSnack(
          'Could not open the update link. Please update StayServe from the '
          'Play Store.',
        );
      }
    }
  }

  void _updateStatus(String message) {
    if (mounted) {
      setState(() => _statusMessage = message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      backgroundColor: theme.colorScheme.primary,
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 120,
              height: 120,
              decoration: BoxDecoration(
                color: theme.colorScheme.onPrimary,
                borderRadius: BorderRadius.circular(AppBorderRadius.xl),
              ),
              child: const Icon(
                Icons.home_outlined,
                size: 60,
                color: AppColors.primary,
              ),
            ),
            const SizedBox(height: AppSpacing.xl),
            Text(
              AppConstants.appName,
              style: theme.textTheme.headlineLarge?.copyWith(
                color: theme.colorScheme.onPrimary,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              'Find your perfect stay',
              style: theme.textTheme.bodyLarge?.copyWith(
                color: theme.colorScheme.onPrimary.withValues(alpha: 0.8),
              ),
            ),
            const SizedBox(height: AppSpacing.xxl),
            if (_restoreFailed) ...[
              Icon(
                Icons.cloud_off_outlined,
                size: 44,
                color: theme.colorScheme.onPrimary,
              ),
              const SizedBox(height: AppSpacing.md),
              FilledButton.icon(
                onPressed: _retryStartup,
                icon: const Icon(Icons.refresh),
                label: const Text('Try again'),
                style: FilledButton.styleFrom(
                  backgroundColor: theme.colorScheme.onPrimary,
                  foregroundColor: theme.colorScheme.primary,
                ),
              ),
            ] else
              CircularProgressIndicator(
                valueColor: AlwaysStoppedAnimation<Color>(
                  theme.colorScheme.onPrimary,
                ),
              ),
            const SizedBox(height: AppSpacing.lg),
            Text(
              _statusMessage,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onPrimary.withValues(alpha: 0.7),
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

/// Asks the user for the pincode of their area.
///
/// This is the escape hatch for a phone that reports the wrong location: the
/// user types the pincode they actually live in, and the app checks it
/// against the launch areas.
class _ManualPincodeDialog extends StatefulWidget {
  const _ManualPincodeDialog();

  @override
  State<_ManualPincodeDialog> createState() => _ManualPincodeDialogState();
}

class _ManualPincodeDialogState extends State<_ManualPincodeDialog> {
  final _controller = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final value = _controller.text.trim();
    if (value.isEmpty) {
      setState(() => _error = 'Please enter your pincode');
      return;
    }
    Navigator.pop(context, value);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return AlertDialog(
      icon: Icon(
        Icons.edit_location_alt_outlined,
        size: 40,
        color: theme.colorScheme.primary,
      ),
      title: const Text('Enter your location'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Type the pincode of the area you are in. If StayServe runs '
            'there, the app will let you in.',
          ),
          const SizedBox(height: AppSpacing.md),
          TextField(
            controller: _controller,
            autofocus: true,
            keyboardType: TextInputType.number,
            maxLength: 6,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _submit(),
            decoration: InputDecoration(
              labelText: 'Pincode',
              hintText: 'e.g. 560001',
              counterText: '',
              errorText: _error,
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Check')),
      ],
    );
  }
}
