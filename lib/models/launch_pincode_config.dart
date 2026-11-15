/// The launch-area configuration: in which pincodes StayServe is running.
///
/// The document lives in `publicSettings/launch` so it can be read **before**
/// the user signs in — the splash screen checks it on every start.
class LaunchPincodeConfig {
  /// The pincodes the service runs in (used in `whitelist` mode).
  final List<String> enabledPincodes;

  /// The pincodes the service does **not** run in (used in `blacklist` mode).
  final List<String> disabledPincodes;

  /// Either `whitelist` or `blacklist`.
  final String mode;

  /// Whether an admin has actually saved a configuration.
  ///
  /// This matters a lot: an *unconfigured* app must let everybody in. The
  /// fallback used to be "whitelist with an empty list", which meant that a
  /// fresh install locked **every** user out of the app — there was no way
  /// to get in and switch the launch areas on.
  final bool configured;

  const LaunchPincodeConfig({
    this.enabledPincodes = const [],
    this.disabledPincodes = const [],
    this.mode = 'whitelist',
    this.configured = false,
  });

  factory LaunchPincodeConfig.fromJson(Map<String, dynamic> json) {
    return LaunchPincodeConfig(
      enabledPincodes: _readPincodes(json['enabledPincodes']),
      disabledPincodes: _readPincodes(json['disabledPincodes']),
      mode: json['mode'] == 'blacklist' ? 'blacklist' : 'whitelist',
      // A document that exists counts as a configuration, even when it is
      // (almost) empty — an admin who saved an empty whitelist really does
      // want to close the app down.
      configured: true,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'enabledPincodes': enabledPincodes,
      'disabledPincodes': disabledPincodes,
      'mode': mode,
    };
  }

  LaunchPincodeConfig copyWith({
    List<String>? enabledPincodes,
    List<String>? disabledPincodes,
    String? mode,
    bool? configured,
  }) {
    return LaunchPincodeConfig(
      enabledPincodes: enabledPincodes ?? this.enabledPincodes,
      disabledPincodes: disabledPincodes ?? this.disabledPincodes,
      mode: mode ?? this.mode,
      configured: configured ?? this.configured,
    );
  }

  /// Whether [pincode] may use the app.
  ///
  /// An unconfigured app allows everybody — see [configured].
  bool allows(String pincode) {
    if (!configured) return true;

    final wanted = normalise(pincode);
    if (wanted.isEmpty) return true;

    if (mode == 'blacklist') {
      return !disabledPincodes.any((p) => normalise(p) == wanted);
    }
    return enabledPincodes.any((p) => normalise(p) == wanted);
  }

  /// Brings a pincode into the canonical form used for the comparison.
  ///
  /// Indian pincodes are six digits, but the values that reach the app come
  /// from three different places (the GPS, the geocoder and the admin's
  /// text field), so they are stripped of spaces, dashes and a leading zero
  /// difference before they are compared.
  static String normalise(String? pincode) {
    if (pincode == null) return '';
    return pincode.replaceAll(RegExp(r'[^0-9]'), '').trim();
  }

  /// Reads a list of pincodes without ever throwing.
  ///
  /// The old code did `e as String`, which crashed the whole launch-areas
  /// screen as soon as one entry was not a string.
  static List<String> _readPincodes(dynamic value) {
    if (value is! List) return const [];
    final result = <String>[];
    for (final entry in value) {
      if (entry is String) {
        final trimmed = entry.trim();
        if (trimmed.isNotEmpty) result.add(trimmed);
      } else if (entry is num) {
        result.add(entry.toString());
      }
    }
    return result;
  }
}
