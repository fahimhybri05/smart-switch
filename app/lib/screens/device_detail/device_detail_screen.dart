import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../theme/spacing.dart';
import '../shared/device_visualization.dart';
import '../shared/error_view.dart';
import '../shared/loading_view.dart';

class DeviceDetailScreen extends ConsumerWidget {
  const DeviceDetailScreen({super.key, required this.device});

  final KnownDevice device;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(deviceConfigProvider(device));
    final channels = ref.watch(channelStatesProvider(device));
    return Scaffold(
      appBar: AppBar(title: Text(device.friendlyName)),
      body: config.when(
        loading: () => const LoadingView(),
        error: (error, _) => ErrorView(
          message: 'Unable to load ${device.friendlyName}',
          onRetry: () => ref.invalidate(deviceConfigProvider(device)),
        ),
        data: (value) {
          final states = channels.asData?.value ?? const <ChannelState>[];
          final onCount = states
              .where((item) => item.state == ChannelPowerState.on)
              .length;
          final status = channels.hasError
              ? DeviceVisualState.offline
              : channels.isLoading
              ? DeviceVisualState.connecting
              : onCount > 0
              ? DeviceVisualState.on
              : DeviceVisualState.off;
          return RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(deviceConfigProvider(device));
              ref.invalidate(channelStatesProvider(device));
              await Future<void>.delayed(const Duration(milliseconds: 300));
            },
            child: ListView(
              padding: const EdgeInsets.all(Spacing.md),
              children: [
                DeviceVisualization(
                  kind: DeviceVisualKind.switchDevice,
                  gangCount: value.channelCount,
                  height: 260,
                  state: status,
                ),
                const SizedBox(height: Spacing.md),
                Text(
                  device.friendlyName,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                Text(
                  '${value.boardType} • firmware ${value.fwVersion}',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: Spacing.lg),
                Text('Channels', style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: Spacing.sm),
                for (final switchConfig in value.switches)
                  _ChannelRow(
                    device: device,
                    channelIdx: switchConfig.channelIdx,
                    name: switchConfig.name,
                    state: states
                        .where(
                          (item) => item.channelIdx == switchConfig.channelIdx,
                        )
                        .firstOrNull
                        ?.state,
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _ChannelRow extends ConsumerWidget {
  const _ChannelRow({
    required this.device,
    required this.channelIdx,
    required this.name,
    required this.state,
  });

  final KnownDevice device;
  final int channelIdx;
  final String name;
  final ChannelPowerState? state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isOn = state == ChannelPowerState.on;
    return Card(
      child: ListTile(
        title: Text(name),
        subtitle: Text(isOn ? 'ON' : 'OFF'),
        trailing: Switch(
          value: isOn,
          onChanged: (value) async {
            final desired = value
                ? ChannelPowerState.on
                : ChannelPowerState.off;
            ref
                .read(channelOverrideProvider.notifier)
                .set(device.deviceId, channelIdx, desired);
            await ref
                .read(activeDeviceApiClientProvider(device))
                .setChannelState(channelIdx, desired);
            ref.invalidate(channelStatesProvider(device));
          },
        ),
      ),
    );
  }
}
