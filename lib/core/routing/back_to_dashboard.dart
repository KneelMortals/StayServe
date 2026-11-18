import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'navigation_history.dart';

/// Makes the **system back button** go back to the page the user came
/// from.
///
/// ## Why this is needed
///
/// The main navigation uses `context.go(...)`, which *replaces* the
/// navigation stack instead of pushing onto it. That is the right thing for
/// a bottom navigation bar — the tabs should not pile up — but it means
/// there is nothing left to pop: the back button on the home screen closed
/// the whole app.
///
/// With this guard the behaviour is:
///
///  * on a **section** screen (a tab of the bottom navigation, an entry of
///    the drawer) the back button leads to the **dashboard** of the role,
///  * on a **detail** screen (a room, a chat, an invoice) it leads to the
///    page the user came from,
///  * on the **dashboard** it asks for a second press and only then closes
///    the app.
///
/// ## Why the app tells the platform that it handles the back button
///
/// A section screen of StayServe lives in **two** navigators:
///
/// ```text
/// root navigator ── [ the page of the shell (the bottom navigation) ]
///                   └── nested navigator ── [ the screen itself ]
/// ```
///
/// Every navigator tells the platform whether *it* can handle the back
/// button (`NavigationNotification.canHandlePop`) and the **last** one
/// that says something wins. The nested navigator is built after the root
/// one, so it overruled the guard of the shell — and said "nobody handles
/// the back button". Android believed it and closed the activity: the back
/// button threw the user out of the app instead of leading to the
/// dashboard.
///
/// The app therefore says so itself (see `_handleNavigationNotification` in
/// `main.dart`): every screen carries a guard that decides what the back
/// button does — including leaving the app.
class BackToPreviousPage extends ConsumerStatefulWidget {
  /// The screen this guard belongs to.
  final Widget child;

  /// The location of the screen, e.g. `/student/requests`.
  ///
  /// It is passed in because the guard sits **above** the route in the
  /// widget tree — the current location cannot be read from the context
  /// there.
  final String location;

  /// Whether the screen belongs to the history.
  ///
  /// The splash screen is the way into the app and is not a page of the
  /// app: going "back" to it would be meaningless, so it is not recorded.
  ///
  /// The **inner** guard of a shell does not record anything either: the
  /// shell above it already did, and the history must not get the same
  /// page twice.
  final bool recordInHistory;

  /// The dashboard of the role — e.g. `/owner/dashboard`.
  ///
  /// When it is given, the back button on a **section** screen (a tab of
  /// the bottom navigation or an entry of the drawer) leads to the
  /// dashboard instead of closing the app.
  ///
  /// It is `null` on the screens that do not belong to a role area — the
  /// room, the chat, the invoice — because there the back button has to
  /// lead to the page the user came from.
  final String? dashboard;

  /// The section screens of the role — the tabs of the bottom navigation
  /// or the entries of the drawer.
  ///
  /// The back button on one of them leads to [dashboard].
  final List<String> sections;

  /// The prefix of the role area — e.g. `/student`.
  ///
  /// Inside the area the back button **never** closes the app: it always
  /// leads to the dashboard of the role. When it is not given it is
  /// derived from [dashboard] (`/student/home` → `/student`).
  final String? areaPrefix;

  const BackToPreviousPage({
    required this.child,
    required this.location,
    this.recordInHistory = true,
    this.dashboard,
    this.sections = const [],
    this.areaPrefix,
    super.key,
  });

  @override
  ConsumerState<BackToPreviousPage> createState() => _BackToPreviousPageState();
}

class _BackToPreviousPageState extends ConsumerState<BackToPreviousPage> {
  /// When the back button was pressed the last time on the dashboard.
  DateTime? _lastBackPress;

  /// How long the user has to press back a second time to leave the app.
  static const Duration exitGrace = Duration(seconds: 2);

  @override
  void initState() {
    super.initState();
    _rememberLocation();
  }

  @override
  void didUpdateWidget(covariant BackToPreviousPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.location != widget.location) {
      _rememberLocation();
    }
  }

  /// Remembers the page the user is on.
  void _rememberLocation() {
    if (!widget.recordInHistory) return;

    ref.read(navigationHistoryProvider).record(widget.location);
  }

  /// The prefix of the role area.
  ///
  /// It is taken from [BackToPreviousPage.areaPrefix] when it is given and
  /// derived from the dashboard otherwise.
  String? get _area {
    final given = widget.areaPrefix;
    if (given != null) return given;

    final dashboard = widget.dashboard;
    if (dashboard == null) return null;

    final index = dashboard.lastIndexOf('/');
    if (index <= 0) return null;
    return dashboard.substring(0, index);
  }

  void _handleBack() {
    final history = ref.read(navigationHistoryProvider);
    final dashboard = widget.dashboard;

    if (dashboard != null) {
      // -------------------------------------------------------------------
      // The **dashboard** — the app may close, but only after a second
      // press.
      // -------------------------------------------------------------------
      if (widget.location == dashboard) {
        _confirmExit();
        return;
      }

      // -------------------------------------------------------------------
      // A **section** screen always leads back to the dashboard.
      //
      // The tabs of the bottom navigation and the entries of the drawer are
      // *sections* of the app, not pages the user "came from": the back
      // button on "My Rooms" has to lead to the dashboard, not to another tab
      // and — when the app was opened straight on that tab — not out of the
      // app.
      // -------------------------------------------------------------------
      if (widget.sections.contains(widget.location)) {
        history.resetTo(dashboard);
        context.go(dashboard);
        return;
      }

      // -------------------------------------------------------------------
      // A **detail** screen of the area (the edit form of the profile, the
      // form that adds a room) leads back to the page the user came from.
      //
      // But the app is **never** closed from inside the area: when there is
      // no page to go back to — or when it belongs to another area — the
      // dashboard is the last stop.
      // -------------------------------------------------------------------
      final previous = history.back();
      final area = _area;
      if (previous != null && (area == null || previous.startsWith(area))) {
        context.go(previous);
        return;
      }
      history.resetTo(dashboard);
      context.go(dashboard);
      return;
    }

    // There is a page the user came from — go there.
    //
    // This is the whole point of the guard: the back button leads to the
    // **previous page**, not out of the app.
    final previous = history.back();
    if (previous != null) {
      context.go(previous);
      return;
    }

    _confirmExit();
  }

  /// Asks the user to press the back button a second time.
  ///
  /// Without this a single stray press threw the user out of the app.
  void _confirmExit() {
    final now = DateTime.now();
    final last = _lastBackPress;
    if (last != null && now.difference(last) < exitGrace) {
      SystemNavigator.pop();
      return;
    }
    _lastBackPress = now;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Press back again to leave StayServe'),
        duration: Duration(seconds: 2),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // The pop is handled by hand — see [_handleBack].
      canPop: false,
      onPopInvokedWithResult: (didPop, result) {
        if (didPop) return;
        _handleBack();
      },
      child: widget.child,
    );
  }
}

/// The old name of the guard.
///
/// It is kept so that the existing call sites keep working.
typedef BackToDashboard = BackToPreviousPage;

/// Tells the platform that the **framework** handles the back button.
///
/// ## Why the app has to say this itself
///
/// Every screen of StayServe carries a guard ([BackToPreviousPage]) that
/// decides what the back button does — including leaving the app. But a
/// section screen lives in **two** navigators: the root one holds the page
/// of the shell (the bottom navigation) and the navigator of the shell
/// holds the screen itself.
///
/// Every navigator tells the platform whether *it* can handle the back
/// button (`NavigationNotification.canHandlePop`) and the **last** one that
/// says something wins. The navigator of the shell is built after the root
/// one, so it overruled the guard of the shell and said "nobody handles the
/// back button". Android believed it, closed the activity and threw the
/// user out of the app — from every section of every area.
///
/// The app decides everything about the back button itself, so the platform
/// is always told that the framework handles it.
bool handleNavigationNotification(NavigationNotification notification) {
  SystemNavigator.setFrameworkHandlesBack(true);
  return true;
}
