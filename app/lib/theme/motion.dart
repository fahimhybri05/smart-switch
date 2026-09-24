import 'package:flutter/animation.dart';

/// Shared animation timing — same idea as [Spacing], one scale reused
/// everywhere instead of ad-hoc literal Durations/Curves per screen.
abstract final class Motion {
  static const micro = Duration(milliseconds: 100);
  static const fast = Duration(milliseconds: 150);
  static const medium = Duration(milliseconds: 300);
  static const slow = Duration(milliseconds: 450);

  static const standard = Curves.easeInOutCubic;

  /// Things arriving on screen: quick start, soft landing.
  static const enter = Curves.easeOutCubic;

  /// Delay for the [index]th item of a staggered list entrance. Capped so a
  /// long list never makes the last visible rows wait.
  static Duration stagger(int index) =>
      Duration(milliseconds: 40 * (index < 8 ? index : 8));
}
