import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/spacing.dart';
import '../shared/device_visualization.dart';
import '../shared/error_view.dart';
import '../shared/loading_view.dart';

class DeviceDetailScreen extends ConsumerWidget {
  const DeviceDetailScreen({super.key, required this.device});

  final KnownDevice device;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Only deviceConfigProvider is watched here — it's static per session
    // (loaded once, invalidated only by an explicit refresh/edit), unlike
    // channelStatesProvider which polls every ~2s. Watching the latter
    // directly in this top-level build() used to rebuild the ENTIRE screen
    // (AppBar, hero, spec tags, every channel row) on every poll tick. Each
    // widget below that actually needs live channel data now watches
    // channelStatesProvider itself (see `_LiveDeviceHero`, `_LiveStatusTag`,
    // `_LiveChannelCount` and `_ChannelRow`), so only those small subtrees
    // rebuild per tick — mirroring home_dashboard_screen.dart's
    // `_LiveOnCount` pattern for the same class of bug.
    final config = ref.watch(deviceConfigProvider(device));
    return Scaffold(
      appBar: AppBar(title: Text(device.friendlyName)),
      body: config.when(
        loading: () => const LoadingView(),
        error: (error, _) => ErrorView(
          message: 'Unable to load ${device.friendlyName}',
          onRetry: () => ref.invalidate(deviceConfigProvider(device)),
        ),
        data: (value) {
          return RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(deviceConfigProvider(device));
              ref.invalidate(channelStatesProvider(device));
              await Future<void>.delayed(const Duration(milliseconds: 300));
            },
            child: ListView(
              padding: const EdgeInsets.all(Spacing.md),
              children: [
                _LiveDeviceHero(device: device, gangCount: value.channelCount),
                const SizedBox(height: Spacing.md),
                Text(
                  device.friendlyName,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: Spacing.xs),
                Wrap(
                  spacing: Spacing.xs,
                  runSpacing: Spacing.xs,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    _SpecTag(value.boardType),
                    _SpecTag('fw ${value.fwVersion}'),
                    _LiveStatusTag(device: device),
                  ],
                ),
                const SizedBox(height: Spacing.lg),
                Row(
                  children: [
                    Text(
                      'Channels',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                    const SizedBox(width: Spacing.sm),
                    _LiveChannelCount(device: device),
                  ],
                ),
                const SizedBox(height: Spacing.sm),
                for (final switchConfig in value.switches)
                  _ChannelRow(
                    device: device,
                    channelIdx: switchConfig.channelIdx,
                    name: switchConfig.name,
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// Isolates the per-poll-tick rebuild caused by [channelStatesProvider] to
/// just the hero illustration, instead of the whole device detail screen.
/// See home_dashboard_screen.dart's `_LiveOnCount` for the identical pattern.
class _LiveDeviceHero extends ConsumerWidget {
  const _LiveDeviceHero({required this.device, required this.gangCount});

  final KnownDevice device;
  final int gangCount;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channels = ref.watch(channelStatesProvider(device));
    final onCount = (channels.asData?.value ?? const <ChannelState>[])
        .where((item) => item.state == ChannelPowerState.on)
        .length;
    // See switch_tile.dart/device_tile.dart's identical comment —
    // channels.hasError almost never fires (channelStatesProvider
    // swallows poll failures into a successful empty list so its
    // retry loop can keep going); deviceUnreachableProvider is the
    // real reachability signal.
    final status =
        (channels.hasError || ref.watch(deviceUnreachableProvider(device)))
        ? DeviceVisualState.offline
        : channels.isLoading
        ? DeviceVisualState.connecting
        : onCount > 0
        ? DeviceVisualState.on
        : DeviceVisualState.off;
    return DeviceVisualization(
      kind: DeviceVisualKind.switchDevice,
      gangCount: gangCount,
      height: 260,
      state: status,
    );
  }
}

/// Isolates the per-poll-tick rebuild caused by [channelStatesProvider] to
/// just the reachability badge next to the spec tags, instead of the whole
/// device detail screen. See `_LiveDeviceHero` above.
class _LiveStatusTag extends ConsumerWidget {
  const _LiveStatusTag({required this.device});

  final KnownDevice device;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channels = ref.watch(channelStatesProvider(device));
    final onCount = (channels.asData?.value ?? const <ChannelState>[])
        .where((item) => item.state == ChannelPowerState.on)
        .length;
    final status =
        (channels.hasError || ref.watch(deviceUnreachableProvider(device)))
        ? DeviceVisualState.offline
        : channels.isLoading
        ? DeviceVisualState.connecting
        : onCount > 0
        ? DeviceVisualState.on
        : DeviceVisualState.off;
    return _StatusTag(status: status);
  }
}

/// Isolates the per-poll-tick rebuild caused by [channelStatesProvider] to
/// just the "N of M on" caption, instead of the whole device detail screen.
/// See `_LiveDeviceHero` above.
class _LiveChannelCount extends ConsumerWidget {
  const _LiveChannelCount({required this.device});

  final KnownDevice device;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final states =
        ref.watch(channelStatesProvider(device)).asData?.value ??
        const <ChannelState>[];
    final onCount = states
        .where((item) => item.state == ChannelPowerState.on)
        .length;
    return Text(
      '$onCount of ${states.length} on',
      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
    );
  }
}

/// Small tonal chip for board/firmware specs — plain Material 3 label
/// styling, no border, so device metadata reads as a caption rather than a
/// stamped panel label.
class _SpecTag extends StatelessWidget {
  const _SpecTag(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Spacing.sm, vertical: 3),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        text,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: colorScheme.onSurfaceVariant,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// Live-green / dim tonal status chip for the device's reachability —
/// a filled Material 3 badge rather than an outlined pill.
class _StatusTag extends StatelessWidget {
  const _StatusTag({required this.status});

  final DeviceVisualState status;

  @override
  Widget build(BuildContext context) {
    final panel = context.panelColors;
    final colorScheme = Theme.of(context).colorScheme;
    final (label, color) = switch (status) {
      DeviceVisualState.offline ||
      DeviceVisualState.error => ('offline', colorScheme.error),
      DeviceVisualState.connecting || DeviceVisualState.pending => (
        'connecting…',
        colorScheme.onSurfaceVariant,
      ),
      DeviceVisualState.on || DeviceVisualState.off => ('online', panel.live),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Spacing.sm, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _ChannelRow extends ConsumerWidget {
  const _ChannelRow({
    required this.device,
    required this.channelIdx,
    required this.name,
  });

  final KnownDevice device;
  final int channelIdx;
  final String name;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Watching channelStatesProvider directly here (rather than having the
    // parent watch it once and pass the state down) confines this row's
    // per-poll-tick rebuild to just this Card — see device_detail_screen's
    // top-level build() comment and home_dashboard_screen.dart's
    // `_LiveOnCount` for the same pattern.
    final channelsAsync = ref.watch(channelStatesProvider(device));
    final override = ref.watch(
      channelOverrideProvider,
    )[(device.deviceId, channelIdx)];
    final polledIsOn = channelsAsync.maybeWhen(
      data: (states) {
        for (final s in states) {
          if (s.channelIdx == channelIdx) {
            return s.state == ChannelPowerState.on;
          }
        }
        return false;
      },
      orElse: () => false,
    );
    final isOn = override != null
        ? override == ChannelPowerState.on
        : polledIsOn;
    // Matches device_tile.dart / switch_tile.dart's identical gating: an
    // in-flight override (optimistic toggle awaiting its round-trip) or an
    // unreachable device both disable the control, so rapid double-tapping
    // a single channel can't fire overlapping requests.
    final isOffline =
        override == null &&
        (channelsAsync.hasError ||
            ref.watch(deviceUnreachableProvider(device)));
    final colorScheme = Theme.of(context).colorScheme;
    final live = context.panelColors.live;
    return Card(
      child: ListTile(
        leading: Container(
          width: 30,
          height: 30,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: colorScheme.surfaceContainerHigh,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Text(
            channelIdx.toString().padLeft(2, '0'),
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: colorScheme.onSurfaceVariant,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        title: Text(name),
        subtitle: Text(
          isOn ? 'ON' : 'OFF',
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
            color: isOn ? live : colorScheme.onSurfaceVariant,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.4,
          ),
        ),
        trailing: Semantics(
          label: '$name, ${isOn ? 'on' : 'off'}',
          child: Switch(
            value: isOn,
            onChanged: isOffline || override != null
                ? null
                : (value) => _toggle(context, ref, value),
          ),
        ),
      ),
    );
  }

  Future<void> _toggle(BuildContext context, WidgetRef ref, bool value) async {
    HapticFeedback.lightImpact();
    final desired = value ? ChannelPowerState.on : ChannelPowerState.off;
    ref
        .read(channelOverrideProvider.notifier)
        .set(device.deviceId, channelIdx, desired);
    final client = ref.read(activeDeviceApiClientProvider(device));
    try {
      await client.setChannelState(channelIdx, desired);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed to toggle: $e')));
      }
    } finally {
      // Re-poll right away instead of waiting up to 2s for the next tick,
      // so the confirmed value lands well before the optimistic override
      // above expires.
      ref.invalidate(channelStatesProvider(device));
    }
  }
}
