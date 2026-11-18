/// Helpers for the public/private room-location split.
///
/// The server owns the migration stage (`ROOM_LOCATION_STAGE` in the
/// Functions environment). The Flutter client never decides whether an exact
/// address may be written publicly; it only understands the deliberately
/// coarse `geoCell` which the server publishes.
class RoomLocationPrivacy {
  const RoomLocationPrivacy._();

  /// A deliberately coarse coordinate cell (about one kilometre).
  ///
  /// The exact coordinate is not stored in the public document. The cell is
  /// enough for an approximate distance label and a distance filter.
  static String? geoCell({double? latitude, double? longitude}) {
    if (latitude == null || longitude == null) return null;
    if (!latitude.isFinite || !longitude.isFinite) return null;
    if (latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180) {
      return null;
    }

    final roundedLatitude = _roundAwayFromZero(latitude);
    final roundedLongitude = _roundAwayFromZero(longitude);
    final normalizedLatitude = roundedLatitude == 0 ? 0.0 : roundedLatitude;
    final normalizedLongitude = roundedLongitude == 0 ? 0.0 : roundedLongitude;
    return '${normalizedLatitude.toStringAsFixed(2)},'
        '${normalizedLongitude.toStringAsFixed(2)}';
  }

  /// Rounds one coordinate to the public geocell precision.
  ///
  /// This is used for legacy listings which have not received a `geoCell`
  /// yet. The public room model must never expose the exact coordinate, even
  /// during the compatibility stage of the migration.
  static double? coarseCoordinate(
    double? value, {
    double minimum = -90,
    double maximum = 90,
  }) {
    if (value == null || !value.isFinite) return null;
    if (value < minimum || value > maximum) return null;
    final rounded = _roundAwayFromZero(value);
    return rounded == 0 ? 0.0 : rounded;
  }

  /// Rounds to two decimals, away from zero on an exact tie.
  ///
  /// The epsilon compensates for values such as `1.005 * 100`, which is
  /// slightly below 100.5 in binary floating point. The backend uses the
  /// same rule, so a legacy coordinate always maps to the same geocell.
  static double _roundAwayFromZero(double value) {
    final magnitude = value.abs();
    final scaled = magnitude * 100;
    final rounded = (scaled + 0.5 + 1e-9).floorToDouble() / 100;
    return value.isNegative ? -rounded : rounded;
  }

  /// The centre of a coarse coordinate cell.
  static ({double latitude, double longitude})? parseGeoCell(String? value) {
    if (value == null) return null;
    final parts = value.split(',');
    if (parts.length != 2) return null;
    final latitude = double.tryParse(parts[0]);
    final longitude = double.tryParse(parts[1]);
    if (latitude == null || longitude == null) return null;
    if (!latitude.isFinite || !longitude.isFinite) return null;
    if (latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180) {
      return null;
    }
    return (latitude: latitude, longitude: longitude);
  }
}
