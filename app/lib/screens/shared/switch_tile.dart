import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/device/switch_config.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../theme/spacing.dart';
import 'device_visualization.dart';
import 'edit_switch_dialog.dart';
import 'friendly_error.dart';
import 'lock_badge.dart';

/// One switch's live ON/OFF control tile — reused by Zones and Switches
/// screens. Reads live state from [channelStatesProvider]'s 2s poll,
/// overlaid with an optimistic [channelOverrideProvider] value the instant
/// a toggle is tapped (see that provider's doc comment), and writes via
/// [DeviceApiClient.setChannelState]. The edit icon opens the switch
/// settings dialog (POST /api/switches). A locked switch shows a lock badge
/// and answers taps with a snackbar instead of sending a command.
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
    // Only the very first load (no data yet) counts as connecting — a
    // background re-poll keeps showing the last known state.
    final isLoading =
        override == null && channelsAsync.isLoading && !channelsAsync.hasValue;
    // channelsAsync.hasError almost never fires in practice —
    // channelStatesProvider swallows every poll failure into a successful
    // `yield const []` so its retry loop can keep going (see that
    // provider's doc comment) — so deviceUnreachableProvider is the real
    // reachability signal; hasError is kept as a belt-and-suspenders check
    // for the rare case the stream errors before that catch block runs.
    final isOffline =
        override == null &&
        (channelsAsync.hasError ||
            ref.watch(deviceUnreachableProvider(device)));
    // A command in flight shows its target state right away (no spinner).
    final visualState = isOffline
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
      title: Row(
        children: [
          Flexible(
            child: Text(
              switchConfig.name,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
            ),
          ),
          if (switchConfig.locked) ...[
            const SizedBox(width: Spacing.xs),
            const SwitchLockBadge(),
          ],
        ],
      ),
      subtitle: Text(
        isOffline
            ? 'Offline'
            : isLoading
            ? 'Connecting'
            : switchConfig.zone.trim().isEmpty
            ? device.friendlyName
            : '${device.friendlyName} • ${switchConfig.zone}',
        style: isOffline
            ? TextStyle(color: Theme.of(context).colorScheme.error)
            : null,
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            icon: const Icon(Icons.edit_outlined),
            tooltip: 'Switch settings',
            onPressed: () => _edit(context, ref),
          ),
          const SizedBox(width: Spacing.xs),
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
    // Locked: say so instead of sending — the backend would reject it
    // anyway (423 switch_locked), this just skips the round trip.
    if (switchConfig.locked) {
      showSwitchLockedSnackBar(context);
      return;
    }
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
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyErrorMessage(e, 'Toggle'))),
        );
      }
    } finally {
      // Re-poll right away instead of waiting up to 2s for the next tick,
      // so the confirmed value lands well before the optimistic override
      // above expires.
      ref.invalidate(channelStatesProvider(device));
    }
  }

  Future<void> _edit(BuildContext context, WidgetRef ref) =>
      editSwitchSettings(context, ref, device, switchConfig);
}
