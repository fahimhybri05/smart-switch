import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Extra design tokens that don't map onto Material's [ColorScheme] slots —
/// mainly the neutral plate/paddle/screw palette [DeviceVisualization]'s
/// switch-plate illustration paints with, plus a couple of semantic accents
/// (live/warn) it and a few screens pull in directly via
/// `Theme.of(context).extension<AppPanelColors>()` (or the
/// `context.panelColors` shortcut below) instead of hardcoding hex values.
class AppPanelColors extends ThemeExtension<AppPanelColors> {
  const AppPanelColors({
    required this.stage,
    required this.accent,
    required this.accentStrong,
    required this.live,
    required this.liveGlow,
    required this.accentGlow,
    required this.warn,
    required this.off,
    required this.navInk,
    required this.plateHi,
    required this.plateLo,
    required this.paddleHi,
    required this.paddle,
    required this.paddleLo,
    required this.screw,
    required this.shadow,
    required this.hi,
    required this.sh,
  });

  /// Recessed backdrop behind a raised module — darker/deeper than [ColorScheme.surface].
  final Color stage;
  final Color accent;
  final Color accentStrong;
  final Color live;
  final Color liveGlow;
  final Color accentGlow;
  final Color warn;
  final Color off;
  final Color navInk;
  final Color plateHi;
  final Color plateLo;
  final Color paddleHi;
  final Color paddle;
  final Color paddleLo;
  final Color screw;
  final Color shadow;
  final Color hi;
  final Color sh;

  @override
  AppPanelColors copyWith({
    Color? stage,
    Color? accent,
    Color? accentStrong,
    Color? live,
    Color? liveGlow,
    Color? accentGlow,
    Color? warn,
    Color? off,
    Color? navInk,
    Color? plateHi,
    Color? plateLo,
    Color? paddleHi,
    Color? paddle,
    Color? paddleLo,
    Color? screw,
    Color? shadow,
    Color? hi,
    Color? sh,
  }) => AppPanelColors(
    stage: stage ?? this.stage,
    accent: accent ?? this.accent,
    accentStrong: accentStrong ?? this.accentStrong,
    live: live ?? this.live,
    liveGlow: liveGlow ?? this.liveGlow,
    accentGlow: accentGlow ?? this.accentGlow,
    warn: warn ?? this.warn,
    off: off ?? this.off,
    navInk: navInk ?? this.navInk,
    plateHi: plateHi ?? this.plateHi,
    plateLo: plateLo ?? this.plateLo,
    paddleHi: paddleHi ?? this.paddleHi,
    paddle: paddle ?? this.paddle,
    paddleLo: paddleLo ?? this.paddleLo,
    screw: screw ?? this.screw,
    shadow: shadow ?? this.shadow,
    hi: hi ?? this.hi,
    sh: sh ?? this.sh,
  );

  @override
  AppPanelColors lerp(ThemeExtension<AppPanelColors>? other, double t) {
    if (other is! AppPanelColors) return this;
    return AppPanelColors(
      stage: Color.lerp(stage, other.stage, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      accentStrong: Color.lerp(accentStrong, other.accentStrong, t)!,
      live: Color.lerp(live, other.live, t)!,
      liveGlow: Color.lerp(liveGlow, other.liveGlow, t)!,
      accentGlow: Color.lerp(accentGlow, other.accentGlow, t)!,
      warn: Color.lerp(warn, other.warn, t)!,
      off: Color.lerp(off, other.off, t)!,
      navInk: Color.lerp(navInk, other.navInk, t)!,
      plateHi: Color.lerp(plateHi, other.plateHi, t)!,
      plateLo: Color.lerp(plateLo, other.plateLo, t)!,
      paddleHi: Color.lerp(paddleHi, other.paddleHi, t)!,
      paddle: Color.lerp(paddle, other.paddle, t)!,
      paddleLo: Color.lerp(paddleLo, other.paddleLo, t)!,
      screw: Color.lerp(screw, other.screw, t)!,
      shadow: Color.lerp(shadow, other.shadow, t)!,
      hi: Color.lerp(hi, other.hi, t)!,
      sh: Color.lerp(sh, other.sh, t)!,
    );
  }

  static const light = AppPanelColors(
    stage: Color(0xFFEAEDF1),
    accent: Color(0xFF1A73E8),
    accentStrong: Color(0xFF0B57D0),
    live: Color(0xFF1E8E3E),
    liveGlow: Color(0x591E8E3E),
    accentGlow: Color(0x4D1A73E8),
    warn: Color(0xFFE37400),
    off: Color(0xFFC4C7C5),
    navInk: Color(0xFF5F6368),
    plateHi: Color(0xFFF6F8FA),
    plateLo: Color(0xFFDDE1E6),
    paddleHi: Color(0xFFFFFFFF),
    paddle: Color(0xFFF1F3F4),
    paddleLo: Color(0xFFDADCE0),
    screw: Color(0xFF9AA0A6),
    shadow: Color(0x1F1B2733),
    hi: Color(0x8CFFFFFF),
    sh: Color(0x1417191C),
  );

  static const dark = AppPanelColors(
    stage: Color(0xFF131417),
    accent: Color(0xFFA8C7FA),
    accentStrong: Color(0xFFD3E3FD),
    live: Color(0xFF81C995),
    liveGlow: Color(0x6681C995),
    accentGlow: Color(0x52A8C7FA),
    warn: Color(0xFFFDD663),
    off: Color(0xFF444746),
    navInk: Color(0xFF9AA0A6),
    plateHi: Color(0xFF3C4043),
    plateLo: Color(0xFF26282B),
    paddleHi: Color(0xFF5F6368),
    paddle: Color(0xFF48494A),
    paddleLo: Color(0xFF333537),
    screw: Color(0xFF6B7075),
    shadow: Color(0x66000000),
    hi: Color(0x0DFFFFFF),
    sh: Color(0x66000000),
  );
}

/// Convenience accessor: `context.panelColors.accent`, etc.
extension AppPanelColorsContext on BuildContext {
  AppPanelColors get panelColors => Theme.of(this).extension<AppPanelColors>()!;
}

// Modern Material 3 identity — a Google-blue seed instead of the previous
// copper/brass industrial theme, with tonal surfaces via ColorScheme.fromSeed
// and a couple of semantic overrides (live/warn) the app relies on.
const _lightSeed = Color(0xFF1A73E8);
const _darkSeed = Color(0xFFA8C7FA);

ThemeData _buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  final panelTokens = isDark ? AppPanelColors.dark : AppPanelColors.light;

  final baseScheme = ColorScheme.fromSeed(
    seedColor: isDark ? _darkSeed : _lightSeed,
    brightness: brightness,
    contrastLevel: 0.05,
  );
  final colorScheme = baseScheme.copyWith(
    tertiary: panelTokens.live,
    onTertiary: isDark ? const Color(0xFF0A3818) : Colors.white,
    tertiaryContainer: Color.lerp(panelTokens.live, baseScheme.surface, 0.8)!,
    onTertiaryContainer: Color.lerp(panelTokens.live, baseScheme.onSurface, 0.2)!,
    secondary: panelTokens.warn,
    onSecondary: isDark ? const Color(0xFF3D2900) : Colors.white,
    secondaryContainer: Color.lerp(panelTokens.warn, baseScheme.surface, 0.8)!,
    onSecondaryContainer: Color.lerp(panelTokens.warn, baseScheme.onSurface, 0.2)!,
  );

  final ink = colorScheme.onSurface;
  final baseTextTheme = ThemeData(brightness: brightness).textTheme;
  final textTheme = GoogleFonts.archivoTextTheme(baseTextTheme).apply(
    bodyColor: ink,
    displayColor: ink,
  ).copyWith(
    displayLarge: GoogleFonts.archivoBlack(color: ink, fontSize: 57, height: 1.1),
    displayMedium: GoogleFonts.archivoBlack(color: ink, fontSize: 45, height: 1.1),
    displaySmall: GoogleFonts.archivo(color: ink, fontSize: 36, height: 1.15, fontWeight: FontWeight.w700),
    headlineLarge: GoogleFonts.archivo(color: ink, fontSize: 32, height: 1.15, fontWeight: FontWeight.w700),
    headlineMedium: GoogleFonts.archivo(color: ink, fontSize: 28, height: 1.15, fontWeight: FontWeight.w700),
    headlineSmall: GoogleFonts.archivo(color: ink, fontSize: 24, fontWeight: FontWeight.w700),
    titleLarge: GoogleFonts.archivo(color: ink, fontSize: 20, fontWeight: FontWeight.w600),
  );

  return ThemeData(
    useMaterial3: true,
    colorScheme: colorScheme,
    scaffoldBackgroundColor: colorScheme.surface,
    visualDensity: VisualDensity.adaptivePlatformDensity,
    textTheme: textTheme,
    extensions: [panelTokens],
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
      scrolledUnderElevation: 1,
      backgroundColor: colorScheme.surface,
      surfaceTintColor: colorScheme.surfaceTint,
      centerTitle: false,
      titleTextStyle: GoogleFonts.archivo(
        color: ink,
        fontSize: 22,
        fontWeight: FontWeight.w700,
      ),
    ),
    iconTheme: IconThemeData(color: colorScheme.onSurfaceVariant),
    dividerTheme: DividerThemeData(color: colorScheme.outlineVariant),
    cardTheme: CardThemeData(
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      color: colorScheme.surfaceContainerLow,
      surfaceTintColor: colorScheme.surfaceTint,
    ),
    navigationBarTheme: NavigationBarThemeData(
      elevation: 1,
      height: 78,
      backgroundColor: colorScheme.surfaceContainer,
      indicatorColor: colorScheme.secondaryContainer,
      labelTextStyle: WidgetStatePropertyAll(
        GoogleFonts.archivo(fontWeight: FontWeight.w600, color: ink, fontSize: 12),
      ),
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: colorScheme.surfaceContainer,
      indicatorColor: colorScheme.secondaryContainer,
      selectedIconTheme: IconThemeData(color: colorScheme.onSecondaryContainer),
      selectedLabelTextStyle: GoogleFonts.archivo(color: ink, fontWeight: FontWeight.w600),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        textStyle: GoogleFonts.archivo(fontWeight: FontWeight.w600),
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
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
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
      trackColor: WidgetStateProperty.resolveWith((states) {
        return states.contains(WidgetState.selected)
            ? panelTokens.live
            : colorScheme.surfaceContainerHighest;
      }),
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: colorScheme.primaryContainer,
      foregroundColor: colorScheme.onPrimaryContainer,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
    ),
  );
}

final ThemeData lightTheme = _buildTheme(Brightness.light);
final ThemeData darkTheme = _buildTheme(Brightness.dark);
