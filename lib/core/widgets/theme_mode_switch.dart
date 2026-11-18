import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../theme/theme_controller.dart';

/// The light/dark switch in the profile section.
///
/// The choice is stored on the device, so it survives a restart.
class ThemeModeSwitch extends ConsumerWidget {
  const ThemeModeSwitch({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = ref.watch(themeModeProvider);
    final platformIsDark =
        MediaQuery.platformBrightnessOf(context) == Brightness.dark;

    // `system` follows the phone's setting, so the switch has to show what
    // the user actually sees right now.
    final isDark = mode == ThemeMode.dark ||
        (mode == ThemeMode.system && platformIsDark);

    return SwitchListTile.adaptive(
      secondary: Icon(isDark ? Icons.dark_mode : Icons.light_mode),
      title: const Text('Dark mode'),
      subtitle: Text(
        isDark
            ? 'The app uses the dark theme'
            : 'The app uses the light theme',
      ),
      value: isDark,
      onChanged: (value) {
        ref
            .read(themeModeProvider.notifier)
            .setMode(value ? ThemeMode.dark : ThemeMode.light);
      },
    );
  }
}

/// A compact version of the switch for the app bar.
class ThemeModeButton extends ConsumerWidget {
  const ThemeModeButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = ref.watch(themeModeProvider);
    final platformIsDark =
        MediaQuery.platformBrightnessOf(context) == Brightness.dark;
    final isDark = mode == ThemeMode.dark ||
        (mode == ThemeMode.system && platformIsDark);

    return IconButton(
      tooltip: isDark ? 'Switch to the light theme' : 'Switch to the dark theme',
      icon: Icon(isDark ? Icons.light_mode : Icons.dark_mode),
      onPressed: () {
        ref
            .read(themeModeProvider.notifier)
            .setMode(isDark ? ThemeMode.light : ThemeMode.dark);
      },
    );
  }
}
