import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/device_health.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../services/backend/backend_devices_client.dart';
import '../../theme/spacing.dart';
import '../shared/friendly_error.dart';

/// Health for one device from the backend; re-fetched every 30 s while open.
final deviceHealthProvider = FutureProvider.autoDispose
    .family<DeviceHealth, String>((ref, deviceId) async {
      final url = ref.read(backendUrlProvider);
      if (url == null) {
        throw StateError('backend server URL not configured');
      }
      final timer = Timer(const Duration(seconds: 30), ref.invalidateSelf);
      ref.onDispose(timer.cancel);
      final token = await ensureFreshAccessTokenForNotifier(ref);
      return BackendDevicesClient(
        baseUrl: url,
        accessToken: token,
      ).health(deviceId);
    });

/* ------------------------------- Formatting ------------------------------- */

String formatDuration(Duration d) {
  if (d.inMinutes < 1) return 'under a minute';
  final days = d.inDays;
  final hours = d.inHours % 24;
  final minutes = d.inMinutes % 60;
  if (days > 0) return '${days}d ${hours}h';
  if (d.inHours > 0) return '${d.inHours}h ${minutes}m';
  return '${d.inMinutes}m';
}

String _ago(DateTime t) =>
    '${formatDuration(DateTime.now().difference(t))} ago';

({String label, String hint, int bars, bool weak}) signalQuality(int rssi) {
  if (rssi >= -55) {
    return (
      label: 'Excellent',
      hint: 'Very strong connection.',
      bars: 4,
      weak: false,
    );
  }
  if (rssi >= -67) {
    return (
      label: 'Good',
      hint: 'Reliable for switching.',
      bars: 3,
      weak: false,
    );
  }
  if (rssi >= -75) {
    return (
      label: 'Fair',
      hint: 'Usually fine, but it may drop now and then.',
      bars: 2,
      weak: false,
    );
  }
  return (
    label: 'Weak',
    hint:
        'Likely to disconnect. Move the router closer or add a Wi-Fi extender.',
    bars: 1,
    weak: true,
  );
}

/// ESP8266 `ESP.getResetReason()` strings → plain language.
({String label, String hint, bool problem}) resetReasonInfo(String raw) {
  final r = raw.toLowerCase();
  if (r.contains('power')) {
    return (
      label: 'Power on',
      hint: 'It was switched on or power returned after a cut.',
      problem: false,
    );
  }
  if (r.contains('external')) {
    return (
      label: 'Reset button',
      hint: 'Restarted by its reset pin or after a firmware update.',
      problem: false,
    );
  }
  if (r.contains('software/system') || r.contains('restart')) {
    return (
      label: 'Planned restart',
      hint: 'Restarted on purpose, e.g. after a settings change.',
      problem: false,
    );
  }
  if (r.contains('deep')) {
    return (
      label: 'Woke from sleep',
      hint: 'Normal wake-up from power saving.',
      problem: false,
    );
  }
  if (r.contains('hardware watchdog')) {
    return (
      label: 'Froze and recovered',
      hint:
          'The device stopped responding and reset itself. Often a power-supply or wiring problem.',
      problem: true,
    );
  }
  if (r.contains('watchdog')) {
    return (
      label: 'Stalled and recovered',
      hint: 'The firmware got stuck and reset itself.',
      problem: true,
    );
  }
  if (r.contains('exception')) {
    return (
      label: 'Crashed and recovered',
      hint: 'The firmware hit an error and restarted.',
      problem: true,
    );
  }
  return (
    label: raw,
    hint: 'Reported by the device on its last start.',
    problem: false,
  );
}

/* --------------------------------- Screen --------------------------------- */

class DeviceHealthScreen extends ConsumerWidget {
  const DeviceHealthScreen({super.key, required this.device});

  final KnownDevice device;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final health = ref.watch(deviceHealthProvider(device.deviceId));
    return Scaffold(
      appBar: AppBar(title: const Text('Device health')),
      body: RefreshIndicator(
        onRefresh: () =>
            ref.refresh(deviceHealthProvider(device.deviceId).future),
        child: switch (health) {
          AsyncValue(:final value?) => _HealthBody(
            device: device,
            health: value,
          ),
          AsyncValue(:final error?) => ListView(
            padding: const EdgeInsets.all(Spacing.lg),
            children: [
              const SizedBox(height: Spacing.xl),
              Icon(
                Icons.cloud_off_rounded,
                size: 48,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(height: Spacing.md),
              Text(
                friendlyErrorMessage(error, 'Loading health'),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: Spacing.md),
              Center(
                child: FilledButton.tonal(
                  onPressed: () =>
                      ref.invalidate(deviceHealthProvider(device.deviceId)),
                  child: const Text('Try again'),
                ),
              ),
            ],
          ),
          _ => const Center(child: CircularProgressIndicator()),
        },
      ),
    );
  }
}

class _HealthBody extends StatelessWidget {
  const _HealthBody({required this.device, required this.health});

  final KnownDevice device;
  final DeviceHealth health;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final signal = health.rssi == null ? null : signalQuality(health.rssi!);
    final reset = health.resetReason == null
        ? null
        : resetReasonInfo(health.resetReason!);
    final tips = <String>[
      if (!health.online)
        'Check the device has power and that your Wi-Fi is working. It reconnects on its own.',
      if (signal?.weak ?? false) signal!.hint,
      if (reset?.problem ?? false) reset!.hint,
    ];
    final statusColor = health.online ? colorScheme.primary : colorScheme.error;

    return ListView(
      padding: const EdgeInsets.only(top: Spacing.sm, bottom: Spacing.lg),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(Spacing.md),
            child: Row(
              children: [
                Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(
                    color: statusColor.withValues(alpha: 0.14),
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    health.online
                        ? Icons.check_circle_rounded
                        : Icons.cloud_off_rounded,
                    color: statusColor,
                    size: 28,
                  ),
                ),
                const SizedBox(width: Spacing.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        device.friendlyName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        health.online
                            ? health.lastConnectedAt == null
                                  ? 'Online'
                                  : 'Online · connected ${_ago(health.lastConnectedAt!)}'
                            : health.offlineSince == null
                            ? 'Offline'
                            : 'Offline for ${formatDuration(DateTime.now().difference(health.offlineSince!))}',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: statusColor,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        if (tips.isNotEmpty)
          Card(
            color: colorScheme.errorContainer.withValues(alpha: 0.35),
            child: Padding(
              padding: const EdgeInsets.all(Spacing.md),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.lightbulb_outline_rounded,
                    color: colorScheme.error,
                  ),
                  const SizedBox(width: Spacing.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (final tip in tips)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: Text(tip),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        if (!health.hasDiagnostics)
          const Card(
            child: ListTile(
              leading: Icon(Icons.system_update_alt_rounded),
              title: Text('No details from this device'),
              subtitle: Text(
                'Update its firmware to see signal, memory and restart info.',
              ),
            ),
          )
        else
          Card(
            child: Column(
              children: [
                if (signal != null)
                  _Metric(
                    icon: _signalIcon(signal.bars),
                    title: 'Wi-Fi signal',
                    value: '${signal.label} · ${health.rssi} dBm',
                    hint: health.online
                        ? '${signal.hint} Measured when it connected.'
                        : 'Measured when it last connected.',
                    warn: signal.weak,
                  ),
                if (health.uptimeS != null)
                  _Metric(
                    icon: Icons.timer_outlined,
                    title: 'Running for',
                    value: formatDuration(Duration(seconds: health.uptimeS!)),
                    hint: 'Time since the device last started.',
                  ),
                if (reset != null)
                  _Metric(
                    icon: reset.problem
                        ? Icons.report_problem_outlined
                        : Icons.restart_alt_rounded,
                    title: 'Last restart',
                    value: reset.label,
                    hint: reset.hint,
                    warn: reset.problem,
                  ),
                if (health.freeHeap != null)
                  _Metric(
                    icon: Icons.memory_rounded,
                    title: 'Free memory',
                    value: '${(health.freeHeap! / 1024).toStringAsFixed(1)} KB',
                    hint: health.freeHeap! < 8000
                        ? 'Low — may cause restarts.'
                        : 'Healthy.',
                    warn: health.freeHeap! < 8000,
                  ),
                if (health.firmware != null)
                  _Metric(
                    icon: Icons.developer_board_outlined,
                    title: 'Firmware',
                    value: health.firmware!,
                  ),
              ],
            ),
          ),
        Card(
          child: Column(
            children: [
              if (health.lastConnectedAt != null)
                _Metric(
                  icon: Icons.link_rounded,
                  title: 'Last connected',
                  value:
                      '${MaterialLocalizations.of(context).formatMediumDate(health.lastConnectedAt!)} '
                      '${TimeOfDay.fromDateTime(health.lastConnectedAt!).format(context)}',
                ),
              if (health.addedAt != null)
                _Metric(
                  icon: Icons.event_available_outlined,
                  title: 'Added',
                  value: MaterialLocalizations.of(
                    context,
                  ).formatMediumDate(health.addedAt!),
                ),
              _Metric(
                icon: Icons.fingerprint_rounded,
                title: 'Device ID',
                value: device.deviceId,
              ),
            ],
          ),
        ),
      ],
    );
  }

  static IconData _signalIcon(int bars) => switch (bars) {
    4 => Icons.signal_wifi_4_bar_rounded,
    3 => Icons.network_wifi_3_bar_rounded,
    2 => Icons.network_wifi_2_bar_rounded,
    _ => Icons.network_wifi_1_bar_rounded,
  };
}

class _Metric extends StatelessWidget {
  const _Metric({
    required this.icon,
    required this.title,
    required this.value,
    this.hint,
    this.warn = false,
  });

  final IconData icon;
  final String title;
  final String value;
  final String? hint;
  final bool warn;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final tint = warn ? colorScheme.error : colorScheme.primary;
    // Title + value share the top line; the hint gets the full width below
    // (a ListTile trailing value squeezes long hints into a thin column).
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: Spacing.md,
        vertical: Spacing.sm + 2,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 34,
            height: 34,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: tint.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, size: 18, color: tint),
          ),
          const SizedBox(width: Spacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Text(title, style: theme.textTheme.bodyLarge),
                    const SizedBox(width: Spacing.sm),
                    Expanded(
                      child: Text(
                        value,
                        textAlign: TextAlign.end,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w700,
                          color: warn ? colorScheme.error : null,
                        ),
                      ),
                    ),
                  ],
                ),
                if (hint != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    hint!,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
