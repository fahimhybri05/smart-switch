import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:hive_ce_flutter/hive_ce_flutter.dart';
import 'package:home_widget/home_widget.dart';

import '../models/device/channel_state.dart';
import '../models/local/pinned_switch.dart';
import 'app_settings_service.dart';
import 'isolate_device_relay.dart';

const _pinnedBoxName = 'pinned_switches';
// Shared with background_monitor_service.dart's per-device state cache —
// deliberately reused rather than a third Hive box (see docs/plan.md).
const _lastStatesBoxName = 'last_states';
const _androidWidgetName = 'SmartSwitchWidgetProvider';
const maxPinnedSwitches = 4;

bool get _widgetSupported =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

/// Registers the tap-to-toggle background callback. Android-only, no-op
/// elsewhere. Safe to call every app start (idempotent on the native side).
Future<void> initializeWidgetSupport() async {
  if (!_widgetSupported) {
    return;
  }
  await HomeWidget.registerInteractivityCallback(widgetInteractionCallback);
}

// Both this file's functions and widgetInteractionCallback below run (at
// least sometimes) in a headless isolate — a tapped home-screen widget, or
// via background_monitor_service.dart's WorkManager pass — that opens the
// SAME Hive boxes (`pinned_switches`, `last_states`, `app_settings`, and
// transitively `auth_session`) the main app isolate independently keeps
// open for its whole lifetime. Hive CE's own source documents this as
// unsafe (`HiveWarning.unsafeIsolate`: per-isolate box caches, possible
// state corruption). A full fix would route this through a platform
// channel back to the main isolate; out of scope for this pass. Mitigation
// applied throughout this file instead: open each box, do the one
// read/write, close it again immediately, rather than holding it open —
// shrinks (doesn't eliminate) the window where two isolates could have the
// same box open at once.

Future<List<PinnedSwitch>> getPinnedSwitches() async {
  final box = await Hive.openBox(_pinnedBoxName);
  try {
    final raw = (box.get('list') as List?) ?? const [];
    return raw
        .map(
          (e) => PinnedSwitch.fromJson(Map<String, dynamic>.from(e as Map)),
        )
        .toList();
  } finally {
    await box.close();
  }
}

Future<void> setPinnedSwitches(List<PinnedSwitch> pinned) async {
  final capped = pinned.take(maxPinnedSwitches).toList();
  final box = await Hive.openBox(_pinnedBoxName);
  try {
    await box.put('list', capped.map((p) => p.toJson()).toList());
  } finally {
    await box.close();
  }
  await refreshWidgetStorage();
}

/// Rebuilds the widget's persisted display data from the pinned list,
/// preferring App 4's cached `last_states` and falling back to one live
/// fetch per pinned device otherwise. Safe to call from the foreground app
/// or from the background monitor's isolate — both already open Hive (see
/// this file's top-of-file doc comment re: the unsafe-multi-isolate-access
/// mitigation applied here).
Future<void> refreshWidgetStorage() async {
  if (!_widgetSupported) {
    return;
  }

  final pinned = await getPinnedSwitches();
  if (pinned.isEmpty) {
    await HomeWidget.saveWidgetData<String>('pinned_switches', jsonEncode([]));
    await HomeWidget.updateWidget(androidName: _androidWidgetName);
    return;
  }

  final settings = AppSettingsService();
  await settings.init();
  final backendUrl = settings.getBackendUrl();
  await settings.close();

  final lastStatesBox = await Hive.openBox(_lastStatesBoxName);
  final entries = <Map<String, dynamic>>[];
  try {
    for (final p in pinned) {
      entries.add({
        ...p.toJson(),
        'state': await _resolveState(p, lastStatesBox, backendUrl),
      });
    }
  } finally {
    await lastStatesBox.close();
  }

  await HomeWidget.saveWidgetData<String>(
    'pinned_switches',
    jsonEncode(entries),
  );
  await HomeWidget.updateWidget(androidName: _androidWidgetName);
}

Future<String> _resolveState(
  PinnedSwitch p,
  Box lastStatesBox,
  String? backendUrl,
) async {
  final cached = lastStatesBox.get(p.deviceId) as Map?;
  final cachedStates = (cached?['states'] as List?)?.cast<Map>();
  String? cachedState;
  if (cachedStates != null) {
    for (final s in cachedStates) {
      if (s['channel_idx'] == p.channelIdx) {
        cachedState = s['state'] as String;
      }
    }
  }
  if (cachedState != null) {
    return cachedState;
  }

  final channels = await viaLocalOrCloud(
    deviceId: p.deviceId,
    lastKnownIp: p.lastKnownIp,
    backendUrl: backendUrl,
    call: (client) => client.getChannels(),
  );
  if (channels != null) {
    for (final c in channels) {
      if (c.channelIdx == p.channelIdx) {
        return c.state.toJson();
      }
    }
  }
  // Neither the cache nor a live fetch (local or cloud) had an answer —
  // show OFF only as the very first-ever render's default, never as a
  // silent overwrite of a state we actually knew a moment ago.
  return 'OFF';
}

/// Runs on tap from the widget — a headless isolate with no access to the
/// running app's ProviderContainer, so it talks to the device directly.
@pragma('vm:entry-point')
Future<void> widgetInteractionCallback(Uri? uri) async {
  if (uri == null || uri.host != 'toggle') {
    return;
  }

  final deviceId = uri.queryParameters['device_id'];
  final ip = uri.queryParameters['ip'];
  final channelIdx = int.tryParse(uri.queryParameters['channel_idx'] ?? '');
  final currentState = uri.queryParameters['current_state'];
  // ip is now optional — a claimed device this phone hasn't seen on the
  // LAN (or currently can't reach it) can still be toggled via the cloud
  // relay below. See docs/plan.md's cloud-aware widget relay section.
  if (deviceId == null || channelIdx == null) {
    return;
  }

  final newState = currentState == 'ON'
      ? ChannelPowerState.off
      : ChannelPowerState.on;

  final settings = AppSettingsService();
  await settings.init();
  final backendUrl = settings.getBackendUrl();
  await settings.close();

  final result = await viaLocalOrCloud(
    deviceId: deviceId,
    lastKnownIp: ip,
    backendUrl: backendUrl,
    call: (client) async {
      await client.setChannelState(channelIdx, newState);
      return true;
    },
  );
  if (result == null) {
    return; // leave the widget showing its last known state
  }

  await refreshWidgetStorage();
}
