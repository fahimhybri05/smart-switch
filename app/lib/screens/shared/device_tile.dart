import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/device/switch_config.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../device_detail/device_detail_screen.dart';
import 'device_visualization.dart';
import 'edit_switch_dialog.dart';
import 'friendly_error.dart';

/// Big, square, tap-to-toggle tile — the primary at-a-glance control surface
/// on the Home dashboard (Google Home / Nest-style device grid). Whole tile
/// toggles the switch; the corner icon opens rename/zone editing.
class DeviceTile extends ConsumerWidget {
  const DeviceTile({
    super.key,
    required this.device,
    required this.switchConfig,
  });

  final KnownDevice device;
  final SwitchConfig switchConfig;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channelsAsync = ref.watch(channelStatesProvider(device));
    final colorScheme = Theme.of(context).colorScheme;
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

    final foregroundColor = isOn
        ? colorScheme.onPrimaryContainer
        : colorScheme.onSurfaceVariant;

    // Superellipse ("squircle") corners — smoother than a plain circular
    // radius. The decoration sits outside the clip so the ON glow isn't cut.
    const radius = BorderRadius.all(Radius.circular(32));
    return AnimatedContainer(
      duration: Motion.medium,
      curve: Curves.easeOut,
      decoration: ShapeDecoration(
        // ON reads at a glance: the whole card takes the accent, not just
        // the drawn switch plate.
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: isOn
              ? [
                  colorScheme.primaryContainer,
                  Color.alphaBlend(
                    colorScheme.primary.withValues(alpha: 0.18),
                    colorScheme.primaryContainer,
                  ),
                ]
              : [
                  colorScheme.surfaceContainerLow,
                  colorScheme.surfaceContainerLow,
                ],
        ),
        shape: RoundedSuperellipseBorder(
          borderRadius: radius,
          side: BorderSide(
            color: isOn
                ? colorScheme.primary.withValues(alpha: 0.45)
                : colorScheme.outlineVariant.withValues(alpha: 0.45),
            width: isOn ? 1.5 : 1,
          ),
        ),
        shadows: [
          BoxShadow(
            color: isOn
                ? colorScheme.primary.withValues(alpha: 0.28)
                : Colors.transparent,
            blurRadius: 20,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: ClipRSuperellipse(
        borderRadius: radius,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            customBorder: const RoundedSuperellipseBorder(borderRadius: radius),
            onTap: isOffline ? null : () => _toggle(context, ref, !isOn),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: Spacing.md,
                vertical: Spacing.sm,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      isOffline
                          ? const _OfflineBadge()
                          : _StateDot(
                              state: visualState,
                              color: foregroundColor,
                            ),
                      const Spacer(),
                      // PopupMenuButton's default IconButton enforces a 48x48
                      // min tap target regardless of the icon's own size —
                      // shrinkWrap removes that so this header row doesn't
                      // claim far more vertical space than its 20px icon
                      // actually needs, which was overflowing this tile's
                      // fixed grid-cell height by ~21px.
                      Theme(
                        data: Theme.of(context).copyWith(
                          materialTapTargetSize:
                              MaterialTapTargetSize.shrinkWrap,
                        ),
                        child: PopupMenuButton<String>(
                          padding: const EdgeInsets.all(4),
                          icon: Icon(
                            Icons.more_horiz_rounded,
                            size: 20,
                            color: foregroundColor.withValues(alpha: 0.7),
                          ),
                          onSelected: (value) {
                            if (value == 'details') {
                              Navigator.of(context).push(
                                MaterialPageRoute<void>(
                                  builder: (_) =>
                                      DeviceDetailScreen(device: device),
                                ),
                              );
                            } else if (value == 'edit') {
                              _edit(context, ref);
                            }
                          },
                          itemBuilder: (_) => const [
                            PopupMenuItem(
                              value: 'details',
                              child: Text('Open device'),
                            ),
                            PopupMenuItem(
                              value: 'edit',
                              child: Text('Edit name and room'),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  DeviceVisualization(
                    kind: _kindFor(switchConfig.name),
                    state: visualState,
                    height: 112,
                    onTap: isOffline
                        ? null
                        : () => _toggle(context, ref, !isOn),
                  ),
                  AnimatedDefaultTextStyle(
                    duration: Motion.medium,
                    style: Theme.of(context).textTheme.titleMedium!.copyWith(
                      color: foregroundColor,
                      fontWeight: isOn ? FontWeight.w800 : FontWeight.w600,
                    ),
                    child: Text(
                      switchConfig.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(height: 2),
                  AnimatedDefaultTextStyle(
                    duration: Motion.medium,
                    style: Theme.of(context).textTheme.bodySmall!.copyWith(
                      color: isOn
                          ? colorScheme.primary
                          : foregroundColor.withValues(alpha: 0.8),
                      fontWeight: isOn ? FontWeight.w700 : FontWeight.w400,
                    ),
                    child: Text(
                      isOffline
                          ? 'Offline'
                          : isLoading
                          ? 'Connecting'
                          : isOn
                          ? 'On'
                          : 'Off',
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
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

  Future<void> _edit(BuildContext context, WidgetRef ref) async {
    final result = await showEditSwitchDialog(context, switchConfig);
    if (result == null) return;

    final (name, zone, inputMode, inchingMs) = result;
    final client = ref.read(activeDeviceApiClientProvider(device));
    try {
      await client.upsertSwitch(
        SwitchConfig(
          channelIdx: switchConfig.channelIdx,
          name: name,
          zone: zone,
          type: switchConfig.type,
          defaultBootState: switchConfig.defaultBootState,
          inputMode: inputMode,
          inchingMs: inchingMs,
        ),
      );
      ref.invalidate(deviceConfigProvider(device));
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyErrorMessage(e, 'Save'))),
        );
      }
    }
  }
}

class _StateDot extends StatelessWidget {
  const _StateDot({required this.state, required this.color});

  final DeviceVisualState state;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final isActive = state == DeviceVisualState.on;
    final isAttention =
        state == DeviceVisualState.offline || state == DeviceVisualState.error;
    return AnimatedContainer(
      duration: Motion.fast,
      width: 10,
      height: 10,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: isAttention ? Theme.of(context).colorScheme.error : color,
        boxShadow: isActive
            ? [BoxShadow(color: color.withValues(alpha: 0.5), blurRadius: 8)]
            : null,
      ),
    );
  }
}

/// Replaces the state dot on an unreachable tile so "can't control this
/// right now" is explicit rather than just a dimmed card.
class _OfflineBadge extends StatelessWidget {
  const _OfflineBadge();

  @override
  Widget build(BuildContext context) {
    final error = Theme.of(context).colorScheme.error;
    return DecoratedBox(
      decoration: ShapeDecoration(
        color: error.withValues(alpha: 0.14),
        shape: const StadiumBorder(),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_rounded, size: 13, color: error),
            const SizedBox(width: 4),
            Text(
              'Offline',
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                color: error,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
