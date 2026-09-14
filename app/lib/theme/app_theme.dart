import 'package:flutter/material.dart';

const _lightSeed = Color(0xFF007F82);
const _darkSeed = Color(0xFF67D8D1);

ThemeData _buildTheme(Brightness brightness) {
  final baseScheme = ColorScheme.fromSeed(
    seedColor: brightness == Brightness.dark ? _darkSeed : _lightSeed,
    brightness: brightness,
    contrastLevel: 0.1,
  );
  final isDark = brightness == Brightness.dark;
  final surface = isDark ? const Color(0xFF0D1415) : const Color(0xFFF6F9F8);
  final surfaceContainer = isDark
      ? const Color(0xFF172122)
      : const Color(0xFFFFFFFF);
  final surfaceContainerLow = isDark
      ? const Color(0xFF121B1C)
      : const Color(0xFFEDF4F1);
  final colorScheme = baseScheme.copyWith(
    surface: surface,
    surfaceContainerLowest: isDark ? const Color(0xFF091011) : Colors.white,
    surfaceContainerLow: surfaceContainerLow,
    surfaceContainer: surfaceContainer,
    surfaceContainerHigh: isDark
        ? const Color(0xFF202B2C)
        : const Color(0xFFE4ECE9),
    surfaceContainerHighest: isDark
        ? const Color(0xFF2A3637)
        : const Color(0xFFDCE6E3),
    secondary: isDark ? const Color(0xFFFFC86B) : const Color(0xFF9B5B00),
    onSecondary: isDark ? const Color(0xFF442B00) : Colors.white,
    secondaryContainer: isDark
        ? const Color(0xFF624A20)
        : const Color(0xFFFFE2B4),
    onSecondaryContainer: isDark
        ? const Color(0xFFFFDDA6)
        : const Color(0xFF321B00),
    tertiary: isDark ? const Color(0xFFB8C7FF) : const Color(0xFF415B9C),
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: colorScheme,
    scaffoldBackgroundColor: surface,
    visualDensity: VisualDensity.adaptivePlatformDensity,
    textTheme: ThemeData(brightness: brightness).textTheme.apply(
      bodyColor: colorScheme.onSurface,
      displayColor: colorScheme.onSurface,
    ),
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.linux: FadeForwardsPageTransitionsBuilder(),
        TargetPlatform.macOS: FadeForwardsPageTransitionsBuilder(),
        TargetPlatform.windows: FadeForwardsPageTransitionsBuilder(),
      },
    ),
    appBarTheme: AppBarThemeData(
      scrolledUnderElevation: 0,
      backgroundColor: surface,
      surfaceTintColor: colorScheme.surfaceTint,
      centerTitle: false,
      titleTextStyle: TextStyle(
        color: colorScheme.onSurface,
        fontSize: 22,
        fontWeight: FontWeight.w700,
      ),
    ),
    iconTheme: IconThemeData(color: colorScheme.onSurfaceVariant),
    dividerTheme: DividerThemeData(color: colorScheme.outlineVariant),
    cardTheme: CardThemeData(
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      color: surfaceContainerLow,
      surfaceTintColor: colorScheme.surfaceTint,
    ),
    navigationBarTheme: NavigationBarThemeData(
      elevation: 0,
      height: 78,
      backgroundColor: surfaceContainer,
      indicatorColor: colorScheme.primaryContainer,
      labelTextStyle: WidgetStatePropertyAll(
        TextStyle(fontWeight: FontWeight.w700, color: colorScheme.onSurface),
      ),
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: surfaceContainer,
      indicatorColor: colorScheme.primaryContainer,
      selectedIconTheme: IconThemeData(color: colorScheme.onPrimaryContainer),
      selectedLabelTextStyle: TextStyle(
        color: colorScheme.onSurface,
        fontWeight: FontWeight.w700,
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(16)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide(color: colorScheme.outlineVariant),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide(color: colorScheme.primary, width: 2),
      ),
      filled: true,
      fillColor: colorScheme.surfaceContainerLowest,
      contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
    ),
    listTileTheme: ListTileThemeData(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 4),
    ),
    chipTheme: ChipThemeData(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    ),
    switchTheme: SwitchThemeData(
      thumbIcon: WidgetStateProperty.resolveWith((states) {
        return Icon(
          states.contains(WidgetState.selected)
              ? Icons.check_rounded
              : Icons.close_rounded,
          size: 16,
        );
      }),
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: colorScheme.primary,
      foregroundColor: colorScheme.onPrimary,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
    ),
  );
}

final ThemeData lightTheme = _buildTheme(Brightness.light);
final ThemeData darkTheme = _buildTheme(Brightness.dark);
