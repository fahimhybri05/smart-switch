import 'package:flutter/material.dart';

import '../screens/activity/activity_screen.dart';
import '../screens/auth/auth_screen.dart';
import '../screens/automations/automations_screen.dart';
import '../screens/home_shell.dart';
import '../screens/household/household_screen.dart';
import '../screens/onboarding/add_device_wizard_screen.dart';
import '../screens/provisioning/provisioning_wizard_screen.dart';
import '../screens/scenes/scenes_screen.dart';
import '../screens/scan/scan_devices_screen.dart';
import '../screens/settings/settings_screen.dart';
import '../screens/usage/usage_screen.dart';

abstract final class AppRoutes {
  static const home = '/';
  static const settings = '/settings';
  static const addDevice = '/add-device';
  static const scanDevices = '/scan-devices';
  static const provisioning = '/provisioning';
  static const login = '/login';
  static const signup = '/signup';
  static const household = '/household';
  static const activity = '/activity';
  static const automations = '/automations';
  static const scenes = '/scenes';
  static const usage = '/usage';

  static final Map<String, WidgetBuilder> routes = {
    home: (context) => const HomeShell(),
    settings: (context) => const SettingsScreen(),
    addDevice: (context) => const AddDeviceWizardScreen(),
    scanDevices: (context) => const ScanDevicesScreen(),
    household: (context) => const HouseholdScreen(),
    activity: (context) => const ActivityScreen(),
    automations: (context) => const AutomationsScreen(),
    scenes: (context) => const ScenesScreen(),
    usage: (context) => const UsageScreen(),
    // Kept as "Advanced provisioning" (reconfigure-WiFi + troubleshooting),
    // reachable from Settings — the guided QR wizard above is now the
    // primary "+ Add Device" entry point. See docs/plan.md.
    provisioning: (context) => const ProvisioningWizardScreen(),
    login: (context) => const AuthScreen(isSignup: false),
    signup: (context) => const AuthScreen(isSignup: true),
  };
}
