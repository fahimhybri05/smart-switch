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
            Icon(icon, size: 48, color: colorScheme.outline)
                .animate()
                .fadeIn(duration: Motion.medium, curve: Motion.standard)
                .scaleXY(
                  begin: 0.8,
                  end: 1,
                  duration: Motion.medium,
                  curve: Curves.easeOutBack,
                ),
            const SizedBox(height: Spacing.md),
            Text(
              title,
              style: Theme.of(context).textTheme.titleMedium,
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
