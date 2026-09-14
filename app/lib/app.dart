import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers/service_providers.dart';
import 'routing/app_routes.dart';
import 'screens/auth/auth_screen.dart';
import 'screens/home_shell.dart';
import 'theme/app_theme.dart';

class SmartSwitchApp extends ConsumerWidget {
  const SmartSwitchApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
