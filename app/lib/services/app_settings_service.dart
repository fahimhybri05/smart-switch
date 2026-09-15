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
