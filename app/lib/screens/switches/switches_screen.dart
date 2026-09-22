import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../shared/device_sync_gate.dart';
import '../shared/error_view.dart';
import '../shared/skeleton_loader.dart';
import '../shared/switch_tile.dart';

class SwitchesScreen extends ConsumerWidget {
  const SwitchesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(knownDevicesProvider);

    final deviceGate = buildDeviceEmptyOrLoadingState(ref, devices);
    if (deviceGate != null) {
      return Scaffold(body: deviceGate);
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Switches')),
      body: RefreshIndicator(
        onRefresh: () => refreshAllDevices(ref, devices),
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: Spacing.sm),
          children: [
            for (final (i, device) in devices.indexed)
              _DeviceSwitchesSection(device: device, index: i),
          ],
        ),
      ),
    );
  }
}

class _DeviceSwitchesSection extends ConsumerWidget {
  const _DeviceSwitchesSection({required this.device, required this.index});

  final KnownDevice device;
  final int index;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final configAsync = ref.watch(deviceConfigProvider(device));
    final colorScheme = Theme.of(context).colorScheme;
    final channelCount = configAsync.asData?.value.switches.length;

    return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(
                Spacing.md,
                Spacing.md,
                Spacing.md,
                Spacing.xs,
              ),
              child: Row(
                children: [
                  Text(
                    device.friendlyName,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if (channelCount != null) ...[
                    const Spacer(),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: Spacing.sm,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: colorScheme.secondaryContainer,
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Text(
                        channelCount == 1
                            ? '1 channel'
                            : '$channelCount channels',
                        style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: colorScheme.onSecondaryContainer,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            configAsync.when(
              data: (config) => Card(
                child: Column(
                  children: [
                    for (var i = 0; i < config.switches.length; i++) ...[
                      SwitchTile(
                        device: device,
                        switchConfig: config.switches[i],
                      ),
                      if (i != config.switches.length - 1)
                        const Divider(
                          height: 1,
                          indent: Spacing.md,
                          endIndent: Spacing.md,
                        ),
                    ],
                  ],
                ),
              ),
              loading: () => const SkeletonListPlaceholder(rowCount: 1),
              error: (e, _) => ErrorView(
                message: '${device.friendlyName} is unreachable',
                onRetry: () => ref.invalidate(deviceConfigProvider(device)),
              ),
            ),
          ],
        )
        .animate(delay: Motion.fast * index)
        .fadeIn(duration: Motion.medium, curve: Motion.standard)
        .slideY(
          begin: 0.08,
          end: 0,
          duration: Motion.medium,
          curve: Motion.standard,
        );
  }
}
