import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';

import 'package:smart_switch/providers/service_providers.dart';
import 'package:smart_switch/services/app_settings_service.dart';
import 'package:smart_switch/services/backend/auth_session_service.dart';

/// Minimal fakes — same pattern as test/widget_test.dart. Both default to
/// "logged out, no backend configured" so `_doSyncClaimedDevicesFromBackend`
/// short-circuits before touching the network, keeping these tests fast and
/// offline.
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

ProviderContainer _buildContainer() {
  final container = ProviderContainer(
    overrides: [
      appSettingsServiceProvider.overrideWithValue(_FakeAppSettingsService()),
      authSessionServiceProvider.overrideWithValue(_FakeAuthSessionService()),
    ],
  );
  return container;
}

void main() {
  group('DeviceSyncNotifier', () {
    test('build() starts idle (data(null)), not an error', () {
      final container = _buildContainer();
      addTearDown(container.dispose);

      expect(
        container.read(deviceSyncStatusProvider),
        const AsyncValue<void>.data(null),
      );
    });

    test('run() goes loading -> data on a successful task', () async {
      final container = _buildContainer();
      addTearDown(container.dispose);
      final notifier = container.read(deviceSyncStatusProvider.notifier);

      final pending = notifier.run(() async {});
      // Synchronously set before the first await inside run() suspends.
      expect(container.read(deviceSyncStatusProvider).isLoading, isTrue);

      await pending;
      expect(
        container.read(deviceSyncStatusProvider),
        const AsyncValue<void>.data(null),
      );
    });

    test('run() goes loading -> error on a failing task', () async {
      final container = _buildContainer();
      addTearDown(container.dispose);
      final notifier = container.read(deviceSyncStatusProvider.notifier);

      final pending = notifier.run(() async => throw Exception('boom'));
      expect(container.read(deviceSyncStatusProvider).isLoading, isTrue);

      await pending;
      final state = container.read(deviceSyncStatusProvider);
      expect(state.hasError, isTrue);
    });

    test(
      'retry() re-runs the real backend sync (not refreshAllDevices) and '
      'settles without error when logged out',
      () async {
        final container = _buildContainer();
        addTearDown(container.dispose);
        final notifier = container.read(deviceSyncStatusProvider.notifier);

        await notifier.retry();

        final state = container.read(deviceSyncStatusProvider);
        expect(state.hasError, isFalse);
        expect(state, const AsyncValue<void>.data(null));
      },
    );
  });
}
