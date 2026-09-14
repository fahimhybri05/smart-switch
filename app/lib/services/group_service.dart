import 'package:hive_ce_flutter/hive_ce_flutter.dart';

import '../models/local/switch_group.dart';

const _boxName = 'groups';

/// Local Hive cache of groups (spec §7's storage layer) — the backend is
/// now the source of truth (see docs/plan.md's account-wide sync section);
/// this box is only a read-through cache for offline viewing.
class GroupService {
  Box? _box;

  Future<void> init() async {
    _box = await Hive.openBox(_boxName);
  }

  Box get _requireBox {
    final box = _box;
    if (box == null) {
      throw StateError('GroupService.init() must be called before use');
    }
    return box;
  }

  Future<List<SwitchGroup>> getAll() async {
    return _requireBox.values
        .map((v) => SwitchGroup.fromJson(Map<String, dynamic>.from(v as Map)))
        .toList(growable: false);
  }

  Future<SwitchGroup?> get(String id) async {
    final raw = _requireBox.get(id);
    if (raw == null) {
      return null;
    }
    return SwitchGroup.fromJson(Map<String, dynamic>.from(raw as Map));
  }

  Future<void> upsert(SwitchGroup group) async {
    await _requireBox.put(group.id, group.toJson());
  }

  Future<void> remove(String id) async {
    await _requireBox.delete(id);
  }

  /// Replaces the entire cache with a fresh backend snapshot — used after
  /// every successful backend fetch so stale/deleted-elsewhere groups
  /// don't linger in the offline cache.
  Future<void> replaceAll(List<SwitchGroup> groups) async {
    await _requireBox.clear();
    for (final group in groups) {
      await _requireBox.put(group.id, group.toJson());
    }
  }
}
