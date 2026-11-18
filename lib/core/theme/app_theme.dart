import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'theme_controller.dart';

class AppColors {
  static const Color primary = Color(0xFF2E7D32);
  static const Color primaryLight = Color(0xFF4CAF50);
  static const Color primaryDark = Color(0xFF1B5E20);
  static const Color secondary = Color(0xFF1565C0);
  static const Color secondaryLight = Color(0xFF1976D2);
  static const Color secondaryDark = Color(0xFF0D47A1);

  static const Color surface = Color(0xFFFFFFFF);
  static const Color background = Color(0xFFF5F5F5);
  static const Color error = Color(0xFFC62828);
  static const Color errorLight = Color(0xFFEF5350);
  static const Color success = Color(0xFF2E7D32);
  static const Color warning = Color(0xFFF57F17);
  static const Color info = Color(0xFF1565C0);

  static const Color textPrimary = Color(0xFF212121);
  static const Color textSecondary = Color(0xFF757575);
  static const Color textDisabled = Color(0xFFBDBDBD);
  static const Color textOnPrimary = Color(0xFFFFFFFF);
  static const Color textOnSecondary = Color(0xFFFFFFFF);
  static const Color textOnSurface = Color(0xFF212121);
  static const Color textOnBackground = Color(0xFF212121);
  static const Color textOnError = Color(0xFFFFFFFF);

  static const Color divider = Color(0xFFE0E0E0);
  static const Color border = Color(0xFFBDBDBD);
  static const Color shadow = Color(0x1A000000);

  static const Color chipBackground = Color(0xFFE8F5E9);
  static const Color chipText = Color(0xFF2E7D32);

  static const Color onlineIndicator = Color(0xFF4CAF50);
  static const Color offlineIndicator = Color(0xFF9E9E9E);

  // ---------------------------------------------------------------------------
  // Dark-mode counterparts
  // ---------------------------------------------------------------------------
  // The light values above are baked into a couple of widgets that predate the
  // theme switch. These dark counterparts let those widgets pick a sensible
  // colour for the current brightness without hard-coding "is it dark?".
  static const Color darkSurface = Color(0xFF121212);
  static const Color darkBackground = Color(0xFF0E0E0E);
  static const Color darkTextPrimary = Color(0xFFE8E8E8);
  static const Color darkTextSecondary = Color(0xFFB0B0B0);
  static const Color darkDivider = Color(0xFF2E2E2E);
}

class AppTextStyles {
  static const TextStyle headlineLarge = TextStyle(
    fontSize: 32,
    fontWeight: FontWeight.w700,
    letterSpacing: -0.5,
    color: AppColors.textPrimary,
  );

  static const TextStyle headlineMedium = TextStyle(
    fontSize: 28,
    fontWeight: FontWeight.w600,
    letterSpacing: -0.25,
    color: AppColors.textPrimary,
  );

  static const TextStyle headlineSmall = TextStyle(
    fontSize: 24,
    fontWeight: FontWeight.w600,
    letterSpacing: 0,
    color: AppColors.textPrimary,
  );

  static const TextStyle titleLarge = TextStyle(
    fontSize: 22,
    fontWeight: FontWeight.w600,
    letterSpacing: 0,
    color: AppColors.textPrimary,
  );

  static const TextStyle titleMedium = TextStyle(
    fontSize: 18,
    fontWeight: FontWeight.w500,
    letterSpacing: 0.15,
    color: AppColors.textPrimary,
  );

  static const TextStyle titleSmall = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.w500,
    letterSpacing: 0.1,
    color: AppColors.textPrimary,
  );

  static const TextStyle bodyLarge = TextStyle(
    fontSize: 16,
    fontWeight: FontWeight.w400,
    letterSpacing: 0.5,
    color: AppColors.textPrimary,
  );

  static const TextStyle bodyMedium = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w400,
    letterSpacing: 0.25,
    color: AppColors.textPrimary,
  );

  static const TextStyle bodySmall = TextStyle(
    fontSize: 12,
    fontWeight: FontWeight.w400,
    letterSpacing: 0.4,
    color: AppColors.textSecondary,
  );

  static const TextStyle labelLarge = TextStyle(
    fontSize: 14,
    fontWeight: FontWeight.w500,
    letterSpacing: 0.1,
    color: AppColors.textPrimary,
  );

  static const TextStyle labelMedium = TextStyle(
    fontSize: 12,
    fontWeight: FontWeight.w500,
    letterSpacing: 0.5,
    color: AppColors.textPrimary,
  );

  static const TextStyle labelSmall = TextStyle(
    fontSize: 11,
    fontWeight: FontWeight.w500,
    letterSpacing: 0.5,
    color: AppColors.textSecondary,
  );
}

class AppSpacing {
  static const double xs = 4.0;
  static const double sm = 8.0;
  static const double md = 16.0;
  static const double lg = 24.0;
  static const double xl = 32.0;
  static const double xxl = 48.0;
}

class AppBorderRadius {
  static const double xs = 4.0;
  static const double sm = 8.0;
  static const double md = 12.0;
  static const double lg = 16.0;
  static const double xl = 24.0;
  static const double full = 9999.0;
}

class AppShadows {
  static const List<BoxShadow> level1 = [
    BoxShadow(
      color: AppColors.shadow,
      offset: Offset(0, 1),
      blurRadius: 3,
      spreadRadius: 0,
    ),
  ];

  static const List<BoxShadow> level2 = [
    BoxShadow(
      color: AppColors.shadow,
      offset: Offset(0, 2),
      blurRadius: 8,
      spreadRadius: 0,
    ),
  ];

  static const List<BoxShadow> level3 = [
    BoxShadow(
      color: AppColors.shadow,
      offset: Offset(0, 4),
      blurRadius: 16,
      spreadRadius: 0,
    ),
  ];
}

/// The colour scheme used in **light** mode.
const ColorScheme _lightScheme = ColorScheme.light(
  primary: AppColors.primary,
  primaryContainer: Color(0xFFC8E6C9),
  onPrimaryContainer: AppColors.primaryDark,
  secondary: AppColors.secondary,
  secondaryContainer: Color(0xFFD1E3FF),
  onSecondaryContainer: AppColors.secondaryDark,
  surface: AppColors.surface,
  onSurface: AppColors.textOnSurface,
  surfaceContainerHighest: Color(0xFFEEEEEE),
  error: AppColors.error,
  onPrimary: AppColors.textOnPrimary,
  onSecondary: AppColors.textOnSecondary,
  onError: AppColors.textOnError,
  outline: AppColors.border,
  outlineVariant: AppColors.divider,
);

/// The colour scheme used in **dark** mode.
///
/// It is derived from the light scheme so the brand colours stay the same —
/// only the surfaces and the text colours are inverted.
const ColorScheme _darkScheme = ColorScheme.dark(
  primary: Color(0xFF81C784),
  primaryContainer: Color(0xFF1B5E20),
  onPrimaryContainer: Color(0xFFC8E6C9),
  secondary: Color(0xFF90CAF9),
  secondaryContainer: Color(0xFF0D47A1),
  onSecondaryContainer: Color(0xFFD1E3FF),
  surface: AppColors.darkSurface,
  onSurface: AppColors.darkTextPrimary,
  surfaceContainerHighest: Color(0xFF2A2A2A),
  error: Color(0xFFEF9A9A),
  onPrimary: Color(0xFF0B3D0E),
  onSecondary: Color(0xFF00325A),
  onError: Color(0xFF3B0909),
  outline: Color(0xFF8E8E8E),
  outlineVariant: AppColors.darkDivider,
);

/// Builds the text theme for the given [scheme].
///
/// The old theme used [AppTextStyles] directly, and every one of those
/// styles hard-codes the **light** foreground colour (`#212121`). In dark
/// mode that produced dark-grey text on a near-black background — practically
/// unreadable. The styles are now re-coloured from the scheme instead.
TextTheme _buildTextTheme(ColorScheme scheme) {
  TextStyle style(TextStyle base, Color color) => base.copyWith(color: color);

  return TextTheme(
    displayLarge: style(AppTextStyles.headlineLarge, scheme.onSurface),
    displayMedium: style(AppTextStyles.headlineMedium, scheme.onSurface),
    displaySmall: style(AppTextStyles.headlineSmall, scheme.onSurface),
    headlineLarge: style(AppTextStyles.headlineLarge, scheme.onSurface),
    headlineMedium: style(AppTextStyles.headlineMedium, scheme.onSurface),
    headlineSmall: style(AppTextStyles.headlineSmall, scheme.onSurface),
    titleLarge: style(AppTextStyles.titleLarge, scheme.onSurface),
    titleMedium: style(AppTextStyles.titleMedium, scheme.onSurface),
    titleSmall: style(AppTextStyles.titleSmall, scheme.onSurface),
    bodyLarge: style(AppTextStyles.bodyLarge, scheme.onSurface),
    bodyMedium: style(AppTextStyles.bodyMedium, scheme.onSurface),
    bodySmall: style(
      AppTextStyles.bodySmall,
      scheme.onSurface.withValues(alpha: 0.75),
    ),
    labelLarge: style(AppTextStyles.labelLarge, scheme.onSurface),
    labelMedium: style(AppTextStyles.labelMedium, scheme.onSurface),
    labelSmall: style(
      AppTextStyles.labelSmall,
      scheme.onSurface.withValues(alpha: 0.75),
    ),
  );
}

/// Builds the complete [ThemeData] for the given [brightness].
ThemeData buildAppTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  final scheme = isDark ? _darkScheme : _lightScheme;
  final textTheme = _buildTextTheme(scheme);

  final onSurfaceVariant = scheme.onSurface.withValues(alpha: 0.75);

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor:
        isDark ? AppColors.darkBackground : AppColors.background,
    appBarTheme: AppBarTheme(
      elevation: 0,
      backgroundColor: scheme.surface,
      foregroundColor: scheme.onSurface,
      titleTextStyle: textTheme.titleLarge,
      centerTitle: false,
      surfaceTintColor: Colors.transparent,
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      color: scheme.surface,
      shadowColor: AppColors.shadow,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.lg),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      margin: const EdgeInsets.all(AppSpacing.sm),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        elevation: 0,
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
        disabledBackgroundColor: scheme.onSurface.withValues(alpha: 0.12),
        disabledForegroundColor: scheme.onSurface.withValues(alpha: 0.38),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.md,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppBorderRadius.md),
        ),
        textStyle: textTheme.labelLarge,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: scheme.primary,
        disabledForegroundColor: scheme.onSurface.withValues(alpha: 0.38),
        side: BorderSide(color: scheme.primary, width: 1.5),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.lg,
          vertical: AppSpacing.md,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppBorderRadius.md),
        ),
        textStyle: textTheme.labelLarge,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: scheme.primary,
        disabledForegroundColor: scheme.onSurface.withValues(alpha: 0.38),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.sm,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppBorderRadius.md),
        ),
        textStyle: textTheme.labelLarge,
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: scheme.surface,
      contentPadding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.md,
        vertical: AppSpacing.md,
      ),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
        borderSide: BorderSide(color: scheme.outline),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
        borderSide: BorderSide(color: scheme.outline),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
        borderSide: BorderSide(color: scheme.primary, width: 2),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
        borderSide: BorderSide(color: scheme.error),
      ),
      focusedErrorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
        borderSide: BorderSide(color: scheme.error, width: 2),
      ),
      disabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
        borderSide: BorderSide(color: scheme.outlineVariant),
      ),
      labelStyle: textTheme.bodyMedium?.copyWith(color: onSurfaceVariant),
      hintStyle: textTheme.bodyMedium?.copyWith(
        color: scheme.onSurface.withValues(alpha: 0.38),
      ),
      errorStyle: textTheme.bodySmall?.copyWith(color: scheme.error),
      floatingLabelStyle: textTheme.bodySmall?.copyWith(color: scheme.primary),
      prefixIconColor: onSurfaceVariant,
      suffixIconColor: onSurfaceVariant,
    ),
    chipTheme: ChipThemeData(
      backgroundColor: scheme.surfaceContainerHighest,
      selectedColor: scheme.primaryContainer,
      disabledColor: scheme.outlineVariant,
      labelStyle: textTheme.labelMedium?.copyWith(color: scheme.onSurface),
      secondaryLabelStyle: textTheme.labelMedium?.copyWith(color: scheme.onSurface),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.full),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      brightness: brightness,
    ),
    bottomNavigationBarTheme: BottomNavigationBarThemeData(
      backgroundColor: scheme.surface,
      selectedItemColor: scheme.primary,
      unselectedItemColor: onSurfaceVariant,
      selectedLabelStyle: textTheme.labelSmall,
      unselectedLabelStyle: textTheme.labelSmall,
      type: BottomNavigationBarType.fixed,
      elevation: 8,
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: scheme.surface,
      indicatorColor: scheme.primary.withValues(alpha: 0.15),
      labelTextStyle: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.selected)) {
          return textTheme.labelSmall?.copyWith(color: scheme.primary);
        }
        return textTheme.labelSmall?.copyWith(color: onSurfaceVariant);
      }),
      iconTheme: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.selected)) {
          return IconThemeData(color: scheme.primary, size: 24);
        }
        return IconThemeData(color: onSurfaceVariant, size: 24);
      }),
      height: 64,
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: scheme.surface,
      elevation: 8,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.xl),
      ),
      titleTextStyle: textTheme.titleLarge,
      contentTextStyle: textTheme.bodyMedium,
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: scheme.surface,
      elevation: 8,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(AppBorderRadius.xl)),
      ),
      modalBackgroundColor: scheme.surface,
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: scheme.inverseSurface,
      contentTextStyle: textTheme.bodyMedium?.copyWith(color: scheme.onInverseSurface),
      actionTextColor: scheme.inversePrimary,
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
      ),
      elevation: 4,
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: scheme.primary,
      foregroundColor: scheme.onPrimary,
      elevation: 4,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(AppBorderRadius.md)),
      ),
    ),
    dividerTheme: DividerThemeData(
      color: scheme.outlineVariant,
      thickness: 1,
      space: 1,
    ),
    listTileTheme: ListTileThemeData(
      contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xs),
      titleTextStyle: textTheme.bodyLarge,
      subtitleTextStyle: textTheme.bodySmall,
      leadingAndTrailingTextStyle: textTheme.bodyMedium,
      iconColor: onSurfaceVariant,
      textColor: scheme.onSurface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
      ),
    ),
    tabBarTheme: TabBarThemeData(
      labelStyle: textTheme.labelLarge,
      unselectedLabelStyle: textTheme.labelLarge,
      labelColor: scheme.primary,
      unselectedLabelColor: onSurfaceVariant,
      indicator: const UnderlineTabIndicator(
        borderSide: BorderSide(width: 3),
        insets: EdgeInsets.symmetric(horizontal: AppSpacing.md),
      ),
      dividerColor: Colors.transparent,
    ),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(
        color: scheme.inverseSurface,
        borderRadius: BorderRadius.circular(AppBorderRadius.sm),
      ),
      textStyle: textTheme.labelSmall?.copyWith(color: scheme.onInverseSurface),
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.selected)) return scheme.onPrimary;
        return scheme.outline;
      }),
      trackColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.selected)) return scheme.primary;
        return scheme.surfaceContainerHighest;
      }),
      trackOutlineColor: WidgetStateProperty.resolveWith((states) {
        if (states.contains(WidgetState.selected)) return scheme.primary;
        return scheme.outline;
      }),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: scheme.primary,
      linearTrackColor: scheme.surfaceContainerHighest,
      circularTrackColor: scheme.surfaceContainerHighest,
    ),
    textTheme: textTheme,
  );
}

final lightThemeProvider = Provider<ThemeData>((ref) {
  return buildAppTheme(Brightness.light);
});

final darkThemeProvider = Provider<ThemeData>((ref) {
  return buildAppTheme(Brightness.dark);
});

/// The theme that matches the currently selected [ThemeMode].
///
/// Kept for screens that want a single theme object; the app itself passes
/// [lightThemeProvider] and [darkThemeProvider] to `MaterialApp.router`
/// together with the theme mode, so the platform can switch by itself.
final themeProvider = Provider<ThemeData>((ref) {
  final mode = ref.watch(themeModeProvider);
  switch (mode) {
    case ThemeMode.dark:
      return ref.watch(darkThemeProvider);
    case ThemeMode.light:
      return ref.watch(lightThemeProvider);
    case ThemeMode.system:
      final platformBrightness =
          WidgetsBinding.instance.platformDispatcher.platformBrightness;
      return platformBrightness == Brightness.dark
          ? ref.watch(darkThemeProvider)
          : ref.watch(lightThemeProvider);
  }
});
