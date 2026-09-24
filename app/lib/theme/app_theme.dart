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

  // Smart Control palette — same tokens as the web dashboard
  // (dashboard/app/globals.css): navy base, brand green #3DDC97.
  static const light = AppPanelColors(
    stage: Color(0xFFF5F7FA),
    accent: Color(0xFF3DDC97),
    accentStrong: Color(0xFF1C9E6A),
    live: Color(0xFF1C9E6A),
    liveGlow: Color(0x593DDC97),
    accentGlow: Color(0x4D3DDC97),
    warn: Color(0xFFF59309),
    off: Color(0xFFC3CCD8),
    navInk: Color(0xFF5A687C),
    plateHi: Color(0xFFF6F8FA),
    plateLo: Color(0xFFDDE1E6),
    paddleHi: Color(0xFFFFFFFF),
    paddle: Color(0xFFF1F3F4),
    paddleLo: Color(0xFFDADCE0),
    screw: Color(0xFF9AA0A6),
    shadow: Color(0x1F101827),
    hi: Color(0x8CFFFFFF),
    sh: Color(0x14101827),
  );

  static const dark = AppPanelColors(
    stage: Color(0xFF0C1320),
    accent: Color(0xFF3DDC97),
    accentStrong: Color(0xFF1C9E6A),
    live: Color(0xFF3DDC97),
    liveGlow: Color(0x663DDC97),
    accentGlow: Color(0x523DDC97),
    warn: Color(0xFFF6AA28),
    off: Color(0xFF3A4A63),
    navInk: Color(0xFF97A5BA),
    plateHi: Color(0xFF2A2E35),
    plateLo: Color(0xFF1C1F25),
    paddleHi: Color(0xFF3E444F),
    paddle: Color(0xFF343942),
    paddleLo: Color(0xFF2A2F37),
    screw: Color(0xFF6B7280),
    shadow: Color(0x66000000),
    hi: Color(0x14FFFFFF),
    sh: Color(0x66000000),
  );
}

/// Convenience accessor: `context.panelColors.accent`, etc.
extension AppPanelColorsContext on BuildContext {
  AppPanelColors get panelColors => Theme.of(this).extension<AppPanelColors>()!;
}

// Smart Control identity, matching the web dashboard: brand green on a navy
// base. Surfaces are set explicitly (not seed-generated tones) so the app
// and dashboard use the same colors.
const _brand = Color(0xFF3DDC97);
const _navy = Color(0xFF101827);

ThemeData _buildTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  final panelTokens = isDark ? AppPanelColors.dark : AppPanelColors.light;

  final baseScheme = ColorScheme.fromSeed(
    seedColor: _brand,
    brightness: brightness,
  );
  final colorScheme = isDark
      ? baseScheme.copyWith(
          primary: _brand,
          onPrimary: _navy,
          primaryContainer: const Color(0xFF1F4A45),
          onPrimaryContainer: const Color(0xFFBFF3DC),
          secondary: panelTokens.warn,
          onSecondary: _navy,
          secondaryContainer: const Color(0xFF3A3222),
          onSecondaryContainer: const Color(0xFFFCE3B5),
          tertiary: panelTokens.live,
          onTertiary: _navy,
          tertiaryContainer: const Color(0xFF1F4A45),
          onTertiaryContainer: const Color(0xFFBFF3DC),
          error: const Color(0xFFE14747),
          onError: Colors.white,
          errorContainer: const Color(0xFF4A2026),
          onErrorContainer: const Color(0xFFFFD9D9),
          surface: _navy,
          onSurface: const Color(0xFFF1F5F9),
          onSurfaceVariant: const Color(0xFF97A5BA),
          surfaceDim: const Color(0xFF0C1320),
          surfaceBright: const Color(0xFF2B3850),
          surfaceContainerLowest: const Color(0xFF0C1320),
          surfaceContainerLow: const Color(0xFF182234),
          surfaceContainer: const Color(0xFF1C273A),
          surfaceContainerHigh: const Color(0xFF242F42),
          surfaceContainerHighest: const Color(0xFF2B3850),
          outline: const Color(0xFF3A4A63),
          outlineVariant: const Color(0xFF283448),
          surfaceTint: Colors.transparent,
          inverseSurface: const Color(0xFFF1F5F9),
          onInverseSurface: _navy,
          inversePrimary: const Color(0xFF1C9E6A),
        )
      : baseScheme.copyWith(
          // Bright #3DDC97 is ~1.9:1 on white — too faint for text, which
          // Material draws in `primary`. Light mode uses the dashboard's
          // "brand-ink" green for primary; filled buttons/FAB keep _brand.
          primary: const Color(0xFF1C7D56),
          onPrimary: Colors.white,
          primaryContainer: const Color(0xFFD8F8EA),
          onPrimaryContainer: const Color(0xFF0B4A31),
          secondary: panelTokens.warn,
          onSecondary: _navy,
          secondaryContainer: const Color(0xFFFDEBCF),
          onSecondaryContainer: const Color(0xFF5C3A00),
          tertiary: panelTokens.live,
          onTertiary: Colors.white,
          tertiaryContainer: const Color(0xFFD8F8EA),
          onTertiaryContainer: const Color(0xFF0B4A31),
          error: const Color(0xFFDC2828),
          onError: Colors.white,
          errorContainer: const Color(0xFFFDE2E2),
          onErrorContainer: const Color(0xFF7A1111),
          surface: const Color(0xFFF5F7FA),
          onSurface: _navy,
          onSurfaceVariant: const Color(0xFF5A687C),
          surfaceDim: const Color(0xFFE7ECF3),
          surfaceBright: Colors.white,
          surfaceContainerLowest: Colors.white,
          surfaceContainerLow: Colors.white,
          surfaceContainer: const Color(0xFFEEF2F7),
          surfaceContainerHigh: const Color(0xFFE7ECF3),
          surfaceContainerHighest: const Color(0xFFDFE5EE),
          outline: const Color(0xFFB6C1D0),
          outlineVariant: const Color(0xFFD8DFE9),
          surfaceTint: Colors.transparent,
          inverseSurface: _navy,
          onInverseSurface: const Color(0xFFF1F5F9),
          inversePrimary: _brand,
        );

  final ink = colorScheme.onSurface;
  final baseTextTheme = ThemeData(brightness: brightness).textTheme;
  final textTheme = GoogleFonts.archivoTextTheme(baseTextTheme)
      .apply(bodyColor: ink, displayColor: ink)
      .copyWith(
        displayLarge: GoogleFonts.archivoBlack(
          color: ink,
          fontSize: 57,
          height: 1.1,
        ),
        displayMedium: GoogleFonts.archivoBlack(
          color: ink,
          fontSize: 45,
          height: 1.1,
        ),
        displaySmall: GoogleFonts.archivo(
          color: ink,
          fontSize: 36,
          height: 1.15,
          fontWeight: FontWeight.w700,
        ),
        headlineLarge: GoogleFonts.archivo(
          color: ink,
          fontSize: 32,
          height: 1.15,
          fontWeight: FontWeight.w700,
        ),
        headlineMedium: GoogleFonts.archivo(
          color: ink,
          fontSize: 28,
          height: 1.15,
          fontWeight: FontWeight.w700,
        ),
        headlineSmall: GoogleFonts.archivo(
          color: ink,
          fontSize: 24,
          fontWeight: FontWeight.w700,
        ),
        titleLarge: GoogleFonts.archivo(
          color: ink,
          fontSize: 20,
          fontWeight: FontWeight.w600,
        ),
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
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      color: colorScheme.surfaceContainerLow,
      surfaceTintColor: Colors.transparent,
      shape: RoundedSuperellipseBorder(
        borderRadius: BorderRadius.circular(24),
        side: BorderSide(color: colorScheme.outlineVariant),
      ),
    ),
    // Same smooth "squircle" corners as the cards, for every surface that
    // pops up over the app.
    dialogTheme: DialogThemeData(
      shape: RoundedSuperellipseBorder(borderRadius: BorderRadius.circular(28)),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      shape: RoundedSuperellipseBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
    ),
    popupMenuTheme: PopupMenuThemeData(
      shape: RoundedSuperellipseBorder(borderRadius: BorderRadius.circular(18)),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        shape: RoundedSuperellipseBorder(
          borderRadius: BorderRadius.circular(20),
        ),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        shape: RoundedSuperellipseBorder(
          borderRadius: BorderRadius.circular(16),
        ),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      elevation: 1,
      height: 78,
      backgroundColor: colorScheme.surfaceContainerLow,
      indicatorColor: colorScheme.primaryContainer,
      // Default selected icon color comes from the (warn-orange) secondary
      // palette; keep it on the brand green like the indicator.
      iconTheme: WidgetStateProperty.resolveWith(
        (states) => IconThemeData(
          color: states.contains(WidgetState.selected)
              ? colorScheme.onPrimaryContainer
              : colorScheme.onSurfaceVariant,
        ),
      ),
      labelTextStyle: WidgetStatePropertyAll(
        GoogleFonts.archivo(
          fontWeight: FontWeight.w600,
          color: ink,
          fontSize: 12,
        ),
      ),
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: colorScheme.surfaceContainerLow,
      indicatorColor: colorScheme.primaryContainer,
      selectedIconTheme: IconThemeData(color: colorScheme.onPrimaryContainer),
      selectedLabelTextStyle: GoogleFonts.archivo(
        color: ink,
        fontWeight: FontWeight.w600,
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: _brand,
        foregroundColor: _navy,
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
        shape: RoundedSuperellipseBorder(
          borderRadius: BorderRadius.circular(20),
        ),
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
      shape: RoundedSuperellipseBorder(borderRadius: BorderRadius.circular(14)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 4),
    ),
    chipTheme: ChipThemeData(
      shape: RoundedSuperellipseBorder(borderRadius: BorderRadius.circular(20)),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      shape: RoundedSuperellipseBorder(borderRadius: BorderRadius.circular(16)),
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
      backgroundColor: _brand,
      foregroundColor: _navy,
      shape: RoundedSuperellipseBorder(borderRadius: BorderRadius.circular(18)),
    ),
  );
}

final ThemeData lightTheme = _buildTheme(Brightness.light);
final ThemeData darkTheme = _buildTheme(Brightness.dark);
