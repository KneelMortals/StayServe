import 'package:material_ui/material_ui.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/enums.dart';
import 'back_to_dashboard.dart';
import 'navigation_history.dart';
import '../../features/admin/presentation/widgets/admin_scaffold.dart';
import '../../features/auth/presentation/providers/auth_provider.dart';
import '../../features/auth/presentation/screens/splash_screen.dart';
import '../../features/auth/presentation/screens/login_screen.dart';
import '../../features/auth/presentation/screens/register_screen.dart';
import '../../features/auth/presentation/screens/forgot_password_screen.dart';
import '../../features/auth/presentation/screens/role_selection_screen.dart';
import '../../features/auth/presentation/screens/otp_verification_screen.dart';
import '../../features/auth/presentation/screens/phone_verification_screen.dart';
import '../../firebase/otp/otp_service.dart';
import '../../features/students/presentation/screens/student_home_screen.dart';
import '../../features/students/presentation/screens/student_search_screen.dart';
import '../../features/students/presentation/screens/room_detail_screen.dart';
import '../../features/reviews/presentation/screens/room_reviews_screen.dart';
import '../../features/students/presentation/screens/saved_rooms_screen.dart';
import '../../features/students/presentation/screens/student_profile_screen.dart';
import '../../features/students/presentation/screens/student_requests_screen.dart';
import '../../features/profile/presentation/screens/edit_profile_screen.dart';
import '../../features/joined_rooms/presentation/screens/joined_rooms_screen.dart';
import '../../features/owners/presentation/screens/owner_dashboard_screen.dart';
import '../../features/owners/presentation/screens/my_rooms_screen.dart';
import '../../features/owners/presentation/screens/create_room_screen.dart';
import '../../features/owners/presentation/screens/edit_room_screen.dart';
import '../../features/owners/presentation/screens/owner_requests_screen.dart';
import '../../features/owners/presentation/screens/owner_invoices_screen.dart';
import '../../features/owners/presentation/screens/owner_profile_screen.dart';
import '../../features/admin/presentation/screens/admin_dashboard_screen.dart';
import '../../features/admin/presentation/screens/admin_users_screen.dart';
import '../../features/admin/presentation/screens/admin_rooms_screen.dart';
import '../../features/admin/presentation/screens/admin_requests_screen.dart';
import '../../features/admin/presentation/screens/admin_invoices_screen.dart';
import '../../features/admin/presentation/screens/admin_payments_screen.dart';
import '../../features/admin/presentation/screens/admin_analytics_screen.dart';
import '../../features/admin/presentation/screens/admin_settings_screen.dart';
import '../../features/admin/presentation/screens/admin_launch_areas_screen.dart';
import '../../features/messaging/presentation/screens/conversations_screen.dart';
import '../../features/messaging/presentation/screens/chat_screen.dart';
import '../../features/invoices/presentation/screens/invoice_detail_screen.dart';
import '../../features/notifications/presentation/screens/notifications_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  // The router must NOT be recreated when the auth state changes: doing so
  // discards the navigation stack and drops the user back on the splash
  // screen. Instead we keep one router instance and ask it to re-evaluate
  // its redirects whenever the session changes.
  final refreshListenable = _RouterRefreshNotifier();
  ref.onDispose(refreshListenable.dispose);
  ref.listen(authSessionProvider, (_, next) {
    // A confirmed session value (including a confirmed `null`) is the
    // authoritative end of a sign-out. Do not clear the flag while the
    // session is merely loading or has failed — that distinction was the
    // source of the old logout race.
    if (next.hasValue) {
      ref.read(signingOutProvider.notifier).state = false;

      final session = next.valueOrNull;
      final transition = ref.read(authProfileTransitionProvider);
      if (transition != null) {
        final belongsToAnotherAccount =
            session == null || session.user.uid != transition.uid;
        if (belongsToAnotherAccount ||
            transition.isSatisfiedBy(session.profile)) {
          ref.read(authProfileTransitionProvider.notifier).state = null;
        }
      }
    }
    refreshListenable.refresh();
  });

  // The Firebase auth state is watched separately from the profile-enriched
  // session. The router must react to a logout/login immediately, even while
  // the profile snapshot of the previous account is being replaced.
  ref.listen(currentUserProvider, (_, __) {
    refreshListenable.refresh();
  });

  // A server-confirmed phone/role update can arrive before the matching
  // Firestore snapshot. Re-run the redirect immediately when that transition
  // is created so the completed screen is left without a visible bounce.
  ref.listen(authProfileTransitionProvider, (_, __) {
    refreshListenable.refresh();
  });

  return GoRouter(
    initialLocation: '/splash',
    debugLogDiagnostics: true,
    refreshListenable: refreshListenable,
    redirect: (context, state) => resolveAuthRedirect(
      sessionAsync: ref.read(authSessionProvider),
      directUser: ref.read(currentUserProvider),
      location: state.matchedLocation,
      signingOut: ref.read(signingOutProvider),
      transition: ref.read(authProfileTransitionProvider),
    ),

    routes: [
      GoRoute(
        path: '/splash',
        name: 'splash',
        builder: (context, state) => const BackToPreviousPage(
          // The splash screen is the way into the app, not a page of it —
          // going "back" to it would be meaningless.
          recordInHistory: false,
          location: '/splash',
          child: SplashScreen(),
        ),
      ),
      GoRoute(
        path: '/login',
        name: 'login',
        builder: (context, state) =>
            const BackToPreviousPage(location: '/login', child: LoginScreen()),
      ),
      GoRoute(
        path: '/register',
        name: 'register',
        builder: (context, state) => const BackToPreviousPage(
          location: '/register',
          child: RegisterScreen(),
        ),
      ),
      GoRoute(
        path: '/forgot-password',
        name: 'forgot-password',
        builder: (context, state) => const BackToPreviousPage(
          location: '/forgot-password',
          child: ForgotPasswordScreen(),
        ),
      ),
      GoRoute(
        path: '/role-selection',
        name: 'role-selection',
        builder: (context, state) => const BackToPreviousPage(
          location: '/role-selection',
          child: RoleSelectionScreen(),
        ),
      ),
      GoRoute(
        path: '/phone-auth',
        name: 'phone-auth',
        builder: (context, state) => const BackToPreviousPage(
          location: '/phone-auth',
          child: PhoneVerificationScreen(mode: PhoneVerificationMode.signIn),
        ),
      ),
      GoRoute(
        path: '/verify-phone',
        name: 'verify-phone',
        builder: (context, state) {
          final phone = ref
              .read(authSessionProvider)
              .valueOrNull
              ?.profile
              ?.phone;
          return BackToPreviousPage(
            location: state.uri.path,
            child: PhoneVerificationScreen(
              mode: PhoneVerificationMode.link,
              initialPhoneNumber: phone,
            ),
          );
        },
      ),
      GoRoute(
        path: '/verify-otp',
        name: 'verify-otp',
        builder: (context, state) {
          final channel = OtpChannelX.fromWire(
            state.uri.queryParameters['channel'] ?? OtpChannel.email.name,
          );
          final identifier = state.uri.queryParameters['identifier'] ?? '';
          return BackToPreviousPage(
            location: state.uri.path,
            child: OtpVerificationScreen(
              channel: channel,
              identifier: identifier,
            ),
          );
        },
      ),

      // Student Routes
      ShellRoute(
        builder: (context, state, child) =>
            StudentShell(location: state.uri.path, child: child),
        routes: [
          GoRoute(
            path: '/student/home',
            name: 'student-home',
            builder: (context, state) => const StudentHomeScreen(),
          ),
          GoRoute(
            path: '/student/search',
            name: 'student-search',
            builder: (context, state) => const StudentSearchScreen(),
          ),
          GoRoute(
            path: '/student/saved',
            name: 'student-saved',
            builder: (context, state) => const SavedRoomsScreen(),
          ),
          GoRoute(
            path: '/student/joined-rooms',
            name: 'student-joined-rooms',
            builder: (context, state) => const JoinedRoomsScreen(),
          ),
          GoRoute(
            path: '/student/requests',
            name: 'student-requests',
            builder: (context, state) => const StudentRequestsScreen(),
          ),
          GoRoute(
            path: '/student/profile',
            name: 'student-profile',
            builder: (context, state) => const StudentProfileScreen(),
          ),
          GoRoute(
            path: '/student/profile/edit',
            name: 'student-profile-edit',
            builder: (context, state) => const EditProfileScreen(),
          ),
        ],
      ),
      GoRoute(
        path: '/room/:roomId',
        name: 'room-detail',
        builder: (context, state) {
          final roomId = state.pathParameters['roomId']!;
          return BackToDashboard(
            location: state.uri.path,
            child: RoomDetailScreen(roomId: roomId),
          );
        },
      ),
      // The reviews of a room.
      //
      // A student may only **write** a review when the owner accepted their
      // request — the check is made by the server, the screen only mirrors
      // it.
      GoRoute(
        path: '/room/:roomId/reviews',
        name: 'room-reviews',
        builder: (context, state) {
          final roomId = state.pathParameters['roomId']!;
          return BackToDashboard(
            location: state.uri.path,
            child: RoomReviewsScreen(roomId: roomId),
          );
        },
      ),

      // Owner Routes
      ShellRoute(
        builder: (context, state, child) =>
            OwnerShell(location: state.uri.path, child: child),
        routes: [
          GoRoute(
            path: '/owner/dashboard',
            name: 'owner-dashboard',
            builder: (context, state) => const OwnerDashboardScreen(),
          ),
          GoRoute(
            path: '/owner/rooms',
            name: 'owner-rooms',
            builder: (context, state) => const MyRoomsScreen(),
          ),
          GoRoute(
            path: '/owner/rooms/create',
            name: 'create-room',
            builder: (context, state) => CreateRoomScreen(
              // The room can be added to one of the owner's existing homes.
              initialHomeId: state.uri.queryParameters['homeId'],
            ),
          ),
          GoRoute(
            path: '/owner/rooms/edit/:roomId',
            name: 'edit-room',
            builder: (context, state) {
              final roomId = state.pathParameters['roomId']!;
              return EditRoomScreen(roomId: roomId);
            },
          ),
          GoRoute(
            path: '/owner/requests',
            name: 'owner-requests',
            builder: (context, state) => const OwnerRequestsScreen(),
          ),
          GoRoute(
            path: '/owner/invoices',
            name: 'owner-invoices',
            builder: (context, state) => const OwnerInvoicesScreen(),
          ),
          GoRoute(
            path: '/owner/profile',
            name: 'owner-profile',
            builder: (context, state) => const OwnerProfileScreen(),
          ),
          GoRoute(
            path: '/owner/profile/edit',
            name: 'owner-profile-edit',
            builder: (context, state) => const EditProfileScreen(),
          ),
        ],
      ),

      // Admin Routes
      ShellRoute(
        builder: (context, state, child) =>
            AdminShell(location: state.uri.path, child: child),
        routes: [
          GoRoute(
            path: '/admin/dashboard',
            name: 'admin-dashboard',
            builder: (context, state) => const AdminDashboardScreen(),
          ),
          GoRoute(
            path: '/admin/users',
            name: 'admin-users',
            builder: (context, state) => const AdminUsersScreen(),
          ),
          GoRoute(
            path: '/admin/rooms',
            name: 'admin-rooms',
            builder: (context, state) => const AdminRoomsScreen(),
          ),
          GoRoute(
            path: '/admin/requests',
            name: 'admin-requests',
            builder: (context, state) => const AdminRequestsScreen(),
          ),
          GoRoute(
            path: '/admin/invoices',
            name: 'admin-invoices',
            builder: (context, state) => const AdminInvoicesScreen(),
          ),
          GoRoute(
            path: '/admin/payments',
            name: 'admin-payments',
            builder: (context, state) => const AdminPaymentsScreen(),
          ),
          GoRoute(
            path: '/admin/analytics',
            name: 'admin-analytics',
            builder: (context, state) => const AdminAnalyticsScreen(),
          ),
          GoRoute(
            path: '/admin/settings',
            name: 'admin-settings',
            builder: (context, state) => const AdminSettingsScreen(),
          ),
          GoRoute(
            path: '/admin/launch-areas',
            name: 'admin-launch-areas',
            builder: (context, state) => const AdminLaunchAreasScreen(),
          ),
        ],
      ),

      // Shared Routes
      GoRoute(
        path: '/conversations',
        name: 'conversations',
        builder: (context, state) => BackToDashboard(
          location: state.uri.path,
          child: const ConversationsScreen(),
        ),
      ),
      GoRoute(
        path: '/chat/:conversationId',
        name: 'chat',
        builder: (context, state) {
          final conversationId = state.pathParameters['conversationId']!;
          return BackToDashboard(
            location: state.uri.path,
            child: ChatScreen(
              conversationId: conversationId,
              // The recipient of the messages is handed over with the route,
              // so the chat does not have to wait for the conversation list.
              peerId: state.uri.queryParameters['peer'],
              roomId: state.uri.queryParameters['room'],
              requestId: state.uri.queryParameters['request'],
            ),
          );
        },
      ),
      GoRoute(
        path: '/invoice/:invoiceId',
        name: 'invoice-detail',
        builder: (context, state) {
          final invoiceId = state.pathParameters['invoiceId']!;
          return BackToDashboard(
            location: state.uri.path,
            child: InvoiceDetailScreen(invoiceId: invoiceId),
          );
        },
      ),
      GoRoute(
        path: '/notifications',
        name: 'notifications',
        builder: (context, state) => BackToDashboard(
          location: state.uri.path,
          child: const NotificationsScreen(),
        ),
      ),
    ],
    errorBuilder: (context, state) => Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.error_outline, size: 64, color: Colors.red),
            const SizedBox(height: 16),
            Text(
              'Page Not Found',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            const SizedBox(height: 8),
            Text(
              state.error.toString(),
              style: Theme.of(context).textTheme.bodyMedium,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              onPressed: () => context.go(
                homeForRole(ref.read(authSessionProvider).valueOrNull?.role),
              ),
              child: const Text('Go Home'),
            ),
          ],
        ),
      ),
    ),
  );
});

/// Resolves the authentication and role gates for one navigation attempt.
///
/// The policy is kept outside the [GoRouter] callback so it can be tested
/// without mounting every screen behind the routes. The callback below is
/// only a thin adapter which supplies the live providers to this function.
String? resolveAuthRedirect({
  required AsyncValue<AuthSession?> sessionAsync,
  required User? directUser,
  required String location,
  required bool signingOut,
  AuthProfileTransition? transition,
}) {
  final session = sessionAsync.valueOrNull;
  const authRoutes = kAuthLocations;

  // The splash screen owns the initial hand-off (force-update checks,
  // maintenance mode and pincode gating), so it is never redirected away
  // from automatically.
  if (location == '/splash') return null;

  // The session is still being resolved. Stay put; the router will re-run
  // this redirect as soon as the session resolves.
  if (sessionAsync.isLoading && !sessionAsync.hasValue) return null;

  // Firebase's auth state is authoritative for authentication. The
  // profile-enriched session is authoritative for the role. A confirmed null
  // session means that the account signed out; a session for a different uid
  // means that the account changed and its new profile is still resolving.
  final sessionUser = session?.user;
  User? user;
  if (sessionAsync.hasValue && session == null) {
    user = null;
  } else if (sessionUser != null) {
    if (directUser != null && directUser.uid != sessionUser.uid) {
      // A different account has signed in. Wait for its profile rather than
      // redirecting it with the previous account's role.
      return null;
    }
    user = sessionUser;
  } else {
    user = directUser;
  }

  // Not signed in. The phone-verification screen belongs to an existing
  // session. The phone sign-in screen may be opened while signed out.
  if (user == null) {
    if (location == '/verify-phone') return '/login';
    // Role selection is only meaningful for a signed-in account. Leaving a
    // signed-out user there was a silent dead end: the screen could not
    // complete the registration and no route explained what to do next.
    if (location == '/role-selection') return '/login';
    if (authRoutes.contains(location)) return null;
    return '/login';
  }

  // The session for the current Firebase user is not ready yet. Keeping the
  // current page is safer than guessing a role.
  if (session == null || session.user.uid != user.uid) return null;

  final activeTransition = transition != null && transition.uid == user.uid
      ? transition
      : null;
  final role = activeTransition?.role ?? session.role;
  final profileExists =
      session.hasProfile || activeTransition?.registrationCompleted == true;
  final registrationCompleted =
      session.profile?.registrationCompleted == true ||
      activeTransition?.registrationCompleted == true;
  // A server-confirmed transition is authoritative until the Firestore
  // snapshot catches up. This includes a confirmed **false** phone state:
  // an old snapshot which still says `phoneVerified: true` must not reopen
  // the student or owner service area after a provider was unlinked.
  final phoneVerified =
      activeTransition?.phoneVerified ??
      (session.profile?.phoneVerified == true);

  // A disabled account must not keep using an already-issued Firebase
  // session. The login page itself is allowed so the account can be signed
  // out cleanly.
  if (session.profile != null && !session.profile!.isActive) {
    if (location == '/login') return null;
    return '/login';
  }

  // Signed in but on an auth screen.
  if (authRoutes.contains(location)) {
    // The app is signing the user out: the login screen is exactly where
    // they belong.
    if (signingOut) return null;

    // The one-time-code screen is also used inside an authenticated flow:
    // role selection proves an email/password address with it and the
    // profile screen uses it to add a verified email later.
    if (location == '/verify-otp') return null;

    if (!profileExists || !registrationCompleted) {
      // A signed-in user without a completed profile has to pick a role
      // first. `/role-selection` is itself an auth route, so redirecting to
      // it from itself would create a redirect loop.
      if (location == '/role-selection') return null;
      return '/role-selection';
    }

    // The phone gate applies on every route, including the auth routes.
    // Otherwise a newly registered email/password account could be sent
    // from `/register` straight to the student dashboard before its missing
    // phone had been verified.
    if ((role == UserRole.student || role == UserRole.owner) &&
        !phoneVerified) {
      if (location == '/verify-phone') return null;
      return '/verify-phone';
    }

    if (location == '/phone-auth') {
      // This route is for signing in with a different phone account.
      return homeForRole(role);
    }

    if (location == '/verify-phone') {
      // Administrators do not need a phone. Students and owners may leave
      // this route only after the server copied the verified phone into
      // their profile.
      return homeForRole(role);
    }

    return homeForRole(role);
  }

  // An account without a profile must finish role selection before it can
  // use any service.
  if (!profileExists) return '/role-selection';

  // An incomplete account must finish role selection before it can use any
  // service.
  if (!registrationCompleted) return '/role-selection';

  // A verified phone is mandatory for the student and owner service areas.
  if ((role == UserRole.student || role == UserRole.owner) && !phoneVerified) {
    return '/verify-phone';
  }

  // Signed in: keep the user inside the area that matches their role.
  if (!_roleMatchesArea(role, location)) return homeForRole(role);

  return null;
}

/// The landing route for a given role.
String homeForRole(UserRole? role) {
  switch (role) {
    case UserRole.admin:
      return '/admin/dashboard';
    case UserRole.owner:
      return '/owner/dashboard';
    case UserRole.student:
      return '/student/home';
    default:
      return '/student/home';
  }
}

/// Whether [location] belongs to the area a user with [role] may access.
///
/// Admins may browse every area. Students and owners are restricted to their
/// own area, while shared routes (rooms, chat, invoices, notifications) are
/// open to everyone.
bool _roleMatchesArea(UserRole? role, String location) {
  if (role == UserRole.admin) return true;

  if (location.startsWith('/student')) {
    return role == UserRole.student;
  }
  if (location.startsWith('/owner')) {
    return role == UserRole.owner;
  }
  if (location.startsWith('/admin')) {
    return false;
  }
  return true;
}

/// Notifies the router that the session changed so it can re-evaluate its
/// redirect rules without being torn down and rebuilt.
class _RouterRefreshNotifier extends ChangeNotifier {
  void refresh() => notifyListeners();
}

class StudentShell extends ConsumerWidget {
  final Widget child;

  /// The location of the screen inside the shell.
  final String location;

  const StudentShell({required this.child, required this.location, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return BackToDashboard(
      location: location,
      dashboard: kStudentNavItems.first.route,
      sections: kStudentSections,
      child: Scaffold(
        body: child,
        bottomNavigationBar: _StudentBottomNav(
          currentRoute: GoRouterState.of(context).matchedLocation,
        ),
      ),
    );
  }
}

/// The **sections** of the student area.
///
/// The tabs of the bottom navigation plus the requests — the requests are
/// opened from the home screen, so they are a section of the area as well
/// and the back button has to lead to the dashboard from there too.
final List<String> kStudentSections = [
  for (final item in kStudentNavItems) item.route,
  '/student/requests',
];

/// The tabs of the student area.
///
/// The list is used by the bottom navigation **and** by the back button, so
/// the two can never get out of sync.
const List<NavItem> kStudentNavItems = [
  NavItem('/student/home', Icons.home_outlined, Icons.home, 'Home'),
  NavItem('/student/search', Icons.search_outlined, Icons.search, 'Search'),
  NavItem('/student/saved', Icons.bookmark_outline, Icons.bookmark, 'Saved'),
  NavItem(
    '/student/joined-rooms',
    Icons.assignment_outlined,
    Icons.assignment,
    'Joined',
  ),
  NavItem('/student/profile', Icons.person_outline, Icons.person, 'Profile'),
];

class _StudentBottomNav extends StatelessWidget {
  final String currentRoute;
  const _StudentBottomNav({required this.currentRoute});

  @override
  Widget build(BuildContext context) {
    final items = kStudentNavItems;

    return NavigationBar(
      // The index has to be a real one: a route that is **not** a tab (the
      // requests of the student) used to give `-1`, and the `NavigationBar`
      // threw an assertion — the whole screen went down with it.
      selectedIndex: _navIndex(items, currentRoute),
      onDestinationSelected: (index) => context.go(items[index].route),
      destinations: items
          .map(
            (item) => NavigationDestination(
              icon: Icon(item.iconOut),
              selectedIcon: Icon(item.iconIn),
              label: item.label,
            ),
          )
          .toList(),
    );
  }
}

class NavItem {
  final String route;
  final IconData iconOut;
  final IconData iconIn;
  final String label;
  const NavItem(this.route, this.iconOut, this.iconIn, this.label);
}

/// The index of the tab that belongs to [route].
///
/// A route that belongs to no tab (the requests of the student) falls back
/// to the first tab — `NavigationBar` asserts that the index is inside the
/// list of the destinations, and an index of `-1` crashed the screen.
int _navIndex(List<NavItem> items, String route) {
  final index = items.indexWhere((item) => route.startsWith(item.route));
  return index < 0 ? 0 : index;
}

class OwnerShell extends ConsumerWidget {
  final Widget child;

  /// The location of the screen inside the shell.
  final String location;

  const OwnerShell({required this.child, required this.location, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return BackToDashboard(
      location: location,
      dashboard: kOwnerNavItems.first.route,
      sections: kOwnerSections,
      child: Scaffold(
        body: child,
        bottomNavigationBar: _OwnerBottomNav(
          currentRoute: GoRouterState.of(context).matchedLocation,
        ),
      ),
    );
  }
}

/// The **sections** of the owner area.
final List<String> kOwnerSections = [
  for (final item in kOwnerNavItems) item.route,
];

/// The tabs of the owner area.
const List<NavItem> kOwnerNavItems = [
  NavItem(
    '/owner/dashboard',
    Icons.dashboard_outlined,
    Icons.dashboard,
    'Dashboard',
  ),
  NavItem(
    '/owner/rooms',
    Icons.apartment_outlined,
    Icons.apartment,
    'My Rooms',
  ),
  NavItem('/owner/requests', Icons.mail_outline, Icons.mail, 'Requests'),
  NavItem('/owner/invoices', Icons.receipt_outlined, Icons.receipt, 'Invoices'),
  NavItem('/owner/profile', Icons.person_outline, Icons.person, 'Profile'),
];

class _OwnerBottomNav extends StatelessWidget {
  final String currentRoute;
  const _OwnerBottomNav({required this.currentRoute});

  @override
  Widget build(BuildContext context) {
    final items = kOwnerNavItems;

    return NavigationBar(
      // The index has to be a real one: a route that is **not** a tab (the
      // requests of the student) used to give `-1`, and the `NavigationBar`
      // threw an assertion — the whole screen went down with it.
      selectedIndex: _navIndex(items, currentRoute),
      onDestinationSelected: (index) => context.go(items[index].route),
      destinations: items
          .map(
            (item) => NavigationDestination(
              icon: Icon(item.iconOut),
              selectedIcon: Icon(item.iconIn),
              label: item.label,
            ),
          )
          .toList(),
    );
  }
}

class AdminShell extends ConsumerWidget {
  final Widget child;

  /// The location of the screen inside the shell.
  final String location;

  const AdminShell({required this.child, required this.location, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // On a phone the navigation lives in the drawer of every admin screen
    // (see `AdminScaffold`) — a vertical rail with nine destinations squeezed
    // the content into a third of the width and made the whole admin area
    // look broken. From a tablet on, the rail takes over.
    final isWide = MediaQuery.of(context).size.width >= 900;

    final content = isWide
        ? Row(
            children: [
              AdminNavigationRail(location: location),
              const VerticalDivider(thickness: 1, width: 1),
              Expanded(child: child),
            ],
          )
        : child;

    return BackToDashboard(
      location: location,
      // Every screen of the admin area is a section: the back button on
      // "Payments" (or on any other entry of the drawer) leads back to the
      // admin dashboard.
      dashboard: kAdminDestinations.first.route,
      sections: kAdminSections,
      child: content,
    );
  }
}

/// The **sections** of the admin area — every entry of the drawer.
final List<String> kAdminSections = [
  for (final destination in kAdminDestinations) destination.route,
];
