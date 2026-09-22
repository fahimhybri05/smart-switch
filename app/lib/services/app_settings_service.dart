import 'package:flutter/material.dart';
import 'package:hive_ce_flutter/hive_ce_flutter.dart';

const _boxName = 'app_settings';
const _themeModeKey = 'theme_mode';
const _backendUrlKey = 'backend_url';
const _defaultBackendUrl = 'https://api.smart-switch.shop';

/// Local, device-only app preferences (spec: visual overhaul pass) — today
/// just the theme mode. Same open/init pattern as
/// device_registry_service.dart / group_service.dart.
class AppSettingsService {
  Box? _box;

  Future<void> init() async {
    _box = await Hive.openBox(_boxName);
  }

  /// Closes the underlying box — used by headless-isolate callers
  /// (background_monitor_service.dart, widget_service.dart) that only need
  /// this service for one short-lived read, to shrink the window where
  /// that isolate and the main app isolate could both have this same Hive
  /// box open at once (see those files' doc comments for the full
  /// unsafe-multi-isolate-access context). Not called by the long-lived
  /// main-isolate instance behind `appSettingsServiceProvider`, which
  /// intentionally keeps its box open for the app's whole lifetime.
  Future<void> close() async {
    await _box?.close();
    _box = null;
  }

  Box get _requireBox {
    final box = _box;
    if (box == null) {
      throw StateError('AppSettingsService.init() must be called before use');
    }
    return box;
  }

  ThemeMode getThemeMode() {
    final raw = _requireBox.get(_themeModeKey) as String?;
    return switch (raw) {
      'light' => ThemeMode.light,
      'dark' => ThemeMode.dark,
      _ => ThemeMode.system,
    };
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    await _requireBox.put(_themeModeKey, mode.name);
  }

  /// The user's self-hosted backend base URL (e.g. `http://192.168.1.10:3000`)
  /// — defaults to the current local backend while still allowing a saved
  /// custom backend in Settings.
  String? getBackendUrl() {
    final raw = _requireBox.get(_backendUrlKey) as String?;
    return (raw == null || raw.isEmpty) ? _defaultBackendUrl : raw;
  }

  Future<void> setBackendUrl(String url) async {
    await _requireBox.put(_backendUrlKey, url.trim());
  }
}
