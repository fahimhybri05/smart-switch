import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/known_device.dart';
import '../../models/local/scene.dart';
import '../../providers/service_providers.dart';
import '../shared/friendly_error.dart';

/// Maps the contract's scene icon names (see [SceneIcons]) to Material
/// icons; unknown/null falls back to a generic sparkle.
IconData sceneIconData(String? icon) => switch (icon) {
  'moon' => Icons.bedtime_rounded,
  'sun' => Icons.wb_sunny_rounded,
  'home' => Icons.home_rounded,
  'away' => Icons.directions_walk_rounded,
  'movie' => Icons.movie_rounded,
  'power' => Icons.power_settings_new_rounded,
  'leaf' => Icons.eco_rounded,
  'droplet' => Icons.water_drop_rounded,
  _ => Icons.auto_awesome_rounded,
};

String sceneIconLabel(String icon) => switch (icon) {
  'moon' => 'Night',
  'sun' => 'Morning',
  'home' => 'Home',
  'away' => 'Away',
  'movie' => 'Movie',
  'power' => 'Power',
  'leaf' => 'Eco',
  'droplet' => 'Water',
  _ => icon,
};

/// Runs [scene] on the backend (`POST /scenes/:id/run`) with haptic
/// feedback and a result snackbar ("Night: 5 of 6 done", plus one line per
/// failed action). Shared by the Home scenes row and the Scenes screen.
Future<void> runSceneWithFeedback(
  BuildContext context,
  WidgetRef ref,
  Scene scene,
) async {
  HapticFeedback.mediumImpact();
  final messenger = ScaffoldMessenger.of(context);
  final devices = ref.read(knownDevicesProvider);
  try {
    final summary = await ref.read(scenesProvider.notifier).run(scene.id);
    // Tiles would catch up via WS push anyway; this makes it immediate.
    for (final device in devices) {
      if (summary.results.any((r) => r.deviceId == device.deviceId)) {
        ref.invalidate(channelStatesProvider(device));
      }
    }
    final failures = summary.failures;
    final headline = '${scene.name}: ${summary.succeeded} of '
        '${summary.total} done';
    final lines = [
      headline,
      for (final f in failures.take(4))
        '• ${_switchLabel(ref, devices, f.deviceId, f.channelIdx)} — '
            '${_failureText(f)}',
      if (failures.length > 4) '• and ${failures.length - 4} more',
    ];
    if (failures.isEmpty) {
      HapticFeedback.lightImpact();
    } else {
      HapticFeedback.heavyImpact();
    }
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(lines.join('\n')),
          duration: Duration(seconds: failures.isEmpty ? 3 : 6),
        ),
      );
  } catch (e) {
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(
            '${scene.name}: ${friendlyErrorMessage(e, 'Running the scene')}',
          ),
        ),
      );
  }
}

String _failureText(SceneActionResult result) =>
    friendlyCommandError(result.error, result.retryAfterSeconds) ??
    switch (result.error) {
      'device_offline' => 'device offline',
      'device_timeout' => 'device didn\'t respond',
      null => 'failed',
      final code => code.replaceAll('_', ' '),
    };

/// Best-effort human name for an action's switch: its configured name when
/// the device's config is already loaded, else `Switch N on <device name>`.
String _switchLabel(
  WidgetRef ref,
  List<KnownDevice> devices,
  String deviceId,
  int channelIdx,
) {
  for (final device in devices) {
    if (device.deviceId != deviceId) continue;
    final config = ref.read(deviceConfigProvider(device)).asData?.value;
    for (final sw in config?.switches ?? const []) {
      if (sw.channelIdx == channelIdx) return sw.name;
    }
    return 'Switch ${channelIdx + 1} on ${device.friendlyName}';
  }
  return 'Switch ${channelIdx + 1}';
}
