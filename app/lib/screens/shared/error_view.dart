import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../../theme/motion.dart';
import '../../theme/spacing.dart';

/// Icon + message + optional retry — reused wherever a device fetch or
/// similar async call fails (e.g. an unreachable device).
class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
          child: Padding(
            padding: const EdgeInsets.all(Spacing.lg),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.cloud_off_outlined,
                  size: 40,
                  color: colorScheme.error,
                ),
                const SizedBox(height: Spacing.sm),
                Text(
                  message,
                  textAlign: TextAlign.center,
                  style: Theme.of(
                    context,
                  ).textTheme.bodyMedium?.copyWith(color: colorScheme.error),
                ),
                if (onRetry != null) ...[
                  const SizedBox(height: Spacing.md),
                  OutlinedButton.icon(
                    onPressed: onRetry,
                    icon: const Icon(Icons.refresh),
                    label: const Text('Retry'),
                  ),
                ],
              ],
            ),
          ),
        )
        .animate()
        .fadeIn(duration: Motion.medium, curve: Motion.standard)
        .slideY(
          begin: 0.1,
          end: 0,
          duration: Motion.medium,
          curve: Motion.standard,
        );
  }
}
