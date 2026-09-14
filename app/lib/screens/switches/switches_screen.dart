import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../theme/spacing.dart';
import '../shared/empty_devices_view.dart';
import '../shared/error_view.dart';
import '../shared/skeleton_loader.dart';
import '../shared/switch_tile.dart';

class SwitchesScreen extends ConsumerWidget {
  const SwitchesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(knownDevicesProvider);

    if (devices.isEmpty) {
      return const Scaffold(body: EmptyDevicesView());
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Switches')),
      body: RefreshIndicator(
        onRefresh: () => refreshAllDevices(ref, devices),
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: Spacing.sm),
          children: [
            for (final device in devices)
              _DeviceSwitchesSection(device: device),
          ],
        ),
      ),
    );
  }
}

class _DeviceSwitchesSection extends ConsumerWidget {
  const _DeviceSwitchesSection({required this.device});

  final KnownDevice device;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final configAsync = ref.watch(deviceConfigProvider(device));

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
          child: Text(
            device.friendlyName,
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        configAsync.when(
          data: (config) => Card(
            child: Column(
              children: [
                for (var i = 0; i < config.switches.length; i++) ...[
                  SwitchTile(device: device, switchConfig: config.switches[i]),
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
    );
  }
}
