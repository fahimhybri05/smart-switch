import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:hive_ce_flutter/hive_ce_flutter.dart';
import 'package:workmanager/workmanager.dart';

import '../models/local/known_device.dart';
import 'app_settings_service.dart';
import 'device_registry_service.dart';
import 'isolate_device_relay.dart';
import 'widget_service.dart';

const _lastStatesBoxName = 'last_states';
const _monitorTaskName = 'smart_switch_monitor';
const _monitorUniqueName = 'smart_switch_monitor_periodic';

final _notifications = FlutterLocalNotificationsPlugin();

/// Requests Android 13+'s runtime POST_NOTIFICATIONS permission — must be
/// called from the foreground app (a background WorkManager isolate can't
/// prompt the user), so [initializeBackgroundMonitor]'s notifications would
/// otherwise silently never show on first install.
Future<void> requestNotificationPermission() async {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) {
    return;
  }
  const androidSettings = AndroidInitializationSettings('@mipmap/ic_launcher');
  await _notifications.initialize(
    settings: const InitializationSettings(android: androidSettings),
  );
  await _notifications
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >()
      ?.requestNotificationsPermission();
}

/// Registers the ~15min (Android WorkManager's practical floor) background
/// poll that powers offline/state-change notifications while the app is
/// closed. Android-only — see docs/plan.md (iOS background execution is
/// unreliable under this model and untestable in this environment).
Future<void> initializeBackgroundMonitor() async {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) {
    return;
  }
  await Workmanager().initialize(backgroundMonitorCallbackDispatcher);
  await Workmanager().registerPeriodicTask(
    _monitorUniqueName,
    _monitorTaskName,
    frequency: const Duration(minutes: 15),
    constraints: Constraints(networkType: NetworkType.connected),
  );
}

/// Runs in a separate headless Flutter engine spun up by Android
/// WorkManager — has no access to the running app's widget tree or
/// ProviderContainer, so it opens its own Hive instance and talks to
/// devices directly over HTTP.
@pragma('vm:entry-point')
void backgroundMonitorCallbackDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    try {
      await _runMonitorPass();
    } catch (_) {
      // Best-effort background pass — never let a transient failure (one
      // unreachable device, a Hive hiccup) crash the WorkManager task.
    }
    return true;
  });
}

Future<void> _runMonitorPass() async {
  await Hive.initFlutter();
  final registry = DeviceRegistryService();
  await registry.init();
  final lastStatesBox = await Hive.openBox(_lastStatesBoxName);
  final settings = AppSettingsService();
  await settings.init();
  final backendUrl = settings.getBackendUrl();

  const androidSettings = AndroidInitializationSettings('@mipmap/ic_launcher');
  await _notifications.initialize(
    settings: const InitializationSettings(android: androidSettings),
  );

  final devices = await registry.getAll();
  for (final device in devices) {
    await _checkDevice(device, lastStatesBox, backendUrl);
  }

  await refreshWidgetStorage();
}

Future<void> _checkDevice(
  KnownDevice device,
  Box lastStatesBox,
  String? backendUrl,
) async {
  final prev = lastStatesBox.get(device.deviceId) as Map?;
  final wasReachable = prev == null || prev['reachable'] != false;

  // Local LAN first, falling back to the cloud relay if the device is
  // claimed+logged-in but not reachable on this network right now (e.g.
  // its IP changed, or this phone/tablet is elsewhere) — closes the gap
  // where a cloud-claimed device was simply invisible to this monitor.
  // See docs/plan.md's cloud-aware widget relay section.
  final channels = await viaLocalOrCloud(
    deviceId: device.deviceId,
    lastKnownIp: device.lastKnownIp,
    backendUrl: backendUrl,
    call: (client) => client.getChannels(),
  );

  if (channels == null) {
    if (wasReachable) {
      await _notify(
        device.deviceId.hashCode,
        '${device.friendlyName} offline',
        'Device is not responding.',
      );
    }
    await lastStatesBox.put(device.deviceId, {
      'reachable': false,
      'states': prev?['states'],
    });
    return;
  }

  if (!wasReachable) {
    await _notify(
      device.deviceId.hashCode,
      '${device.friendlyName} back online',
      'Device is responding again.',
    );
  }

  final prevStates = (prev?['states'] as List?)?.cast<Map>() ?? const [];
  final prevByChannel = {
    for (final s in prevStates) s['channel_idx'] as int: s['state'] as String,
  };

  for (final ch in channels) {
    final prevState = prevByChannel[ch.channelIdx];
    final newState = ch.state.toJson();
    if (prevState != null && prevState != newState) {
      await _notify(
        Object.hash(device.deviceId, ch.channelIdx),
        device.friendlyName,
        'Channel ${ch.channelIdx} turned $newState',
      );
    }
  }

  await lastStatesBox.put(device.deviceId, {
    'reachable': true,
    'states': channels
        .map((c) => {'channel_idx': c.channelIdx, 'state': c.state.toJson()})
        .toList(),
  });
}

Future<void> _notify(int id, String title, String body) async {
  const androidDetails = AndroidNotificationDetails(
    'smart_switch_monitor',
    'Device monitor',
    channelDescription:
        'Schedule/state changes detected while the app is closed',
  );
  await _notifications.show(
    id: id,
    title: title,
    body: body,
    notificationDetails: const NotificationDetails(android: androidDetails),
  );
}
