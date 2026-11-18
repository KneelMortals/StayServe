import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The key the selected theme mode is stored under.
const String kThemeModePreferenceKey = 'app_theme_mode';

/// The theme mode of the app.
///
/// The value is persisted in [SharedPreferences], so the choice survives a
/// restart. It is read **before** the first frame (see `main.dart`) and
/// injected into the provider, so the app never flashes the wrong theme.
final themeModeProvider =
    NotifierProvider<ThemeModeController, ThemeMode>(ThemeModeController.new);

/// Holds (and persists) the selected [ThemeMode].
class ThemeModeController extends Notifier<ThemeMode> {
  ThemeModeController([ThemeMode initialMode = ThemeMode.system])
      : _initialMode = initialMode;

  final ThemeMode _initialMode;

  @override
  ThemeMode build() => _initialMode;

  /// Switches to [mode] and remembers it.
  Future<void> setMode(ThemeMode mode) async {
    if (mode == state) return;
    state = mode;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(kThemeModePreferenceKey, mode.name);
    } catch (_) {
      // Persisting the preference is a nice-to-have — a failure must not
      // break the switch itself.
    }
  }

  /// Flips between the light and the dark theme.
  Future<void> toggleDarkMode({required bool currentlyDark}) async {
    await setMode(currentlyDark ? ThemeMode.light : ThemeMode.dark);
  }

  /// Reads the stored mode.
  ///
  /// Returns [ThemeMode.system] when nothing has been stored yet (or when the
  /// stored value is not one of the known modes).
  static ThemeMode fromStored(String? value) {
    switch (value) {
      case 'light':
        return ThemeMode.light;
      case 'dark':
        return ThemeMode.dark;
      case 'system':
        return ThemeMode.system;
      default:
        return ThemeMode.system;
    }
  }

  /// The stored mode, read straight from [SharedPreferences].
  static Future<ThemeMode> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return fromStored(prefs.getString(kThemeModePreferenceKey));
    } catch (_) {
      return ThemeMode.system;
    }
  }
}
