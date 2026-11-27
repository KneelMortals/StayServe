import 'dart:async';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../../../core/constants/enums.dart';
import '../../../../../core/errors/failures.dart';
import '../../../../../core/routing/navigation_history.dart';
import '../../../../../core/utils/app_logger.dart';
import '../../../../../firebase/auth/auth_service.dart';
import '../../../../../firebase/messaging/messaging_service.dart';
import '../../../../../firebase/otp/otp_service.dart';
import '../../../../../models/user_model.dart';

/// The signed-in user together with the role resolved from their Firestore
/// profile.
///
/// The role lives in the `users` document, not in the auth token, so it is
/// resolved by streaming that document. Streaming (instead of a one-shot
/// read) means role changes made by an admin — or by the role-selection
/// screen — propagate to the router automatically.
class AuthSession {
  final User user;
  final UserModel? profile;

  const AuthSession({required this.user, this.profile});

  /// The user's role. Defaults to [UserRole.student] when the profile has not
  /// been created yet.
  UserRole get role => profile?.role ?? UserRole.student;

  /// Whether a Firestore profile exists for this user.
  bool get hasProfile => profile != null;

  bool get isAdmin => role == UserRole.admin;
  bool get isOwner => role == UserRole.owner;
  bool get isStudent => role == UserRole.student;
}

final authStateProvider = StreamProvider<User?>((ref) {
  return ref.watch(authRepositoryProvider).authStateChanges;
});

/// Opens the live profile stream of one user.
///
/// This is a provider of its own so the session logic can be tested with a
/// controllable stream. Production code always uses the Firestore document;
/// the test replaces this provider without recreating [authSessionProvider].
typedef UserProfileStreamFactory = Stream<UserModel?> Function(String uid);

final userProfileStreamProvider = Provider<UserProfileStreamFactory>((ref) {
  final firestore = ref.watch(firestoreProvider);

  return (uid) => firestore.collection('users').doc(uid).snapshots().map((
    snapshot,
  ) {
    if (!snapshot.exists) return null;
    try {
      return UserModel.fromJson(snapshot.data()!);
    } catch (error) {
      // A malformed profile must not kill the session stream.
      AppLogger.warning('Could not parse the profile of $uid', error: error);
      return null;
    }
  });
});

/// Tracks the current generation of the Firebase Auth session.
///
/// Firebase Auth callbacks can finish after the user has signed out or after
/// another account has become current. A generation check is therefore
/// required in addition to the UID: the same account can sign out and sign in
/// again while an older callback is still pending.
class AuthSessionTracker {
  int _generation = 0;
  String? _uid;
  bool _started = false;

  int get generation => _generation;
  String? get uid => _uid;
  bool get hasStarted => _started;

  void switchTo(String? uid) {
    _generation++;
    _uid = uid;
    _started = true;
  }

  bool isCurrent(String uid, int generation) {
    return _started && _uid == uid && _generation == generation;
  }
}

final authSessionTrackerProvider = Provider<AuthSessionTracker>((ref) {
  return AuthSessionTracker();
});

/// The work that has to happen after a user signs in.
///
/// Token refresh, server-profile synchronization and FCM registration are kept
/// behind this small callback so the auth-session regression test does not
/// need the Firebase Messaging plugin. A failure is logged and never
/// terminates the session.
typedef AuthSessionUserChanged = Future<void> Function(User user);

final authSessionUserChangedProvider = Provider<AuthSessionUserChanged>((ref) {
  return (user) async {
    final authRepo = ref.read(authRepositoryProvider);
    final tracker = ref.read(authSessionTrackerProvider);
    final generation = tracker.generation;

    bool isCurrent() {
      final belongsToTrackedSession = tracker.hasStarted
          ? tracker.isCurrent(user.uid, generation)
          : true;
      return belongsToTrackedSession && authRepo.currentUser?.uid == user.uid;
    }

    if (!isCurrent()) return;

    // The custom claims are attached by the Cloud Functions *after* the
    // account was created, so the token of a returning user can be stale.
    // Refreshing it here makes sure the `admin` claim is picked up as soon
    // as an admin granted the role.
    try {
      await authRepo.refreshIdToken();
    } catch (error) {
      AppLogger.warning(
        'Could not refresh the token of ${user.uid}',
        error: error,
      );
    }

    if (!isCurrent()) return;

    // Copy the current Firebase identity facts into the server-owned profile.
    // This is best effort: a temporary profile-sync failure must not prevent
    // push registration or terminate an otherwise valid Auth session.
    try {
      await authRepo.syncAuthProfile();
    } catch (error) {
      AppLogger.warning(
        'Could not synchronize the auth profile of ${user.uid}',
        error: error,
      );
    }

    if (!isCurrent()) return;

    // The push token of this device is written to the profile, so the
    // server can push a notification to the user even when the app is
    // closed. Without it the user only heard about a booking after they
    // opened the app.
    await ref.read(pushNotificationRegistrarProvider).register(user.uid);
  };
});

/// Resolves the current session (user + role).
///
/// Emits `null` when signed out.
///
/// The profile is a **switchable** subscription, rather than an
/// `asyncExpand` of the auth stream. `asyncExpand` waits for the inner
/// stream to finish before it reads the next auth event. A Firestore
/// `snapshots()` stream never finishes, so the old implementation stopped
/// consuming Firebase's auth events after the first sign-in: the logout and
/// the following sign-in were never delivered to the app.
///
/// This implementation cancels the old profile subscription whenever the
/// Firebase user changes. A logout therefore emits `null` immediately, and
/// a subsequent sign-in starts a fresh profile subscription for the new
/// account.
final authSessionProvider = StreamProvider<AuthSession?>((ref) {
  final authRepo = ref.watch(authRepositoryProvider);
  final profileStreamFactory = ref.watch(userProfileStreamProvider);
  final tracker = ref.watch(authSessionTrackerProvider);

  final controller = StreamController<AuthSession?>();
  StreamSubscription<User?>? authSubscription;
  StreamSubscription<UserModel?>? profileSubscription;
  String? activeUid;

  /// Monotonically increasing generation of the Auth session.
  ///
  /// Every asynchronous auth task is tied to the generation which started
  /// it. A sign-out or an account change increments the generation, so an
  /// older token refresh or profile synchronization cannot act on a newer
  /// session.
  var authSessionGeneration = 0;

  void cancelProfileSubscription() {
    final subscription = profileSubscription;
    profileSubscription = null;
    if (subscription != null) {
      unawaited(subscription.cancel());
    }
  }

  void emitSession(User user, UserModel? profile) {
    // A cancelled Firestore stream can still finish an event that was
    // already in flight. Do not let an event for the previous account leak
    // into the new session.
    if (controller.isClosed || activeUid != user.uid) return;
    controller.add(AuthSession(user: user, profile: profile));
  }

  Future<void> cleanupReplacedAccount(String uid) async {
    try {
      await ref.read(pushNotificationRegistrarProvider).unregister(uid);
    } catch (error) {
      AppLogger.warning(
        'Could not remove the FCM token of the replaced account $uid',
        error: error,
      );
    }
  }

  void switchProfile(User? user) {
    final previousUid = activeUid;
    final sessionGeneration = ++authSessionGeneration;

    cancelProfileSubscription();
    activeUid = user?.uid;
    tracker.switchTo(user?.uid);

    if (user == null) {
      // This is the event the old `asyncExpand` implementation could never
      // deliver. It is what lets the router leave the protected pages and
      // what makes an immediate second sign-in work.
      if (!controller.isClosed) controller.add(null);

      // Remove the old device token even when Firebase Auth emitted the
      // sign-out event itself. The cleanup is retried by the registrar and
      // a final failure is logged instead of being mistaken for a missing
      // profile.
      if (previousUid != null) {
        unawaited(cleanupReplacedAccount(previousUid));
      }
      return;
    }

    // Refresh the token, synchronize the server-owned profile and register
    // the push token for this account. These operations must not be able to
    // terminate the session stream.
    unawaited(() async {
      try {
        // An account change has to remove the old account's token before
        // the new account can receive the token of this device.
        if (previousUid != null && previousUid != user.uid) {
          await ref
              .read(pushNotificationRegistrarProvider)
              .unregister(previousUid);
        }

        if (controller.isClosed ||
            authSessionGeneration != sessionGeneration ||
            activeUid != user.uid ||
            !tracker.isCurrent(user.uid, sessionGeneration)) {
          return;
        }
        await ref.read(authSessionUserChangedProvider)(user);
      } catch (error) {
        AppLogger.warning(
          'Could not finish the sign-in tasks of ${user.uid}',
          error: error,
        );
      }
    }());

    profileSubscription = profileStreamFactory(user.uid).listen(
      (profile) {
        emitSession(user, profile);
      },
      onError: (Object error, StackTrace stack) {
        // A profile read error must not kill the auth stream. Keep the
        // session alive with an empty profile; the next Firestore snapshot
        // can still provide the role.
        AppLogger.warning(
          'Could not read the profile of ${user.uid}',
          error: error,
        );
        emitSession(user, null);
      },
    );
  }

  authSubscription = authRepo.authStateChanges.listen(
    switchProfile,
    onError: (Object error, StackTrace stack) {
      if (!controller.isClosed) controller.addError(error, stack);
    },
  );

  ref.onDispose(() {
    authSessionGeneration++;
    tracker.switchTo(null);
    final auth = authSubscription;
    authSubscription = null;
    if (auth != null) unawaited(auth.cancel());
    cancelProfileSubscription();
    if (!controller.isClosed) unawaited(controller.close());
  });

  return controller.stream;
});

final currentUserProvider = Provider<User?>((ref) {
  // `valueOrNull` and not `value`: `value` re-throws the error of a failed
  // stream, which took down every screen that reads the current user.
  return ref.watch(authStateProvider).valueOrNull;
});

final userProfileProvider = FutureProvider.family<UserModel?, String>((
  ref,
  uid,
) async {
  return await ref.watch(authRepositoryProvider).getUserProfile(uid);
});

/// The role of the currently signed-in user, resolved from their profile.
final userRoleProvider = Provider<UserRole?>((ref) {
  return ref.watch(authSessionProvider).valueOrNull?.role;
});

/// The role stored in the live profile of the signed-in account.
///
/// Unlike [userRoleProvider], this does **not** fall back to `student` while
/// the profile is still loading. Role-gated actions can therefore fail
/// closed instead of briefly offering an action to the wrong role.
final currentUserRoleProvider = Provider<UserRole?>((ref) {
  return ref.watch(authSessionProvider).valueOrNull?.profile?.role;
});

final authControllerProvider = AsyncNotifierProvider<AuthController, void>(() {
  return AuthController();
});

/// The profile mutations which can change the signed-in user's profile or
/// linked authentication methods.
enum ProfileMutationOperation {
  updateDetails,
  linkPhone,
  linkGoogle,
  linkVerifiedEmail,
  syncAuthProfile,
}

/// The currently running profile mutations.
///
/// A set of operation ids is used instead of one `isLoading` boolean. Two
/// callers can therefore finish at different times without the first one
/// re-enabling the controls while the second one is still running.
class ProfileMutationStatus {
  ProfileMutationStatus(Map<int, ProfileMutationOperation> operations)
    : _operations = Map.unmodifiable(operations);

  final Map<int, ProfileMutationOperation> _operations;

  bool get isBusy => _operations.isNotEmpty;

  ProfileMutationOperation? get currentOperation =>
      _operations.values.isEmpty ? null : _operations.values.last;
}

/// Coordinates profile mutations without putting their result in the shared
/// [authControllerProvider] state.
class ProfileMutationController extends Notifier<ProfileMutationStatus> {
  int _nextOperationId = 0;

  @override
  ProfileMutationStatus build() {
    return ProfileMutationStatus(const <int, ProfileMutationOperation>{});
  }

  int begin(ProfileMutationOperation operation) {
    final id = ++_nextOperationId;
    final operations = Map<int, ProfileMutationOperation>.from(
      state._operations,
    );
    operations[id] = operation;
    state = ProfileMutationStatus(operations);
    return id;
  }

  void end(int operationId) {
    if (!state._operations.containsKey(operationId)) return;
    final operations = Map<int, ProfileMutationOperation>.from(
      state._operations,
    );
    operations.remove(operationId);
    state = ProfileMutationStatus(operations);
  }
}

final profileMutationControllerProvider =
    NotifierProvider<ProfileMutationController, ProfileMutationStatus>(
      ProfileMutationController.new,
    );

/// Whether any profile mutation control must be disabled.
final profileMutationBusyProvider = Provider<bool>((ref) {
  return ref.watch(profileMutationControllerProvider).isBusy;
});

/// An error which belongs to one specific profile mutation.
///
/// The original cause is retained, and [readableAuthError] unwraps it. A
/// caller can therefore never accidentally report another concurrent
/// operation's error as its own.
class ProfileOperationException extends OperationException {
  ProfileOperationException(
    this.mutationOperation,
    Object cause, [
    StackTrace? causeStackTrace,
  ]) : super(
         operation: 'profile.${mutationOperation.name}',
         cause: cause,
         causeStackTrace: causeStackTrace,
       );

  /// The profile mutation which produced this error.
  ///
  /// The base [OperationException.operation] remains the stable string used
  /// for diagnostics. This enum is the stronger, typed identity of the
  /// mutation.
  final ProfileMutationOperation mutationOperation;
}

/// The result of asking the server to reconcile a failed registration.
enum _RegistrationRollbackOutcome {
  /// The server proved that the registration was incomplete and removed the
  /// newly created Auth account.
  rolledBack,

  /// The server observed a committed registration and kept the account.
  committed,

  /// The server could not decide. The client must not delete the account on
  /// its own because the registration may have committed.
  unknown,
}

/// A registration which committed but whose final result could not be read.
class RegistrationConfirmationException implements Exception {
  const RegistrationConfirmationException([
    this.message =
        'Your registration was completed, but the app could not confirm the '
        'result. Please sign in again.',
  ]);

  final String message;

  @override
  String toString() => message;
}

/// Whether the app is signing the user out.
///
/// The session of Firebase Auth is empty a moment **after** the sign-out
/// has finished — there is a gap of a few milliseconds between the two.
/// The router uses this flag to know that the login screen is the right
/// place for the user during that gap.
///
/// Without it the router sent a user who was signing out straight back to
/// the dashboard of the role — and when the user was on the dashboard
/// already, the redirect ran into a **redirect loop** and the router
/// showed its "Page Not Found" page instead of the login screen.
final signingOutProvider = StateProvider<bool>((ref) => false);

/// A server-confirmed profile update which has not reached the Firestore
/// snapshot yet.
///
/// Firestore snapshots are asynchronous. Immediately after a successful
/// phone link or role registration, the snapshot can still contain the old
/// `phoneVerified` or `registrationCompleted` value. Without this short-lived
/// transition the router would send the user straight back to the screen they
/// just completed. The transition is only created after the server operation
/// succeeds and is ignored for every other account.
class AuthProfileTransition {
  const AuthProfileTransition({
    required this.uid,
    this.phoneVerified,
    this.registrationCompleted,
    this.role,
  });

  final String uid;
  final bool? phoneVerified;
  final bool? registrationCompleted;
  final UserRole? role;

  @override
  bool operator ==(Object other) {
    return other is AuthProfileTransition &&
        other.uid == uid &&
        other.phoneVerified == phoneVerified &&
        other.registrationCompleted == registrationCompleted &&
        other.role == role;
  }

  @override
  int get hashCode =>
      Object.hash(uid, phoneVerified, registrationCompleted, role);

  /// Whether the live profile has caught up with this transition.
  bool isSatisfiedBy(UserModel? profile) {
    if (profile == null || profile.uid != uid) return false;
    if (phoneVerified != null && profile.phoneVerified != phoneVerified) {
      return false;
    }
    if (registrationCompleted == true && !profile.registrationCompleted) {
      return false;
    }
    if (role != null && profile.role != role) return false;
    return true;
  }
}

/// The latest server-confirmed profile transition for the current account.
final authProfileTransitionProvider = StateProvider<AuthProfileTransition?>(
  (ref) => null,
);

/// Signs the user out and sends them back to the login screen.
///
/// ## Why the router is read **before** the sign-out
///
/// Signing out empties the session, the router re-runs its redirects and
/// the page the button lives on is taken off the stack. Afterwards the
/// `context` of that page is deactivated, and `context.go(...)` on a
/// deactivated context throws — the app ended up on the error page
/// ("Page Not Found") instead of the login screen.
///
/// The router itself survives the sign-out, so it is read first and used
/// afterwards.
///
/// `go` and not `push`: the login screen **replaces** the whole stack, so
/// the back button cannot lead back into the area of the user who just
/// signed out.
///
/// ## Why the app says that it is signing out
///
/// The session of Firebase Auth is empty a moment **after** the sign-out
/// has finished. A `router.go('/login')` inside that gap was redirected
/// back to the dashboard of the role — and when the user was on the
/// dashboard already, the router ran into a redirect loop and showed its
/// error page. The [signingOutProvider] tells the router that the login
/// screen is where the user belongs.
Future<void> signOutAndGoToLogin(BuildContext context, WidgetRef ref) async {
  final router = GoRouter.of(context);

  // The app is signing out — the login screen is the right place for the
  // user, even while the session is still being emptied.
  ref.read(signingOutProvider.notifier).state = true;

  await ref.read(authControllerProvider.notifier).signOut();

  final error = ref.read(authControllerProvider).error;
  if (error != null) {
    // The sign-out failed — the user is still signed in and has to stay
    // where they are.
    ref.read(signingOutProvider.notifier).state = false;
    AppLogger.warning('Could not sign the user out', error: error);
    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Could not sign out: $error')));
    }
    return;
  }

  router.go('/login');
}

class AuthController extends AsyncNotifier<void> {
  @override
  Future<void> build() async {}

  /// Runs an operation which can replace the current Firebase Auth account.
  ///
  /// The old account's device token is removed before Firebase Auth is
  /// allowed to change accounts. If the Auth operation itself fails and the
  /// old account is still current, its token is restored on a best-effort
  /// basis.
  Future<T> _runAuthAccountChange<T>(
    AuthRepository authRepo,
    Future<T> Function() action,
  ) async {
    final oldUid = authRepo.currentUser?.uid;
    if (oldUid == null) return await action();

    await ref.read(pushNotificationRegistrarProvider).unregister(oldUid);

    try {
      return await action();
    } catch (error, stack) {
      if (authRepo.currentUser?.uid == oldUid) {
        try {
          await ref.read(pushNotificationRegistrarProvider).register(oldUid);
        } catch (restoreError) {
          AppLogger.warning(
            'Could not restore the FCM token of $oldUid',
            error: restoreError,
          );
        }
      }
      Error.throwWithStackTrace(error, stack);
    }
  }

  Future<RegistrationResult?> signUp({
    required String email,
    required String password,
    required String name,
    required UserRole role,
    String? challenge,
  }) async {
    state = const AsyncLoading();
    try {
      final registration = await _signUp(
        email: email,
        password: password,
        name: name,
        role: role,
        challenge: challenge,
      );
      state = const AsyncData(null);
      return registration;
    } catch (error, stack) {
      // Keep the existing screen contract (the screen observes this state),
      // while the operation itself performs the safe account reconciliation.
      state = AsyncError(error, stack);
      return null;
    }
  }

  /// Creates the account and completes the server-owned registration.
  ///
  /// Firebase Auth and the registration callable are separate commits. If a
  /// request fails, the client first reconciles the live profile and only
  /// deletes the newly created account when the server proves that the
  /// registration was not committed. A committed registration is never
  /// deleted merely because a later response was lost.
  Future<RegistrationResult?> _signUp({
    required String email,
    required String password,
    required String name,
    required UserRole role,
    String? challenge,
  }) async {
    final authRepo = ref.read(authRepositoryProvider);
    final credential = await _runAuthAccountChange(
      authRepo,
      () =>
          authRepo.signUpWithEmailAndPassword(email: email, password: password),
    );

    final createdUser = credential.user;
    if (createdUser == null) return null;
    final uid = createdUser.uid;

    try {
      // The display name is part of the same pre-registration phase. If it
      // fails, no registration callable has run yet, so the new Auth account
      // can be removed safely as well.
      await authRepo.updateProfile(displayName: name);
    } catch (error, stack) {
      // The display-name write happens before the registration callable, so
      // the account is still incomplete. The server serialises this rollback
      // with the registration transaction and deletes only the account which
      // is still the current, newly created one.
      await _rollbackFailedRegistration(authRepo, uid);
      await _signOutAfterFailedRegistration(authRepo, uid);
      Error.throwWithStackTrace(error, stack);
    }

    // Get pincode from SharedPreferences (set during splash screen location check)
    String? pincode;
    try {
      final prefs = await SharedPreferences.getInstance();
      pincode = prefs.getString('user_pincode');
    } catch (e) {
      // Ignore if SharedPreferences is not available.
    }

    late final RegistrationResult registration;
    try {
      registration = await ref
          .read(otpServiceProvider)
          .completeRegistration(
            name: name,
            role: role.name,
            challenge: challenge ?? '',
            pincode: pincode,
          );
    } catch (error, stack) {
      // The callable is idempotent for a registration which already
      // committed. Ask the server to reconcile the two possible outcomes in
      // one transaction: it either deletes the still-incomplete account or
      // proves that the registration committed and keeps the account.
      final outcome = await _rollbackFailedRegistration(authRepo, uid);

      if (outcome == _RegistrationRollbackOutcome.committed) {
        final reconciled = await _reconcileCommittedRegistration(
          authRepo: authRepo,
          uid: uid,
          name: name,
          role: role,
          challenge: challenge ?? '',
          pincode: pincode,
        );
        if (reconciled == null) {
          // The server proved that this account is registered. Keep the
          // session and do not report it as a failed, rolled-back sign-up.
          throw const RegistrationConfirmationException();
        }
        registration = reconciled;
      } else {
        // `rolledBack` is proven safe to remove. `unknown` is deliberately
        // treated the same way on the client: no direct Auth delete is ever
        // attempted, because the registration may have committed even though
        // its response was lost.
        await _signOutAfterFailedRegistration(authRepo, uid);
        Error.throwWithStackTrace(error, stack);
      }
    }

    // From this point on the server has committed the registration. A token
    // refresh or a snapshot delay must not turn a committed registration
    // into a failed one.
    try {
      await authRepo.refreshIdToken();
    } catch (error) {
      AppLogger.warning(
        'Could not refresh the token after registration',
        error: error,
      );
    }

    // The Firestore snapshot may still contain the incomplete profile for a
    // short moment. Keep the server-confirmed role and phone state so the
    // router cannot route through role selection or briefly reopen a service
    // area with an old phone grant.
    ref
        .read(authProfileTransitionProvider.notifier)
        .state = AuthProfileTransition(
      uid: uid,
      registrationCompleted: true,
      phoneVerified: registration.phoneVerified,
      role: UserRoleX.fromString(registration.role),
    );

    return registration;
  }

  /// Reconciles a registration which the server proved to be committed.
  ///
  /// `completeRegistration` is idempotent for a completed profile, so the
  /// safest way to recover the authoritative role and phone state is to run
  /// it once more. The Firestore profile is only a fallback for the case in
  /// which the retry itself cannot reach the server.
  Future<RegistrationResult?> _reconcileCommittedRegistration({
    required AuthRepository authRepo,
    required String uid,
    required String name,
    required UserRole role,
    required String challenge,
    String? pincode,
  }) async {
    if (authRepo.currentUser?.uid != uid) {
      AppLogger.warning(
        'The committed registration no longer belongs to the current account',
      );
      return null;
    }

    try {
      return await ref
          .read(otpServiceProvider)
          .completeRegistration(
            name: name,
            role: role.name,
            challenge: challenge,
            pincode: pincode,
          );
    } catch (error) {
      AppLogger.warning(
        'Could not reconcile the committed registration',
        error: error,
      );
    }

    try {
      final profile = await authRepo.getUserProfile(uid);
      if (profile != null && profile.registrationCompleted) {
        return RegistrationResult(
          role: profile.role.name,
          phoneVerified: profile.phoneVerified,
        );
      }
    } catch (error) {
      AppLogger.warning(
        'Could not read the committed registration profile',
        error: error,
      );
    }
    return null;
  }

  /// Asks the server to decide whether the failed registration committed.
  ///
  /// The server compares the live profile with its durable rollback marker
  /// in the same transaction as the registration. Therefore exactly one of
  /// the two operations can win: a committed registration is kept, while an
  /// incomplete account is deleted. A client-side `deleteUser` would not
  /// provide that guarantee.
  Future<_RegistrationRollbackOutcome> _rollbackFailedRegistration(
    AuthRepository authRepo,
    String uid,
  ) async {
    // Never ask the server to roll back a different account which may have
    // become current while the failed request was being reconciled.
    if (authRepo.currentUser?.uid != uid) {
      AppLogger.warning(
        'The failed registration no longer belongs to the current account',
      );
      return _RegistrationRollbackOutcome.unknown;
    }

    try {
      final result = await authRepo.rollbackIncompleteRegistration(uid: uid);
      if (result['rolledBack'] == true) {
        return _RegistrationRollbackOutcome.rolledBack;
      }
      if (result['registrationCompleted'] == true) {
        return _RegistrationRollbackOutcome.committed;
      }
      AppLogger.warning('The server did not confirm the rollback of $uid');
    } catch (error) {
      // The rollback state is unknown. The client must fail closed: it may
      // not delete the account itself, because the registration transaction
      // could already have committed.
      AppLogger.warning(
        'Could not reconcile the failed registration',
        error: error,
      );
    }
    return _RegistrationRollbackOutcome.unknown;
  }

  Future<void> _signOutAfterFailedRegistration(
    AuthRepository authRepo,
    String uid,
  ) async {
    final currentUid = authRepo.currentUser?.uid;
    if (currentUid != null && currentUid != uid) {
      // A different account became current in the meantime. Signing it out
      // would punish the wrong user.
      AppLogger.warning(
        'Did not sign out a different account after the failed registration',
      );
      return;
    }
    try {
      await authRepo.signOut();
    } catch (error) {
      AppLogger.warning(
        'Could not sign out after a failed registration',
        error: error,
      );
    }
  }

  Future<void> signIn({required String email, required String password}) async {
    // The history is thrown away **before** the sign-in starts.
    //
    // The dashboard the user lands on is recorded by the navigation guard as
    // soon as it is built — that happens while the sign-in is still running.
    // A history that was cleared *after* that would throw the dashboard
    // away again, and the back button would stop working.
    ref.read(navigationHistoryProvider).clear();

    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final authRepo = ref.read(authRepositoryProvider);
      final credential = await authRepo.signInWithEmailAndPassword(
        email: email,
        password: password,
      );
      await _validateActiveProfile(credential);
    });
  }

  /// Signs in with Google's OpenID Connect identity through Firebase Auth.
  Future<void> signInWithGoogle() async {
    ref.read(navigationHistoryProvider).clear();
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final authRepo = ref.read(authRepositoryProvider);
      final credential = await authRepo.signInWithGoogle();
      await _validateActiveProfile(credential);
    });
  }

  /// Signs in with a Firebase-verified phone number.
  Future<void> signInWithPhoneCredential(PhoneAuthCredential credential) async {
    ref.read(navigationHistoryProvider).clear();
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final authRepo = ref.read(authRepositoryProvider);
      final userCredential = await authRepo.signInWithPhoneCredential(
        credential,
      );
      await _validateActiveProfile(userCredential);
    });
  }

  /// Links a Firebase-verified phone number and synchronises the live
  /// Firebase identity facts into the server-owned profile.
  Future<void> linkPhoneCredential(
    PhoneAuthCredential credential, {
    String? phoneNumber,
  }) {
    return _runProfileOperation(ProfileMutationOperation.linkPhone, () async {
      final authRepo = ref.read(authRepositoryProvider);
      FirebaseAuthException? recoverableError;
      StackTrace? recoverableStack;

      try {
        await authRepo.linkPhoneCredential(credential);
      } catch (error, stack) {
        if (error is! FirebaseAuthException) rethrow;
        final isRecoverable =
            error.code == 'provider-already-linked' ||
            error.code == 'credential-already-in-use' ||
            error.code == 'phone-number-already-in-use' ||
            error.code == 'phone-number-already-exists';
        if (!isRecoverable) rethrow;
        recoverableError = error;
        recoverableStack = stack;
      }

      // The local User object can still contain the phone number from
      // before the link. Reload the live Auth record before comparing it
      // with the attempted number.
      User? liveUser;
      try {
        liveUser = await authRepo.reloadCurrentUser();
      } catch (reloadError, reloadStack) {
        AppLogger.warning(
          'Could not reload the live phone identity after linking',
          error: reloadError,
        );
        if (recoverableError != null) {
          Error.throwWithStackTrace(
            recoverableError,
            recoverableStack ?? StackTrace.current,
          );
        }
        Error.throwWithStackTrace(reloadError, reloadStack);
      }

      if (recoverableError != null) {
        // Only the exact attempted number proves that this account was the
        // one which was linked. A stale or different number is a real
        // conflict and must not be hidden.
        if (!_sameFirebasePhone(liveUser?.phoneNumber, phoneNumber)) {
          Error.throwWithStackTrace(
            recoverableError,
            recoverableStack ?? StackTrace.current,
          );
        }
      } else if (phoneNumber != null &&
          !_sameFirebasePhone(liveUser?.phoneNumber, phoneNumber)) {
        throw StateError(
          'The phone link did not produce the requested phone number.',
        );
      }

      final syncedProfile = await authRepo.syncAuthProfile();
      // The server owns the verification facts. It re-reads the live Firebase
      // Auth record together with the durable phone-verification proof, so it
      // is the only authority on whether the number really completed the SMS
      // challenge. A missing or false flag is a failure: the client must
      // never announce a verified phone which the server did not confirm.
      final serverPhoneVerified = syncedProfile['phoneVerified'] == true;
      if (!serverPhoneVerified) {
        throw StateError(
          'The phone number could not be verified. Please try again.',
        );
      }
      final uid = liveUser?.uid ?? authRepo.currentUser?.uid;
      if (uid != null) {
        ref.read(authProfileTransitionProvider.notifier).state =
            AuthProfileTransition(uid: uid, phoneVerified: true);
      }
    });
  }

  /// Links a Google OpenID Connect identity to the signed-in account.
  Future<void> linkGoogleProvider() {
    return _runProfileOperation(ProfileMutationOperation.linkGoogle, () async {
      final authRepo = ref.read(authRepositoryProvider);

      // Capture the authoritative provider identities before the attempt.
      // A stale local User object must never be used to decide whether a
      // provider was newly linked.
      final providersBefore = await authRepo.linkedGoogleProviderIdentities(
        refresh: true,
      );

      try {
        await authRepo.linkGoogleProvider();
      } catch (error, stack) {
        // `credential-already-in-use` is never a successful link retry: it
        // means that the selected credential belongs to a different Firebase
        // account. `provider-already-linked` is only recoverable when the
        // live provider state proves the exact attempted identity.
        if (error is! FirebaseAuthException ||
            error.code != 'provider-already-linked') {
          rethrow;
        }

        final List<FirebaseProviderIdentity> providersAfter;
        try {
          providersAfter = await authRepo.linkedGoogleProviderIdentities(
            refresh: true,
          );
        } catch (reloadError) {
          AppLogger.warning(
            'Could not refresh the linked Google providers',
            error: reloadError,
          );
          Error.throwWithStackTrace(error, stack);
        }

        if (!_googleRecoveryMatchesAttempt(
          providersBefore: providersBefore,
          providersAfter: providersAfter,
          attemptedEmail: error.email?.trim().toLowerCase(),
        )) {
          Error.throwWithStackTrace(error, stack);
        }
      }

      // The server profile is the source of truth for the linked provider.
      // Sync it only after the live Auth state has been checked.
      await authRepo.syncAuthProfile();
    });
  }

  /// Synchronises the current signed Firebase claims into the profile.
  Future<void> syncAuthProfile() {
    return _runProfileOperation(
      ProfileMutationOperation.syncAuthProfile,
      () async {
        await ref.read(authRepositoryProvider).syncAuthProfile();
      },
    );
  }

  /// Adds a verified email address to a phone-first account.
  Future<void> linkVerifiedEmail({
    required String email,
    required String challenge,
  }) {
    return _runProfileOperation(
      ProfileMutationOperation.linkVerifiedEmail,
      () async {
        final authRepo = ref.read(authRepositoryProvider);
        // The callable updates Firebase Auth **and** the server-owned profile
        // in one durable operation. A second profile synchronisation would be
        // redundant and could turn a successful link into a reported failure
        // when only that extra call failed.
        await authRepo.linkVerifiedEmail(email: email, challenge: challenge);
      },
    );
  }

  /// Ensures that a disabled account cannot keep a Firebase session.
  ///
  /// From this point on Firebase has authenticated the account. If a
  /// post-authentication check fails, the authentication is rolled back so
  /// the UI cannot show a failed login while Firebase still considers the
  /// user signed in.
  Future<void> _validateActiveProfile(UserCredential credential) async {
    final user = credential.user;
    if (user == null) return;
    final authRepo = ref.read(authRepositoryProvider);
    try {
      final profile = await authRepo.getUserProfile(user.uid);
      if (profile != null && !profile.isActive) {
        throw Exception('Account has been disabled. Please contact support.');
      }
    } catch (_) {
      await authRepo.signOut();
      rethrow;
    }
  }

  Future<void> signOut() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final authRepo = ref.read(authRepositoryProvider);

      // The token of this device is taken off the profile **before** the
      // sign-out: otherwise the server keeps pushing the notifications of
      // the account that signed out to a device that now belongs to
      // somebody else. The registrar retries a transient Firestore failure
      // and reports the final failure. In that case Firebase Auth must stay
      // signed in, because the old token may still be attached.
      final uid =
          authRepo.currentUser?.uid ?? ref.read(currentUserProvider)?.uid;
      if (uid != null) {
        await ref.read(pushNotificationRegistrarProvider).unregister(uid);
      }

      await authRepo.signOut();
      ref.read(authProfileTransitionProvider.notifier).state = null;

      // The pages of the old session mean nothing to the next user.
      ref.read(navigationHistoryProvider).clear();
    });
  }

  Future<void> sendPasswordResetEmail(String email) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final authRepo = ref.read(authRepositoryProvider);
      await authRepo.sendPasswordResetEmail(email);
    });
  }

  Future<void> updateProfile({
    String? name,
    String? profileImage,
    bool removeProfileImage = false,
  }) {
    return _runProfileOperation(
      ProfileMutationOperation.updateDetails,
      () async {
        final user = ref.read(currentUserProvider);
        if (user == null) {
          throw Exception('You have to be signed in to change your profile');
        }

        final authRepo = ref.read(authRepositoryProvider);
        final updates = <String, dynamic>{};
        if (name != null) updates['name'] = name;
        if (profileImage != null) updates['profileImage'] = profileImage;
        // The old code skipped the update when the picture was removed, so a
        // user could never get rid of their profile photo again.
        if (removeProfileImage) updates['profileImage'] = '';

        if (updates.isNotEmpty) {
          await authRepo.updateUserProfile(user.uid, updates);
          // Pass only the fields which were explicitly changed. In
          // particular, removing a photo must not clear the Auth display
          // name.
          await authRepo.updateProfile(
            displayName: name,
            photoURL: removeProfileImage ? '' : profileImage,
          );
        }
      },
    );
  }

  /// Runs one profile mutation without publishing its result to the shared
  /// auth-controller state.
  ///
  /// Each caller receives the error from its own operation. The coordinator
  /// only tracks which controls must be disabled; it does not decide which
  /// operation succeeded or failed.
  Future<T> _runProfileOperation<T>(
    ProfileMutationOperation operation,
    Future<T> Function() action,
  ) async {
    final coordinator = ref.read(profileMutationControllerProvider.notifier);
    final operationId = coordinator.begin(operation);
    try {
      return await action();
    } catch (error, stack) {
      if (error is ProfileOperationException) {
        Error.throwWithStackTrace(error, stack);
      }
      Error.throwWithStackTrace(
        ProfileOperationException(operation, error, stack),
        stack,
      );
    } finally {
      coordinator.end(operationId);
    }
  }
}

/// Compares a live Firebase phone number with the number which the user
/// attempted to link.
bool _sameFirebasePhone(String? livePhone, String? attemptedPhone) {
  final live = _canonicalFirebasePhone(livePhone);
  final attempted = _canonicalFirebasePhone(attemptedPhone);
  return live != null && attempted != null && live == attempted;
}

/// Canonicalises the common representations of a Firebase phone number.
String? _canonicalFirebasePhone(String? value) {
  final trimmed = value?.trim() ?? '';
  if (trimmed.isEmpty) return null;
  final hadPlus = trimmed.startsWith('+');
  final digits = trimmed.replaceAll(RegExp(r'[^0-9]'), '');
  if (digits.isEmpty) return null;
  if (hadPlus || trimmed.startsWith('00')) return '+$digits';
  if (digits.length == 10) return '+91$digits';
  if (digits.length == 12 && digits.startsWith('91')) return '+91$digits';
  return digits;
}

/// Whether the live provider state proves the exact Google identity which
/// was attempted.
///
/// When Firebase includes the attempted address in its exception, it is
/// matched against the reloaded provider identities. When it does not, the
/// only safe inference is that the account had no Google provider before the
/// attempt and exactly one provider exists after it. A pre-existing provider
/// must never be accepted as the result of a different attempt.
bool _googleRecoveryMatchesAttempt({
  required List<FirebaseProviderIdentity> providersBefore,
  required List<FirebaseProviderIdentity> providersAfter,
  required String? attemptedEmail,
}) {
  final email = attemptedEmail?.trim().toLowerCase();
  if (email != null && email.isNotEmpty) {
    final matches = providersAfter
        .where((provider) => provider.normalizedEmail == email)
        .toList(growable: false);
    return matches.length == 1;
  }

  if (providersBefore.isNotEmpty || providersAfter.length != 1) return false;
  final candidate = providersAfter.single;
  return !providersBefore.any((provider) => provider == candidate);
}
