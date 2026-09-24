import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/models/device/switch_config.dart';

void main() {
  Map<String, dynamic> baseJson() => {
    'channel_idx': 2,
    'name': 'Pump',
    'zone': 'Garden',
    'type': 'ON_OFF',
    'default_boot_state': 'OFF',
    'input_mode': 'DISABLED',
    'inching_ms': 0,
  };

  group('SwitchConfig user-feature fields', () {
    test('parses watts / safety / lock from snake_case', () {
      final config = SwitchConfig.fromJson({
        ...baseJson(),
        'watts': 750,
        'max_on_s': 3600,
        'min_off_s': 180,
        'locked': true,
        'locked_at': '2026-09-24T10:00:00Z',
      });
      expect(config.watts, 750);
      expect(config.maxOnSeconds, 3600);
      expect(config.minOffSeconds, 180);
      expect(config.locked, isTrue);
    });

    test('missing fields default to unset / unlocked', () {
      final config = SwitchConfig.fromJson(baseJson());
      expect(config.watts, isNull);
      expect(config.maxOnSeconds, isNull);
      expect(config.minOffSeconds, isNull);
      expect(config.locked, isFalse);
    });

    test('round-trips through toJson', () {
      final original = SwitchConfig.fromJson({
        ...baseJson(),
        'watts': 60,
        'max_on_s': 7200,
        'min_off_s': 300,
        'locked': true,
      });
      final json = original.toJson();
      expect(json['watts'], 60);
      expect(json['max_on_s'], 7200);
      expect(json['min_off_s'], 300);
      expect(json['locked'], true);
      final again = SwitchConfig.fromJson(json);
      expect(again.watts, 60);
      expect(again.maxOnSeconds, 7200);
      expect(again.minOffSeconds, 300);
      expect(again.locked, isTrue);
      expect(again.name, 'Pump');
    });

    test('unset values are sent as explicit nulls so the backend clears them',
        () {
      final json = SwitchConfig.fromJson(baseJson()).toJson();
      for (final key in ['watts', 'max_on_s', 'min_off_s']) {
        expect(json.containsKey(key), isTrue, reason: key);
        expect(json[key], isNull, reason: key);
      }
      expect(json['locked'], false);
    });

    test('copyWith preserves watts / safety / lock', () {
      final original = SwitchConfig.fromJson({
        ...baseJson(),
        'watts': 60,
        'max_on_s': 7200,
        'min_off_s': 300,
        'locked': true,
      });
      final moved = original.copyWith(zone: 'Porch');
      expect(moved.zone, 'Porch');
      expect(moved.watts, 60);
      expect(moved.maxOnSeconds, 7200);
      expect(moved.minOffSeconds, 300);
      expect(moved.locked, isTrue);
    });
  });
}
