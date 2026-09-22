import 'package:flutter/material.dart';
import 'package:shimmer/shimmer.dart';

import '../../theme/spacing.dart';

/// Wraps [child] in a shimmer sweep using the current theme's surface tones
/// — one shimmer per screen (not per box) is more efficient, so callers
/// should wrap a whole skeleton layout rather than each [SkeletonBox].
class SkeletonShimmer extends StatelessWidget {
  const SkeletonShimmer({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Shimmer.fromColors(
      baseColor: colorScheme.surfaceContainerHighest,
      highlightColor: colorScheme.surfaceContainerLowest,
      child: child,
    );
  }
}

/// A single placeholder rectangle — solid color, overridden by the
/// enclosing [SkeletonShimmer]'s gradient.
class SkeletonBox extends StatelessWidget {
  const SkeletonBox({
    super.key,
    required this.width,
    required this.height,
    this.borderRadius = 8,
  });

  final double width;
  final double height;
  final double borderRadius;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(borderRadius),
      ),
    );
  }
}

/// Mimics a `Card`-wrapped list row (device/schedule/group tile) while its
/// real content is loading.
class SkeletonListPlaceholder extends StatelessWidget {
  const SkeletonListPlaceholder({super.key, this.rowCount = 3});

  final int rowCount;

  @override
  Widget build(BuildContext context) {
    return SkeletonShimmer(
      child: Column(
        children: [
          for (var i = 0; i < rowCount; i++)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(Spacing.md),
                child: Row(
                  children: [
                    const SkeletonBox(width: 40, height: 40, borderRadius: 20),
                    const SizedBox(width: Spacing.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: const [
                          SkeletonBox(width: 120, height: 14),
                          SizedBox(height: Spacing.xs),
                          SkeletonBox(width: 80, height: 12),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// Mimics [DeviceTile]'s grid shape while `channelStatesProvider`/
/// `deviceConfigProvider` are loading.
class SkeletonGridPlaceholder extends StatelessWidget {
  const SkeletonGridPlaceholder({super.key, this.tileCount = 6});

  final int tileCount;

  @override
  Widget build(BuildContext context) {
    return SkeletonShimmer(
      child: GridView.builder(
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: Spacing.md),
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
          maxCrossAxisExtent: 200,
          mainAxisSpacing: Spacing.sm,
          crossAxisSpacing: Spacing.sm,
          childAspectRatio: 1.1,
        ),
        itemCount: tileCount,
        itemBuilder: (context, i) => Container(
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(28),
          ),
        ),
      ),
    );
  }
}
