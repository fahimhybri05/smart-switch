import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/device/switch_config.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import 'device_visualization.dart';
import 'edit_switch_dialog.dart';

/// One switch's live ON/OFF control tile — reused by Zones and Switches
/// screens. Reads live state from [channelStatesProvider]'s 2s poll,
/// overlaid with an optimistic [channelOverrideProvider] value the instant
/// a toggle is tapped (see that provider's doc comment), and writes via
/// [DeviceApiClient.setChannelState]. The edit icon opens a rename/zone
/// dialog (POST /api/switches).
class SwitchTile extends ConsumerWidget {
  const SwitchTile({
    super.key,
    required this.device,
    required this.switchConfig,
  });

  final KnownDevice device;
  final SwitchConfig switchConfig;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channelsAsync = ref.watch(channelStatesProvider(device));
    final override = ref.watch(
      channelOverrideProvider,
    )[(device.deviceId, switchConfig.channelIdx)];

    final polledIsOn = channelsAsync.maybeWhen(
      data: (states) {
        for (final s in states) {
          if (s.channelIdx == switchConfig.channelIdx) {
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
    final isLoading = override == null && channelsAsync.isLoading;
    final isOffline = override == null && channelsAsync.hasError;
    final visualState = override != null
        ? DeviceVisualState.pending
        : isOffline
        ? DeviceVisualState.offline
        : isLoading
        ? DeviceVisualState.connecting
        : isOn
        ? DeviceVisualState.on
        : DeviceVisualState.off;

    return ListTile(
      leading: SizedBox(
        width: 72,
        child: DeviceVisualization(
          kind: _kindFor(switchConfig.name),
          state: visualState,
          height: 58,
          onTap: isOffline ? null : () => _toggle(context, ref, !isOn),
        ),
      ),
      title: Text(
        switchConfig.name,
        style: const TextStyle(fontWeight: FontWeight.w700),
      ),
      subtitle: Text(
        isOffline
            ? 'Offline'
            : isLoading
            ? 'Connecting'
            : switchConfig.zone.trim().isEmpty
            ? device.friendlyName
            : '${device.friendlyName} • ${switchConfig.zone}',
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            icon: const Icon(Icons.edit_outlined),
            tooltip: 'Rename / set zone',
            onPressed: () => _edit(context, ref),
          ),
          Switch(
            value: isOn,
            onChanged: isOffline
                ? null
                : (value) => _toggle(context, ref, value),
          ),
        ],
      ),
    );
  }

  DeviceVisualKind _kindFor(String name) {
    return DeviceVisualKind.fromName(name);
  }

  Future<void> _toggle(BuildContext context, WidgetRef ref, bool value) async {
    HapticFeedback.lightImpact();
    final desired = value ? ChannelPowerState.on : ChannelPowerState.off;
    ref
        .read(channelOverrideProvider.notifier)
        .set(device.deviceId, switchConfig.channelIdx, desired);
    final client = ref.read(activeDeviceApiClientProvider(device));
    try {
      await client.setChannelState(switchConfig.channelIdx, desired);
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

  Future<void> _edit(BuildContext context, WidgetRef ref) async {
    final result = await showEditSwitchDialog(context, switchConfig);
    if (result == null) return;

    final (name, zone) = result;
    final client = ref.read(activeDeviceApiClientProvider(device));
    try {
      await client.upsertSwitch(
        SwitchConfig(
          channelIdx: switchConfig.channelIdx,
          name: name,
          zone: zone,
          type: switchConfig.type,
          defaultBootState: switchConfig.defaultBootState,
        ),
      );
      ref.invalidate(deviceConfigProvider(device));
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed to save: $e')));
      }
    }
  }
}
