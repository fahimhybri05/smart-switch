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
// Both home-screen widgets render from the same pinned_switches data.
const _androidWidgetNames = ['SmartSwitchWidgetProvider', 'SingleSwitchWidgetProvider'];

Future<void> _updateAllWidgets() async {
  for (final name in _androidWidgetNames) {
    await HomeWidget.updateWidget(androidName: name);
  }
}
// The grid widget shows the first 4; the rest are for single-switch widgets.
const maxPinnedSwitches = 8;

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
    await _updateAllWidgets();
    return;
  }

  final settings = AppSettingsService();
  await settings.init();
  final backendUrl = settings.getBackendUrl();
  await settings.close();

  final lastStatesBox = await Hive.openBox(_lastStatesBoxName);
  final entries = <Map<String, dynamic>>[];
  // One live fetch per device (not per pinned switch), so a toggle made in
  // the app or by a schedule shows up here instead of the monitor's cache.
  final liveByDevice = <String, List<ChannelState>?>{};
  try {
    for (final p in pinned) {
      if (!liveByDevice.containsKey(p.deviceId)) {
        final live = await viaLocalOrCloud(
          deviceId: p.deviceId,
          lastKnownIp: p.lastKnownIp,
          backendUrl: backendUrl,
          call: (client) => client.getChannels(),
        );
        liveByDevice[p.deviceId] = live;
        if (live != null) {
          await _cacheStates(lastStatesBox, p.deviceId, {
            for (final c in live) c.channelIdx: c.state.toJson(),
          });
        }
      }
      entries.add({
        ...p.toJson(),
        'state': _resolveState(p, liveByDevice[p.deviceId], lastStatesBox),
      });
    }
  } finally {
    await lastStatesBox.close();
  }

  await HomeWidget.saveWidgetData<String>(
    'pinned_switches',
    jsonEncode(entries),
  );
  await _updateAllWidgets();
}

String _resolveState(
  PinnedSwitch p,
  List<ChannelState>? live,
  Box lastStatesBox,
) {
  if (live != null) {
    for (final c in live) {
      if (c.channelIdx == p.channelIdx) return c.state.toJson();
    }
  }
  final cached = lastStatesBox.get(p.deviceId) as Map?;
  for (final s in (cached?['states'] as List?)?.cast<Map>() ?? const <Map>[]) {
    if (s['channel_idx'] == p.channelIdx) return s['state'] as String;
  }
  // Neither a live fetch nor the cache had an answer — OFF only as the very
  // first-ever render's default.
  return 'OFF';
}

/// Merges [states] (channel_idx -> "ON"/"OFF") into the shared
/// `last_states` cache the background monitor also reads, so its next run
/// doesn't report the widget's own toggle as an external change.
Future<void> _cacheStates(Box box, String deviceId, Map<int, String> states) async {
  final prev = box.get(deviceId) as Map?;
  final merged = <int, String>{
    for (final s in (prev?['states'] as List?)?.cast<Map>() ?? const <Map>[])
      s['channel_idx'] as int: s['state'] as String,
    ...states,
  };
  await box.put(deviceId, {
    'reachable': true,
    'states': [
      for (final e in merged.entries) {'channel_idx': e.key, 'state': e.value},
    ],
  });
}

/// Runs on tap from the widget — a headless isolate with no access to the
/// running app's ProviderContainer, so it talks to the device directly.
// Taps that land in the same background isolate share Hive box instances;
// running them one at a time stops one tap closing a box another is using.
Future<void> _tapQueue = Future.value();

@pragma('vm:entry-point')
Future<void> widgetInteractionCallback(Uri? uri) {
  final next = _tapQueue.then((_) => _handleWidgetTap(uri));
  _tapQueue = next.catchError((_) {});
  return next;
}

Future<void> _handleWidgetTap(Uri? uri) async {
  if (uri == null || uri.host != 'toggle') {
    return;
  }

  final deviceId = uri.queryParameters['device_id'];
  // The Android widget sends an empty ip for a cloud-only device.
  final rawIp = uri.queryParameters['ip'];
  final ip = (rawIp == null || rawIp.isEmpty) ? null : rawIp;
  final channelIdx = int.tryParse(uri.queryParameters['channel_idx'] ?? '');
  final currentState = uri.queryParameters['current_state'];
  if (deviceId == null || channelIdx == null) {
    return;
  }

  final newState = currentState == 'ON'
      ? ChannelPowerState.off
      : ChannelPowerState.on;

  // Flip the tile right away so the tap feels instant; reverted below if
  // the command doesn't go through.
  await _setWidgetTileState(deviceId, channelIdx, newState.toJson());

  try {
    // This runs in a fresh headless isolate: main.dart's Hive.initFlutter()
    // never ran here, and every box open below would throw without it.
    await Hive.initFlutter();

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
      debugPrint('widget toggle failed: $deviceId ch$channelIdx unreachable (local+cloud)');
      await _setWidgetTileState(deviceId, channelIdx, currentState ?? 'OFF');
      return;
    }

    // Record the new state so the redraw (and the next tap's current_state)
    // reflect it even if the live re-fetch below fails.
    final box = await Hive.openBox(_lastStatesBoxName);
    try {
      await _cacheStates(box, deviceId, {channelIdx: newState.toJson()});
    } finally {
      await box.close();
    }
    await refreshWidgetStorage();
  } catch (e, st) {
    debugPrint('widget toggle error: $e\n$st');
    await _setWidgetTileState(deviceId, channelIdx, currentState ?? 'OFF');
  }
}

/// Rewrites one switch's state in the widget's own data and redraws, without
/// touching the network or Hive — used for the instant tap feedback.
Future<void> _setWidgetTileState(String deviceId, int channelIdx, String state) async {
  try {
    final raw = await HomeWidget.getWidgetData<String>('pinned_switches');
    if (raw == null) return;
    final entries = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
    for (final e in entries) {
      if (e['device_id'] == deviceId && e['channel_idx'] == channelIdx) {
        e['state'] = state;
      }
    }
    await HomeWidget.saveWidgetData<String>('pinned_switches', jsonEncode(entries));
    await _updateAllWidgets();
  } catch (_) {}
}
