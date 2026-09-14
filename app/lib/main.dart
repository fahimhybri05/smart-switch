import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:hive_ce_flutter/hive_ce_flutter.dart';

import 'app.dart';
import 'providers/service_providers.dart';
import 'services/background_monitor_service.dart';
import 'services/widget_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Hive.initFlutter();

  // Async pre-start init (open the Hive boxes) needs a container that
  // exists before runApp — build one by hand, then hand it to the widget
  // tree via UncontrolledProviderScope (the standard Riverpod pattern for
  // this, no codegen needed).
  final container = ProviderContainer();
  await container.read(deviceRegistryServiceProvider).init();
  await container.read(groupServiceProvider).init();
  await container.read(sceneServiceProvider).init();
  await container.read(appSettingsServiceProvider).init();
  await container.read(authSessionServiceProvider).init();

  // If a session was already persisted from a previous launch, sync this
  // account's claimed devices right away so they're there before the user
  // even looks — not just after their next login. Fire-and-forget: never
  // blocks startup (see syncClaimedDevicesFromBackend's own doc comment).
  container.read(startupDeviceSyncProvider);

  // Best-effort — Android-only, no-op elsewhere (see background_monitor_service.dart).
  try {
    await requestNotificationPermission();
    await initializeBackgroundMonitor();
    await initializeWidgetSupport();
  } catch (_) {}

  runApp(
    UncontrolledProviderScope(
      container: container,
      child: const SmartSwitchApp(),
    ),
  );
}
