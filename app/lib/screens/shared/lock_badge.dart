import 'package:flutter/material.dart';

/// Small lock pill shown on any tile whose switch is locked (see
/// `SwitchConfig.locked`) — remote commands are blocked, the physical
/// switch still works.
class SwitchLockBadge extends StatelessWidget {
  const SwitchLockBadge({super.key, this.label, this.color});

  /// Optional text after the icon (e.g. "2 locked" on a group).
  final String? label;

  /// Defaults to the theme's tertiary color.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final tint = color ?? Theme.of(context).colorScheme.tertiary;
    return Tooltip(
      message: 'Locked — remote control is blocked',
      child: Semantics(
        label: label ?? 'Locked',
        child: DecoratedBox(
          decoration: ShapeDecoration(
            color: tint.withValues(alpha: 0.14),
            shape: const StadiumBorder(),
          ),
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: label == null ? 5 : 8,
              vertical: 3,
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.lock_rounded, size: 13, color: tint),
                if (label != null) ...[
                  const SizedBox(width: 4),
                  Text(
                    label!,
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: tint,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
