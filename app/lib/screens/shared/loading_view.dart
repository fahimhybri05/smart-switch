import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../../theme/motion.dart';
import '../../theme/spacing.dart';

/// Centered pulsing icon + optional label — reused wherever a screen is
/// waiting on a device fetch or similar async work without a natural
/// skeleton shape (see skeleton_loader.dart for list/grid-shaped waits).
class LoadingView extends StatelessWidget {
  const LoadingView({super.key, this.label});

  final String? label;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.bolt, size: 40, color: colorScheme.primary)
              .animate(onPlay: (controller) => controller.repeat(reverse: true))
              .fadeIn(duration: Motion.slow, curve: Motion.standard)
              .scaleXY(
                begin: 0.85,
                end: 1.1,
                duration: Motion.slow,
                curve: Motion.standard,
              ),
          if (label != null) ...[
            const SizedBox(height: Spacing.md),
            Text(label!, style: Theme.of(context).textTheme.bodyMedium),
          ],
        ],
      ),
    );
  }
}
