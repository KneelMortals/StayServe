import 'dart:math' as math;

/// Helpers for the distance between two points on the earth.
///
/// The app only ever needs a rough, straight-line distance, so the
/// [Haversine] formula is used — it is accurate enough for city-sized
/// distances and needs nothing but `dart:math`.
class DistanceUtils {
  /// The mean radius of the earth in kilometres.
  static const double earthRadiusKm = 6371.0;

  /// The distance between two coordinates in **kilometres**.
  ///
  /// Returns `null` when either coordinate is missing, so callers can simply
  /// skip the rooms whose position is unknown.
  static double? haversineKm({
    required double? fromLat,
    required double? fromLng,
    required double? toLat,
    required double? toLng,
  }) {
    if (fromLat == null ||
        fromLng == null ||
        toLat == null ||
        toLng == null) {
      return null;
    }
    // A coordinate outside the valid range means the data is broken.
    if (fromLat.abs() > 90 || toLat.abs() > 90) return null;
    if (fromLng.abs() > 180 || toLng.abs() > 180) return null;

    final lat1 = _toRadians(fromLat);
    final lat2 = _toRadians(toLat);
    final deltaLat = _toRadians(toLat - fromLat);
    final deltaLng = _toRadians(toLng - fromLng);

    final a = math.sin(deltaLat / 2) * math.sin(deltaLat / 2) +
        math.cos(lat1) *
            math.cos(lat2) *
            math.sin(deltaLng / 2) *
            math.sin(deltaLng / 2);
    final c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));

    return earthRadiusKm * c;
  }

  /// Formats a distance for the user.
  ///
  /// Anything below a kilometre is shown in metres, everything above is
  /// shown in kilometres with one decimal place.
  static String formatDistance(double? km) {
    if (km == null) return '';
    if (km.isNaN || km.isInfinite) return '';
    if (km < 1) {
      final metres = (km * 1000).round();
      return '$metres m away';
    }
    if (km < 10) {
      return '${km.toStringAsFixed(1)} km away';
    }
    return '${km.round()} km away';
  }

  /// The bare distance without the "away" suffix (used inside chips).
  static String formatDistanceShort(double? km) {
    if (km == null) return '';
    if (km.isNaN || km.isInfinite) return '';
    if (km < 1) {
      return '${(km * 1000).round()} m';
    }
    if (km < 10) {
      return '${km.toStringAsFixed(1)} km';
    }
    return '${km.round()} km';
  }

  static double _toRadians(double degrees) => degrees * math.pi / 180.0;
}
