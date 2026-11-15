import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'location_service.dart';

export 'location_service.dart' show UserLocation;

/// The location of the user, known to the whole app.
///
/// The splash screen fills it in when the app starts; the search screen and
/// the room cards read it to show how far away a room is.
final userLocationProvider =
    NotifierProvider<UserLocationNotifier, UserLocation?>(
  UserLocationNotifier.new,
);

/// Holds the user's current location and keeps it up to date.
class UserLocationNotifier extends Notifier<UserLocation?> {
  @override
  UserLocation? build() {
    // The cached location is restored in the background so the distances are
    // available immediately — even before the GPS has a fix.
    _restoreCachedLocation();
    return null;
  }

  /// Sets the location (and caches it).
  void setLocation(UserLocation location) {
    state = location;
    // The cache is a nice-to-have: a device that cannot write it (no
    // permission, a full disk) must not break the app.
    try {
      ref.read(locationServiceProvider).cacheLocation(location);
    } catch (_) {
      // Ignore — the location is already in the state.
    }
  }

  /// Forgets the current location.
  void clear() {
    state = null;
  }

  /// Asks the device where we are and stores the answer.
  ///
  /// Returns the resolved location, or `null` when the lookup failed.
  ///
  /// The lookup can fail for many reasons — the permission was refused,
  /// the GPS is switched off, the device has no location service, the
  /// geocoding plugin is not available. **None of them may crash the
  /// screen** that asked for the location: the "Update" button of the
  /// search screen called this directly, and the error escaped into the
  /// framework and showed the red error screen.
  Future<UserLocation?> refresh() async {
    try {
      final result = await ref.read(locationServiceProvider).getUserLocation();
      if (result.success && result.location != null) {
        state = result.location;
      }
      return result.location;
    } catch (_) {
      // The location stays as it was.
      return null;
    }
  }

  Future<void> _restoreCachedLocation() async {
    try {
      final cached =
          await ref.read(locationServiceProvider).getLastKnownLocation();
      if (cached == null) return;
      // A newer location must not be overwritten by the cached one.
      if (state == null ||
          state!.updatedAt.isBefore(cached.updatedAt)) {
        state = cached;
      }
    } catch (_) {
      // A missing cache is not an error.
    }
  }
}
