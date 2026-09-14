import 'package:hive_ce_flutter/hive_ce_flutter.dart';

import '../models/local/smart_scene.dart';

const _boxName = 'smart_scenes';

class SceneService {
  Box? _box;

  Future<void> init() async {
    _box = await Hive.openBox(_boxName);
  }

  Box get _requireBox {
    final box = _box;
    if (box == null) {
      throw StateError('SceneService.init() must be called before use');
    }
    return box;
  }

  Future<List<SmartScene>> getAll() async => _requireBox.values
      .map(
        (value) => SmartScene.fromJson(Map<String, dynamic>.from(value as Map)),
      )
      .toList(growable: false);

  Future<void> upsert(SmartScene scene) async {
    await _requireBox.put(scene.id, scene.toJson());
  }

  Future<void> remove(String id) async {
    await _requireBox.delete(id);
  }
}
