import 'dart:async';
import 'dart:convert';

import 'package:geolocator/geolocator.dart';
import 'package:geocoding/geocoding.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/utils/app_logger.dart';

final locationServiceProvider = Provider<LocationService>((ref) => LocationService());

/// The place the device is currently in.
///
/// This is what the app uses for
///
///  * the launch-area check ("is StayServe running in your area?"),
///  * the distance between the user and every room.
class UserLocation {
  final double latitude;
  final double longitude;
  final String? pincode;
  final String? address;
  final String? city;
  final String? state;
  final DateTime updatedAt;

  const UserLocation({
    required this.latitude,
    required this.longitude,
    this.pincode,
    this.address,
    this.city,
    this.state,
    required this.updatedAt,
  });

  /// A short description of the place, used in the UI.
  String get label {
    final parts = <String>[
      if (address != null && address!.trim().isNotEmpty) address!.trim(),
      if (city != null && city!.trim().isNotEmpty) city!.trim(),
      if (pincode != null && pincode!.trim().isNotEmpty) pincode!.trim(),
    ];
    return parts.join(', ');
  }

  Map<String, dynamic> toJson() => {
        'latitude': latitude,
        'longitude': longitude,
        'pincode': pincode,
        'address': address,
        'city': city,
        'state': state,
        'updatedAt': updatedAt.toIso8601String(),
      };

  factory UserLocation.fromJson(Map<String, dynamic> json) {
    return UserLocation(
      latitude: (json['latitude'] as num?)?.toDouble() ?? 0,
      longitude: (json['longitude'] as num?)?.toDouble() ?? 0,
      pincode: json['pincode'] as String?,
      address: json['address'] as String?,
      city: json['city'] as String?,
      state: json['state'] as String?,
      updatedAt: DateTime.tryParse(json['updatedAt'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
    );
  }
}

class LocationService {
  static const String _pincodeKey = 'user_pincode';
  static const String _locationPermissionAskedKey = 'location_permission_asked';
  static const String _lastLocationKey = 'last_known_location';

  /// How long the whole "where am I?" flow may take.
  ///
  /// The splash screen waits for this, so it must always end — even when
  /// the device has no GPS fix, no network or a broken DNS server.
  ///
  /// The budget covers the fresh GPS fix (10 s), the fallback to the last
  /// known position and the reverse geocoding (8 s), so it has to be a
  /// little larger than the sum of those two.
  static const Duration overallTimeout = Duration(seconds: 25);

  /// How long a single reverse-geocoding call may take.
  ///
  /// `placemarkFromCoordinates` is a **native network call** to the Google
  /// geocoding service. On a device with a slow or broken connection it
  /// hangs for minutes (the Android `Geocoder` has no timeout of its own),
  /// which used to freeze the app on the splash screen forever.
  static const Duration geocodingTimeout = Duration(seconds: 8);

  final Geocoding _geocoding = Geocoding();

  /// Check if location permission has been asked before
  Future<bool> hasAskedForPermission() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getBool(_locationPermissionAskedKey) ?? false;
  }

  /// Mark that we've asked for permission
  Future<void> setPermissionAsked() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_locationPermissionAskedKey, true);
  }

  /// Get stored pincode
  Future<String?> getStoredPincode() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_pincodeKey);
  }

  /// Store pincode
  Future<void> storePincode(String pincode) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_pincodeKey, pincode);
  }

  /// Clear stored pincode
  Future<void> clearPincode() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_pincodeKey);
  }

  /// The last location the app knew about.
  ///
  /// It is cached so the distances in the search results are still shown
  /// when the user denied the location permission (or when the device has no
  /// GPS fix right now).
  Future<UserLocation?> getLastKnownLocation() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_lastLocationKey);
      if (raw == null || raw.isEmpty) return null;
      return UserLocation.fromJson(_decodeJson(raw));
    } catch (e) {
      AppLogger.warning('Could not read the cached location', error: e);
      return null;
    }
  }

  /// Caches [location] so it survives an app restart.
  Future<void> cacheLocation(UserLocation location) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_lastLocationKey, _encodeJson(location.toJson()));
    } catch (e) {
      AppLogger.warning('Could not cache the location', error: e);
    }
  }

  /// Request location permission and get current position
  ///
  /// A fresh fix is the best answer, but it is not always available: the
  /// GPS needs a clear view of the sky, and a device that is indoors or
  /// that just woke up may not produce one for a long time. When the fresh
  /// fix times out, the **last known** position is used instead — it is
  /// usually only a few minutes old and good enough to work out the
  /// pincode. Without this fallback the launch-area check failed with
  /// "the location could not be determined" even though the app knew
  /// perfectly well where the device was.
  Future<Position?> getCurrentPosition() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      return null;
    }

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        return null;
      }
    }

    if (permission == LocationPermission.deniedForever) {
      return null;
    }

    try {
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );
    } catch (e) {
      AppLogger.warning(
        'The current position could not be determined — falling back to the '
        'last known position',
        error: e,
      );
      return _lastKnownPosition();
    }
  }

  /// The last position the system knew about, if it is not ancient.
  ///
  /// A fix that is older than [maxAge] is ignored: it would put the user in
  /// the wrong launch area, which is worse than asking them to try again.
  static const Duration maxAge = Duration(hours: 2);

  /// The last known position, or `null` when there is none (or it is too
  /// old to be trusted).
  Future<Position?> _lastKnownPosition() async {
    try {
      final position = await Geolocator.getLastKnownPosition();
      if (position == null) return null;

      final age = DateTime.now().difference(position.timestamp);
      if (age > maxAge || age.isNegative) {
        AppLogger.warning(
          'The last known position is too old (${age.inMinutes} minutes) — '
          'ignoring it',
        );
        return null;
      }

      AppLogger.info(
        'Using the last known position from ${age.inMinutes} minute(s) ago',
      );
      return position;
    } catch (e) {
      AppLogger.warning('Could not read the last known position', error: e);
      return null;
    }
  }

  /// Whether the location permission has been denied *permanently*.
  ///
  /// In that case the system dialog is not shown again — the user has to
  /// enable the permission in the system settings, so the app offers a
  /// shortcut to them.
  Future<bool> isPermissionDeniedForever() async {
    try {
      return await Geolocator.checkPermission() ==
          LocationPermission.deniedForever;
    } catch (_) {
      return false;
    }
  }

  /// Opens the system settings page of the app.
  Future<bool> openAppSettings() async {
    try {
      return await Geolocator.openAppSettings();
    } catch (e) {
      AppLogger.warning('Could not open the app settings', error: e);
      return false;
    }
  }

  /// Opens the system location settings.
  Future<bool> openLocationSettings() async {
    try {
      return await Geolocator.openLocationSettings();
    } catch (e) {
      AppLogger.warning('Could not open the location settings', error: e);
      return false;
    }
  }

  /// Get pincode from coordinates using reverse geocoding
  Future<String?> getPincodeFromPosition(Position position) async {
    try {
      // The timeout is essential — see [geocodingTimeout].
      final placemarks = await _geocoding
          .placemarkFromCoordinates(
            position.latitude,
            position.longitude,
          )
          .timeout(geocodingTimeout);

      if (placemarks.isNotEmpty) {
        final place = placemarks.first;
        // Indian pincode is typically in postalCode or subAdministrativeArea
        return place.postalCode ?? place.subAdministrativeArea;
      }
    } on TimeoutException {
      AppLogger.warning('Geocoding timed out', error: null);
    } catch (e) {
      AppLogger.warning('Geocoding error', error: e);
    }
    return null;
  }

  /// Get pincode from address string (fallback)
  Future<String?> getPincodeFromAddress(String address) async {
    try {
      final locations = await _geocoding
          .locationFromAddress(address)
          .timeout(geocodingTimeout);
      if (locations.isNotEmpty) {
        final placemarks = await _geocoding
            .placemarkFromCoordinates(
              locations.first.latitude,
              locations.first.longitude,
            )
            .timeout(geocodingTimeout);
        if (placemarks.isNotEmpty) {
          return placemarks.first.postalCode;
        }
      }
    } on TimeoutException {
      AppLogger.warning('Address geocoding timed out', error: null);
    } catch (e) {
      AppLogger.warning('Address geocoding error', error: e);
    }
    return null;
  }

  /// Resolves the coordinates into a human readable place.
  ///
  /// Used by the "use my current location" button in the room form: the
  /// owner picks their location and the address, city, state and pincode are
  /// filled in for them.
  Future<Placemark?> reverseGeocode(double latitude, double longitude) async {
    try {
      final placemarks = await _geocoding
          .placemarkFromCoordinates(latitude, longitude)
          .timeout(geocodingTimeout);
      return placemarks.isEmpty ? null : placemarks.first;
    } on TimeoutException {
      AppLogger.warning('Reverse geocoding timed out', error: null);
    } catch (e) {
      AppLogger.warning('Reverse geocoding failed', error: e);
    }
    return null;
  }

  /// Resolves a pincode into coordinates.
  ///
  /// This is what the **manual pincode** entry needs.
  ///
  /// Without it the app kept the raw GPS position even though the user had
  /// told it — by typing the pincode — that they live somewhere else. Every
  /// distance was then calculated from the wrong place, which is how a room
  /// in the same pincode could show up as "13822 km away".
  ///
  /// The lookup is wrapped in the same timeout as every other geocoding
  /// call: on a device with a slow or broken connection the call would
  /// otherwise hang for minutes.
  ///
  /// Returns `null` when the pincode could not be resolved — the caller
  /// then simply keeps the position it already had.
  Future<UserLocation?> resolvePincodeLocation(String pincode) async {
    final clean = pincode.trim();
    if (clean.isEmpty) return null;

    try {
      final locations = await _geocoding
          .locationFromAddress('$clean, India')
          .timeout(geocodingTimeout);

      if (locations.isEmpty) {
        AppLogger.warning('The pincode $clean could not be resolved');
        return null;
      }

      final point = locations.first;

      // The placemark is a nice-to-have: it fills in the city and the
      // state. A failure here must not throw the coordinates away.
      String? address;
      String? city;
      String? state;
      try {
        final placemarks = await _geocoding
            .placemarkFromCoordinates(point.latitude, point.longitude)
            .timeout(geocodingTimeout);
        if (placemarks.isNotEmpty) {
          final place = placemarks.first;
          address = _firstNonEmpty([
            place.street,
            place.subLocality,
            place.locality,
          ]);
          city = _firstNonEmpty([
            place.locality,
            place.subAdministrativeArea,
            place.administrativeArea,
          ]);
          state = _firstNonEmpty([
            place.administrativeArea,
            place.subAdministrativeArea,
          ]);
        }
      } catch (e) {
        AppLogger.warning('Could not read the place of $clean', error: e);
      }

      final location = UserLocation(
        latitude: point.latitude,
        longitude: point.longitude,
        pincode: clean,
        address: address,
        city: city,
        state: state,
        updatedAt: DateTime.now(),
      );

      await cacheLocation(location);
      return location;
    } on TimeoutException {
      AppLogger.warning('The pincode lookup of $clean timed out', error: null);
      return null;
    } catch (e) {
      AppLogger.warning('The pincode lookup of $clean failed', error: e);
      return null;
    }
  }

  /// Full flow: get permission -> get location -> get pincode -> store
  ///
  /// The whole flow is wrapped in a timeout. The splash screen waits for
  /// this future — without the timeout a device without a GPS fix or
  /// without a working network would leave the user staring at the splash
  /// screen forever, with no way into the app.
  Future<LocationResult> getUserPincode() async {
    final hasAsked = await hasAskedForPermission();

    if (!hasAsked) {
      await setPermissionAsked();
    }

    try {
      return await _resolvePincode().timeout(overallTimeout);
    } on TimeoutException {
      AppLogger.warning('The location lookup timed out', error: null);
      return LocationResult(
        success: false,
        pincode: null,
        error: 'Unable to get location. Please enable location services.',
      );
    } catch (e) {
      AppLogger.warning('The location lookup failed', error: e);
      return LocationResult(
        success: false,
        pincode: null,
        error: 'Unable to get location. Please enable location services.',
      );
    }
  }

  /// The full location lookup, including the coordinates and the address.
  ///
  /// This is what the splash screen uses: it needs the pincode for the
  /// launch-area check **and** the coordinates for the distance calculation.
  Future<UserLocationResult> getUserLocation() async {
    final hasAsked = await hasAskedForPermission();

    if (!hasAsked) {
      await setPermissionAsked();
    }

    try {
      return await _resolveLocation().timeout(overallTimeout);
    } on TimeoutException {
      AppLogger.warning('The location lookup timed out', error: null);
      return UserLocationResult(
        success: false,
        error: 'Unable to get location. Please enable location services.',
      );
    } catch (e) {
      AppLogger.warning('The location lookup failed', error: e);
      return UserLocationResult(
        success: false,
        error: 'Unable to get location. Please enable location services.',
      );
    }
  }

  Future<LocationResult> _resolvePincode() async {
    final position = await getCurrentPosition();
    if (position == null) {
      return LocationResult(
        success: false,
        pincode: null,
        error: 'Unable to get location. Please enable location services.',
      );
    }

    final pincode = await getPincodeFromPosition(position);
    if (pincode == null || pincode.isEmpty) {
      return LocationResult(
        success: false,
        pincode: null,
        error: 'Could not determine your area. Please try again.',
      );
    }

    await storePincode(pincode);
    return LocationResult(success: true, pincode: pincode);
  }

  Future<UserLocationResult> _resolveLocation() async {
    final position = await getCurrentPosition();
    if (position == null) {
      return UserLocationResult(
        success: false,
        error: 'Unable to get location. Please enable location services.',
      );
    }

    final placemark = await reverseGeocode(position.latitude, position.longitude);

    final pincode = _firstNonEmpty([
      placemark?.postalCode,
      placemark?.subAdministrativeArea,
    ]);
    final address = _firstNonEmpty([
      placemark?.street,
      placemark?.subLocality,
      placemark?.locality,
      placemark?.administrativeArea,
    ]);
    final city = _firstNonEmpty([
      placemark?.locality,
      placemark?.subAdministrativeArea,
      placemark?.administrativeArea,
    ]);
    final state = _firstNonEmpty([
      placemark?.administrativeArea,
      placemark?.subAdministrativeArea,
    ]);

    final location = UserLocation(
      latitude: position.latitude,
      longitude: position.longitude,
      pincode: pincode,
      address: address,
      city: city,
      state: state,
      updatedAt: DateTime.now(),
    );

    await cacheLocation(location);
    if (pincode != null) {
      await storePincode(pincode);
    }

    return UserLocationResult(
      success: true,
      location: location,
      pincode: pincode,
    );
  }

  /// The first of [values] that is not null and not blank.
  static String? _firstNonEmpty(List<String?> values) {
    for (final value in values) {
      if (value != null && value.trim().isNotEmpty) return value.trim();
    }
    return null;
  }

  /// The cached location is stored as a JSON string.
  static String _encodeJson(Map<String, dynamic> json) => jsonEncode(json);

  static Map<String, dynamic> _decodeJson(String raw) =>
      (jsonDecode(raw) as Map).cast<String, dynamic>();
}

/// The outcome of a pincode lookup.
class LocationResult {
  final bool success;
  final String? pincode;
  final String? error;

  LocationResult({
    required this.success,
    this.pincode,
    this.error,
  });
}

/// The outcome of a full location lookup.
class UserLocationResult {
  final bool success;
  final UserLocation? location;
  final String? pincode;
  final String? error;

  UserLocationResult({
    required this.success,
    this.location,
    this.pincode,
    this.error,
  });
}
