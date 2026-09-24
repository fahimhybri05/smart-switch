import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../../theme/motion.dart';
import '../../theme/spacing.dart';

/// Generic icon + title + subtitle empty-state, reused wherever a screen has
/// nothing to show yet (no devices, no schedules, no groups...).
class EmptyStateView extends StatelessWidget {
  const EmptyStateView({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
  });

  final IconData icon;
  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Spacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Icon in a soft tinted squircle — same shape language as the
            // rest of the app, friendlier than a bare grey glyph.
            DecoratedBox(
                  decoration: ShapeDecoration(
                    color: colorScheme.primaryContainer.withValues(alpha: 0.6),
                    shape: const RoundedSuperellipseBorder(
                      borderRadius: BorderRadius.all(Radius.circular(32)),
                    ),
                  ),
                  child: SizedBox(
                    width: 96,
                    height: 96,
                    child: Icon(
                      icon,
                      size: 44,
                      color: colorScheme.onPrimaryContainer,
                    ),
                  ),
                )
                .animate()
                .fadeIn(duration: Motion.medium, curve: Motion.standard)
                .scaleXY(
                  begin: 0.8,
                  end: 1,
                  duration: Motion.medium,
                  curve: Curves.easeOutBack,
                ),
            const SizedBox(height: Spacing.lg),
            Text(
              title,
              style: Theme.of(
                context,
              ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              textAlign: TextAlign.center,
            ),
            if (subtitle != null) ...[
              const SizedBox(height: Spacing.xs),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    ).animate().fadeIn(duration: Motion.medium, curve: Motion.standard);
  }
}
