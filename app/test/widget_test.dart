import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:smart_switch/app.dart';
import 'package:smart_switch/models/local/known_device.dart';
import 'package:smart_switch/models/local/switch_group.dart';
import 'package:smart_switch/providers/service_providers.dart';
import 'package:smart_switch/services/app_settings_service.dart';
import 'package:smart_switch/services/backend/auth_session_service.dart';
import 'package:smart_switch/services/device_registry_service.dart';
import 'package:smart_switch/services/group_service.dart';

/// In-memory fakes — real Hive I/O is verified separately (it works fine
/// outside a widget-pumped frame; `hive_ce`'s isolate-based backend hangs
/// specifically under flutter_test's widget binding, a known category of
/// issue unrelated to real app behavior on a real engine). A widget smoke
/// test should fake the data layer anyway rather than hit real storage.
class _FakeDeviceRegistryService implements DeviceRegistryService {
  @override
  Future<void> init() async {}
  @override
  Future<List<KnownDevice>> getAll() async => const [];
  @override
  Future<KnownDevice?> get(String deviceId) async => null;
  @override
  Future<void> upsert(KnownDevice device) async {}
  @override
  Future<void> remove(String deviceId) async {}
  @override
  Future<void> updateLastKnownIp(String deviceId, String ip) async {}
  @override
  Future<void> close() async {}
}

class _FakeGroupService implements GroupService {
  @override
  Future<void> init() async {}
  @override
  Future<List<SwitchGroup>> getAll() async => const [];
  @override
  Future<SwitchGroup?> get(String id) async => null;
  @override
  Future<void> upsert(SwitchGroup group) async {}
  @override
  Future<void> remove(String id) async {}
  @override
  Future<void> replaceAll(List<SwitchGroup> groups) async {}
}

class _FakeAppSettingsService implements AppSettingsService {
  @override
  Future<void> init() async {}
  @override
  ThemeMode getThemeMode() => ThemeMode.system;
  @override
  Future<void> setThemeMode(ThemeMode mode) async {}
  @override
  String? getBackendUrl() => null;
  @override
  Future<void> setBackendUrl(String url) async {}
  @override
  Future<void> close() async {}
  @override
  bool getAppLockEnabled() => false;
  @override
  Future<void> setAppLockEnabled(bool enabled) async {}
  @override
  int getAppLockTimeoutSeconds() => 60;
  @override
  Future<void> setAppLockTimeoutSeconds(int seconds) async {}
}

class _FakeAuthSessionService implements AuthSessionService {
  @override
  Future<void> init() async {}

  @override
  ({String accessToken, String refreshToken, String email})? getSession() =>
      null;

  @override
  Future<void> saveSession({
    required String accessToken,
    required String refreshToken,
    required String email,
  }) async {}

  @override
  Future<void> updateTokens({
    required String accessToken,
    required String refreshToken,
  }) async {}

  @override
  Future<void> clear() async {}
}

void main() {
  testWidgets('Signed-out app opens login screen', (WidgetTester tester) async {
    final container = ProviderContainer(
      overrides: [
        deviceRegistryServiceProvider.overrideWithValue(
          _FakeDeviceRegistryService(),
        ),
        groupServiceProvider.overrideWithValue(_FakeGroupService()),
        appSettingsServiceProvider.overrideWithValue(_FakeAppSettingsService()),
        authSessionServiceProvider.overrideWithValue(_FakeAuthSessionService()),
      ],
    );
    addTearDown(container.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const SmartSwitchApp(),
      ),
    );
    // pumpAndSettle (not a single pump) — the nav icons now carry a one-shot
    // flutter_animate entrance animation that must finish before the test
    // ends, or its Timer outlives the disposed widget tree.
    await tester.pumpAndSettle();

    expect(find.text('Log in'), findsWidgets);
    expect(find.text('Email address'), findsOneWidget);
    expect(find.text('Password'), findsOneWidget);
  });
}
