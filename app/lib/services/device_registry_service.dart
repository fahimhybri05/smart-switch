import 'package:hive_ce_flutter/hive_ce_flutter.dart';

import '../models/local/known_device.dart';

const _boxName = 'known_devices';

/// CRUD over the local known-devices table (spec §4), backed by Hive.
class DeviceRegistryService {
  Box? _box;

  Future<void> init() async {
    _box = await Hive.openBox(_boxName);
  }

  Box get _requireBox {
    final box = _box;
    if (box == null) {
      throw StateError(
        'DeviceRegistryService.init() must be called before use',
      );
    }
    return box;
  }

  Future<List<KnownDevice>> getAll() async {
    return _requireBox.values
        .map((v) => KnownDevice.fromJson(Map<String, dynamic>.from(v as Map)))
        .toList(growable: false);
  }

  Future<KnownDevice?> get(String deviceId) async {
    final raw = _requireBox.get(deviceId);
    if (raw == null) {
      return null;
    }
    return KnownDevice.fromJson(Map<String, dynamic>.from(raw as Map));
  }

  Future<void> upsert(KnownDevice device) async {
    await _requireBox.put(device.deviceId, device.toJson());
  }

  Future<void> remove(String deviceId) async {
    await _requireBox.delete(deviceId);
  }

  /// Called after a successful poll/connect so the cached IP stays fresh —
  /// this is what makes the Tailscale remote-access fallback (spec §8) work.
  Future<void> updateLastKnownIp(String deviceId, String ip) async {
    final existing = await get(deviceId);
    if (existing == null) {
      return;
    }
    await upsert(existing.copyWith(lastKnownIp: ip));
  }
}
