import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers/service_providers.dart';
import 'routing/app_routes.dart';
import 'screens/auth/auth_screen.dart';
import 'screens/home_shell.dart';
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
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
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
    final routes = Map<String, WidgetBuilder>.from(AppRoutes.routes)
      ..remove(AppRoutes.home);

    return MaterialApp(
      title: 'Smart Switch',
      theme: lightTheme,
      darkTheme: darkTheme,
      themeMode: ref.watch(themeModeProvider),
      home: ref.watch(authProvider) == null
          ? const AuthScreen(isSignup: false)
          : const HomeShell(),
      routes: routes,
    );
  }
}
