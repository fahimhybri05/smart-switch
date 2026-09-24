import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'models/device/channel_state.dart';
import 'models/local/known_device.dart';
import 'providers/service_providers.dart';
import 'routing/app_routes.dart';
import 'screens/auth/auth_screen.dart';
import 'screens/home_shell.dart';
import 'screens/lock/app_lock.dart';
import 'screens/shared/friendly_error.dart';
import 'services/app_shortcuts.dart';
import 'services/widget_service.dart';
import 'theme/app_theme.dart';

class SmartSwitchApp extends ConsumerStatefulWidget {
  const SmartSwitchApp({super.key});

  @override
  ConsumerState<SmartSwitchApp> createState() => _SmartSwitchAppState();
}

/// The app's own `WidgetsBindingObserver` — there wasn't one anywhere
/// before this. Its only job is re-pushing every known device's current
/// UTC offset when the app comes back to the foreground, so a device's
/// clock offset doesn't go stale across a DST transition while the phone
/// sits backgrounded (see [pushTimezoneToKnownDevices] / Task D in
/// docs/plan.md — login already covers the other trigger, in
/// [AuthNotifier.login]/`_persist`).
class _SmartSwitchAppState extends ConsumerState<SmartSwitchApp>
    with WidgetsBindingObserver {
  final _messengerKey = GlobalKey<ScaffoldMessengerState>();

  /// A shortcut tapped while the lock screen was up — runs after unlock.
  ({String deviceId, int channelIdx})? _pendingShortcut;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(initAppShortcuts(_onShortcut));
  }

  void _onShortcut(String deviceId, int channelIdx) {
    if (ref.read(appLockedProvider)) {
      _pendingShortcut = (deviceId: deviceId, channelIdx: channelIdx);
      return;
    }
    unawaited(_runShortcut(deviceId, channelIdx));
  }

  void _toast(String message) => _messengerKey.currentState
    ?..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));

  /// Toggles one pinned switch from an app-icon shortcut, through the same
  /// client (local LAN first, cloud fallback) the in-app tiles use.
  Future<void> _runShortcut(String deviceId, int channelIdx) async {
    if (ref.read(authProvider) == null) {
      _toast('Sign in first to use shortcuts.');
      return;
    }
    // Known devices load asynchronously on a cold start.
    KnownDevice? device;
    for (var i = 0; i < 25 && device == null; i++) {
      device = ref
          .read(knownDevicesProvider)
          .where((d) => d.deviceId == deviceId)
          .firstOrNull;
      if (device == null) {
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
    }
    if (device == null) {
      _toast('That switch is no longer on this phone.');
      return;
    }
    final client = ref.read(activeDeviceApiClientProvider(device));
    try {
      final channels = await client.getChannels();
      final current = channels
          .where((c) => c.channelIdx == channelIdx)
          .firstOrNull;
      final target = current?.state == ChannelPowerState.on
          ? ChannelPowerState.off
          : ChannelPowerState.on;
      ref
          .read(channelOverrideProvider.notifier)
          .set(device.deviceId, channelIdx, target);
      await client.setChannelState(channelIdx, target);
      final name = (await getPinnedSwitches())
          .where((p) => p.deviceId == deviceId && p.channelIdx == channelIdx)
          .firstOrNull
          ?.switchName;
      _toast(
        '${name ?? 'Switch'} turned ${target == ChannelPowerState.on ? 'on' : 'off'}',
      );
      unawaited(refreshWidgetStorage());
    } catch (e) {
      _toast(friendlyErrorMessage(e, 'Toggle'));
    } finally {
      ref.invalidate(channelStatesProvider(device));
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(pushTimezoneToKnownDevicesFromWidget(ref));
      // The OS may have silently dropped the WS socket while backgrounded;
      // don't wait out whatever's left of the timer-driven backoff (up to
      // 30s) before reconnecting — see BackendWsClient.reconnectNow.
      ref.read(backendWsClientProvider)?.reconnectNow();
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(appLockedProvider, (_, locked) {
      final pending = _pendingShortcut;
      if (!locked && pending != null) {
        _pendingShortcut = null;
        unawaited(_runShortcut(pending.deviceId, pending.channelIdx));
      }
    });
    final routes = Map<String, WidgetBuilder>.from(AppRoutes.routes)
      ..remove(AppRoutes.home);

    return MaterialApp(
      title: 'Smart Control',
      scaffoldMessengerKey: _messengerKey,
      theme: lightTheme,
      darkTheme: darkTheme,
      themeMode: ref.watch(themeModeProvider),
      home: ref.watch(authProvider) == null
          ? const AuthScreen(isSignup: false)
          : const HomeShell(),
      routes: routes,
      builder: (context, child) =>
          AppLockGate(child: child ?? const SizedBox.shrink()),
    );
  }
}
