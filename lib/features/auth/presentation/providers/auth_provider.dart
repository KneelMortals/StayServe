import 'dart:async';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../../../core/constants/enums.dart';
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

/// The work that has to happen after a user signs in.
///
/// Token refresh and FCM registration are kept behind this small callback so
/// the auth-session regression test does not need the Firebase Messaging
/// plugin. A failure is logged and never terminates the session.
typedef AuthSessionUserChanged = Future<void> Function(User user);

final authSessionUserChangedProvider = Provider<AuthSessionUserChanged>((ref) {
  return (user) async {
    // The custom claims are attached by the Cloud Functions *after* the
    // account was created, so the token of a returning user can be stale.
    // Refreshing it here makes sure the `admin` claim is picked up as soon
    // as an admin granted the role.
    await ref.read(authRepositoryProvider).refreshIdToken();

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

  final controller = StreamController<AuthSession?>();
  StreamSubscription<User?>? authSubscription;
  StreamSubscription<UserModel?>? profileSubscription;
  String? activeUid;

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

  void switchProfile(User? user) {
    cancelProfileSubscription();
    activeUid = user?.uid;

    if (user == null) {
      // This is the event the old `asyncExpand` implementation could never
      // deliver. It is what lets the router leave the protected pages and
      // what makes an immediate second sign-in work.
      if (!controller.isClosed) controller.add(null);
      return;
    }

    // Refresh the token and register the push token for this account. These
    // operations must not be able to terminate the session stream.
    unawaited(() async {
      try {
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

  Future<void> signUp({
    required String email,
    required String password,
    required String name,
    required UserRole role,
    String? phone,
    String? challenge,
  }) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final authRepo = ref.read(authRepositoryProvider);
      final credential = await authRepo.signUpWithEmailAndPassword(
        email: email,
        password: password,
      );

      if (credential.user != null) {
        await authRepo.updateProfile(displayName: name);

        // Get pincode from SharedPreferences (set during splash screen location check)
        String? pincode;
        try {
          final prefs = await SharedPreferences.getInstance();
          pincode = prefs.getString('user_pincode');
        } catch (e) {
          // Ignore if SharedPreferences not available
        }

        // The server writes the profile and re-checks that the email address
        // was verified with an OTP. If it refuses, the half-created account
        // is rolled back so the user can simply register again.
        try {
          await ref
              .read(otpServiceProvider)
              .completeRegistration(
                name: name,
                phone: phone,
                role: role.name,
                challenge: challenge ?? '',
                pincode: pincode,
              );

          // The server attached the role claim while completing the
          // registration — the token issued at sign-up does not carry it
          // yet, so it is refreshed here.
          await authRepo.refreshIdToken();
        } catch (e) {
          await authRepo.signOut();
          rethrow;
        }
      }
    });
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

      if (credential.user != null) {
        // From this point on Firebase has authenticated the account. If a
        // post-authentication step fails, roll the authentication back so
        // the UI cannot show a failed login while Firebase still considers
        // the user signed in.
        try {
          final profile = await authRepo.getUserProfile(credential.user!.uid);
          if (profile != null && !profile.isActive) {
            throw Exception(
              'Account has been disabled. Please contact support.',
            );
          }
        } catch (_) {
          await authRepo.signOut();
          rethrow;
        }
      }
    });
  }

  Future<void> signOut() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final authRepo = ref.read(authRepositoryProvider);

      // The token of this device is taken off the profile **before** the
      // sign-out: otherwise the server keeps pushing the notifications of
      // the account that signed out to a device that now belongs to
      // somebody else.
      final uid = ref.read(currentUserProvider)?.uid;
      if (uid != null) {
        try {
          await ref.read(pushNotificationRegistrarProvider).unregister(uid);
        } catch (e) {
          // A missing token is not a reason to keep the user signed in.
          AppLogger.warning('Could not remove the FCM token', error: e);
        }
      }

      await authRepo.signOut();

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
    String? phone,
    String? profileImage,
    bool removeProfileImage = false,
  }) async {
    final user = ref.read(currentUserProvider);
    if (user == null) {
      throw Exception('You have to be signed in to change your profile');
    }

    state = const AsyncLoading();
    try {
      final authRepo = ref.read(authRepositoryProvider);
      final updates = <String, dynamic>{};
      if (name != null) updates['name'] = name;
      if (phone != null) updates['phone'] = phone;
      if (profileImage != null) updates['profileImage'] = profileImage;
      // The old code skipped the update when the picture was removed, so a
      // user could never get rid of their profile photo again.
      if (removeProfileImage) updates['profileImage'] = '';

      if (updates.isNotEmpty) {
        await authRepo.updateUserProfile(user.uid, updates);
        if (name != null) {
          await authRepo.updateProfile(displayName: name);
        }
        if (removeProfileImage) {
          await authRepo.updateProfile(photoURL: '');
        }
      }
      state = const AsyncData(null);
    } catch (e, st) {
      state = AsyncError(e, st);
      // The error is **re-thrown**.
      //
      // `AsyncValue.guard` only puts the error into the state — the `await`
      // of the caller returns normally. The screen then showed "Profile
      // updated" and closed itself even though nothing had been written.
      rethrow;
    }
  }
}
