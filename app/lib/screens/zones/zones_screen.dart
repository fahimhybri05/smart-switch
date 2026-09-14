import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/device/device_config.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../services/zone_aggregation_service.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../shared/empty_devices_view.dart';
import '../shared/empty_state_view.dart';
import '../shared/skeleton_loader.dart';
import '../shared/switch_tile.dart';

class ZonesScreen extends ConsumerWidget {
  const ZonesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(knownDevicesProvider);

    if (devices.isEmpty) {
      return const Scaffold(body: EmptyDevicesView());
    }

    final configs = <DeviceConfig>[];
    var anyLoading = false;
    for (final device in devices) {
      ref
          .watch(deviceConfigProvider(device))
          .when(
            data: configs.add,
            loading: () => anyLoading = true,
            error: (_, _) {},
          );
    }

    final zones = ref.read(zoneAggregationServiceProvider).buildZones(configs);
    final devicesById = {for (final d in devices) d.deviceId: d};

    return Scaffold(
      appBar: AppBar(title: const Text('Rooms')),
      body: zones.isEmpty
          ? (anyLoading
                ? const SkeletonListPlaceholder()
                : const EmptyStateView(
                    icon: Icons.map_outlined,
                    title: 'No switches labeled yet.',
                  ))
          : RefreshIndicator(
              onRefresh: () => refreshAllDevices(ref, devices),
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: Spacing.sm),
                children: [
                  for (final (i, zone) in zones.indexed)
                    _ZoneSection(
                      zone: zone,
                      devicesById: devicesById,
                      index: i,
                    ),
                ],
              ),
            ),
    );
  }
}

class _ZoneSection extends ConsumerWidget {
  const _ZoneSection({
    required this.zone,
    required this.devicesById,
    required this.index,
  });

  final Zone zone;
  final Map<String, KnownDevice> devicesById;
  final int index;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tiles = [
      for (final switchRef in zone.switches)
        if (devicesById[switchRef.deviceId] case final device?)
          SwitchTile(device: device, switchConfig: switchRef.switchConfig),
    ];
    if (tiles.isEmpty) {
      return const SizedBox.shrink();
    }

    final colorScheme = Theme.of(context).colorScheme;
    final members = [
      for (final switchRef in zone.switches)
        if (devicesById[switchRef.deviceId] case final device?)
          (device: device, config: switchRef.switchConfig),
    ];

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
                  Container(
                    width: 38,
                    height: 38,
                    decoration: BoxDecoration(
                      color: colorScheme.secondaryContainer,
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Icon(
                      _roomIcon(zone.name),
                      size: 20,
                      color: colorScheme.onSecondaryContainer,
                    ),
                  ),
                  const SizedBox(width: Spacing.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          zone.name,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        Text(
                          '${members.length} ${members.length == 1 ? 'device' : 'devices'}',
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: colorScheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Turn room on',
                    onPressed: () => _toggleRoom(ref, members, true),
                    icon: const Icon(Icons.light_mode_outlined),
                  ),
                  IconButton(
                    tooltip: 'Turn room off',
                    onPressed: () => _toggleRoom(ref, members, false),
                    icon: const Icon(Icons.dark_mode_outlined),
                  ),
                ],
              ),
            ),
            Card(
              child: Column(
                children: [
                  for (var i = 0; i < tiles.length; i++) ...[
                    tiles[i],
                    if (i != tiles.length - 1)
                      const Divider(
                        height: 1,
                        indent: Spacing.md,
                        endIndent: Spacing.md,
                      ),
                  ],
                ],
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

  IconData _roomIcon(String name) {
    final value = name.toLowerCase();
    if (value.contains('bed')) return Icons.bedroom_parent_outlined;
    if (value.contains('kitchen')) return Icons.restaurant_outlined;
    if (value.contains('bath')) return Icons.bathtub_outlined;
    if (value.contains('office')) return Icons.work_outline_rounded;
    if (value.contains('garden') || value.contains('outdoor')) {
      return Icons.yard_outlined;
    }
    if (value.contains('garage')) return Icons.garage_outlined;
    if (value.contains('entrance') || value.contains('door')) {
      return Icons.door_front_door_outlined;
    }
    return Icons.weekend_outlined;
  }

  Future<void> _toggleRoom(
    WidgetRef ref,
    List<({KnownDevice device, dynamic config})> members,
    bool on,
  ) async {
    HapticFeedback.mediumImpact();
    final desired = on ? ChannelPowerState.on : ChannelPowerState.off;
    final overrides = ref.read(channelOverrideProvider.notifier);
    await Future.wait(
      members.map((member) async {
        overrides.set(
          member.device.deviceId,
          member.config.channelIdx,
          desired,
        );
        try {
          await ref
              .read(activeDeviceApiClientProvider(member.device))
              .setChannelState(member.config.channelIdx, desired);
        } catch (_) {}
      }),
    );
    for (final member in members) {
      ref.invalidate(channelStatesProvider(member.device));
    }
  }
}
