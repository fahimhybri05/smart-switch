import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/models/device/channel_state.dart';
import 'package:smart_switch/models/local/scene.dart';

void main() {
  group('Scene', () {
    test('parses a GET /scenes entry', () {
      final scene = Scene.fromJson({
        'id': 12,
        'householdId': 3,
        'name': 'Night',
        'icon': 'moon',
        'actions': [
          {'deviceId': 'dev-a', 'channelIdx': 0, 'state': 'OFF'},
          {'deviceId': 'dev-b', 'channelIdx': 3, 'state': 'ON'},
        ],
        'createdAt': '2026-09-01T20:00:00.000Z',
        'updatedAt': '2026-09-02T20:00:00.000Z',
      });
      expect(scene.id, 12);
      expect(scene.householdId, 3);
      expect(scene.name, 'Night');
      expect(scene.icon, 'moon');
      expect(scene.actions, hasLength(2));
      expect(scene.actions[0].deviceId, 'dev-a');
      expect(scene.actions[0].state, ChannelPowerState.off);
      expect(scene.actions[1].channelIdx, 3);
      expect(scene.actions[1].state, ChannelPowerState.on);
      expect(scene.createdAt, DateTime.utc(2026, 9, 1, 20));
    });

    test('tolerates null icon and missing timestamps', () {
      final scene = Scene.fromJson({
        'id': 1,
        'name': 'All off',
        'icon': null,
        'actions': <dynamic>[],
      });
      expect(scene.icon, isNull);
      expect(scene.householdId, isNull);
      expect(scene.createdAt, isNull);
      expect(scene.actions, isEmpty);
    });

    test('upsertBody is camelCase and omits a null id/householdId', () {
      final body = Scene.upsertBody(
        name: 'Movie',
        icon: 'movie',
        actions: const [
          SceneAction(
            deviceId: 'dev-a',
            channelIdx: 1,
            state: ChannelPowerState.on,
          ),
        ],
      );
      expect(body.containsKey('id'), isFalse);
      expect(body.containsKey('householdId'), isFalse);
      expect(body['name'], 'Movie');
      expect(body['icon'], 'movie');
      expect(body['actions'], [
        {'deviceId': 'dev-a', 'channelIdx': 1, 'state': 'ON'},
      ]);
      final withIds = Scene.upsertBody(
        id: 5,
        householdId: 2,
        name: 'x',
        actions: const [],
      );
      expect(withIds['id'], 5);
      expect(withIds['householdId'], 2);
    });
  });

  group('SceneRunSummary', () {
    test('parses results with per-action errors', () {
      final summary = SceneRunSummary.fromJson({
        'results': [
          {'deviceId': 'a', 'channelIdx': 0, 'state': 'OFF', 'ok': true},
          {
            'deviceId': 'a',
            'channelIdx': 1,
            'state': 'ON',
            'ok': false,
            'error': 'switch_locked',
          },
          {
            'deviceId': 'b',
            'channelIdx': 0,
            'state': 'ON',
            'ok': false,
            'error': 'min_off_time',
            'retryAfterSeconds': 125,
          },
        ],
        'succeeded': 1,
        'failed': 2,
      });
      expect(summary.succeeded, 1);
      expect(summary.failed, 2);
      expect(summary.total, 3);
      expect(summary.failures.map((f) => f.error), [
        'switch_locked',
        'min_off_time',
      ]);
      expect(summary.failures.last.retryAfterSeconds, 125);
    });

    test('derives counts when the backend omits them', () {
      final summary = SceneRunSummary.fromJson({
        'results': [
          {'deviceId': 'a', 'channelIdx': 0, 'state': 'ON', 'ok': true},
          {'deviceId': 'a', 'channelIdx': 1, 'state': 'ON', 'ok': false},
        ],
      });
      expect(summary.succeeded, 1);
      expect(summary.failed, 1);
    });
  });
}
