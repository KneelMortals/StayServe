import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The pages of the sign-in flow.
///
/// They are **not** part of the history of the app:
///
///  * the back button on the dashboard must not lead to the login screen —
///    the router would only bounce the user back to the dashboard,
///  * the pages of the old session must not stay in the history when
///    somebody signs in again.
///
/// The history therefore starts from scratch as soon as the user leaves the
/// sign-in flow.
const Set<String> kAuthLocations = {
  '/login',
  '/register',
  '/forgot-password',
  '/role-selection',
  '/verify-otp',
};

/// The pages the user visited, in the order they visited them.
///
/// ## Why the app needs this
///
/// The navigation of StayServe uses `context.go(...)`, which **replaces**
/// the navigation stack instead of pushing onto it. That is the right thing
/// for a bottom navigation bar — the tabs should not pile up — but it means
/// the router has no history: there is nothing for the system back button
/// to pop, and the app closed instead.
///
/// The history is kept here so the back button always leads to the page the
/// user came from:
///
///  * student home → search → back lands on the **home**,
///  * a room → the owner screen → back lands on the **room**,
///  * the dashboard of the admin → the payments → back lands on the
///    **dashboard**.
///
/// Only when there is no page to go back to does the back button ask for a
/// second press before the app really closes.
class NavigationHistory {
  /// The pages the user visited — the last one is the current page.
  final List<String> _locations = [];

  /// How many pages are remembered.
  ///
  /// The list is capped so a long session cannot grow it without bound.
  static const int maxEntries = 40;

  /// The pages the user visited.
  List<String> get locations => List.unmodifiable(_locations);

  /// The page the user came from — `null` when there is none.
  String? get previous {
    if (_locations.length < 2) return null;
    return _locations[_locations.length - 2];
  }

  /// Whether there is a page to go back to.
  bool get canGoBack => _locations.length >= 2;

  /// Remembers the page the user is on.
  ///
  /// The same page is never recorded twice.
  ///
  /// Leaving the sign-in flow starts a **new** history: the pages of the
  /// flow (and the pages of the session before it) are dropped, so the
  /// back button on the dashboard can only lead to a page of the app.
  void record(String location) {
    if (_locations.isNotEmpty &&
        kAuthLocations.contains(_locations.last) &&
        !kAuthLocations.contains(location)) {
      _locations.clear();
    }

    if (_locations.isNotEmpty && _locations.last == location) return;

    _locations.add(location);
    while (_locations.length > maxEntries) {
      _locations.removeAt(0);
    }
  }

  /// Goes back one page and returns it.
  ///
  /// Returns `null` when there is nothing to go back to.
  String? back() {
    if (_locations.length < 2) return null;
    _locations.removeLast();
    return _locations.last;
  }

  /// Throws the history away.
  ///
  /// The history is cleared when the user signs in and when they sign out:
  /// the pages of the old session mean nothing to the new one.
  void clear() {
    _locations.clear();
  }

  /// Throws the history away and starts again at [location].
  ///
  /// It is used when the back button leads to the dashboard of the role:
  /// the dashboard becomes the only page of the history, so a second back
  /// press asks to leave the app instead of walking the user back into the
  /// section they came from.
  void resetTo(String location) {
    _locations.clear();
    _locations.add(location);
  }
}

/// The navigation history of the app.
///
/// It lives for as long as the app does — the history is useless as soon
/// as it is thrown away.
final navigationHistoryProvider = Provider<NavigationHistory>((ref) {
  return NavigationHistory();
});
