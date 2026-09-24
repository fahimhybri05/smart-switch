import '../device/channel_state.dart';

/// The icon names the app, dashboard and backend agree on for scenes
/// (free text on the wire; anything else falls back to a generic icon).
abstract final class SceneIcons {
  static const all = [
    'moon',
    'sun',
    'home',
    'away',
    'movie',
    'power',
    'leaf',
    'droplet',
  ];
}

/// One step of a [Scene]: set one switch ON or OFF.
class SceneAction {
  const SceneAction({
    required this.deviceId,
    required this.channelIdx,
    required this.state,
  });

  final String deviceId;
  final int channelIdx;
  final ChannelPowerState state;

  factory SceneAction.fromJson(Map<String, dynamic> json) => SceneAction(
    deviceId: json['deviceId'] as String,
    channelIdx: (json['channelIdx'] as num).toInt(),
    state: ChannelPowerState.fromJson(json['state'] as String),
  );

  Map<String, dynamic> toJson() => {
    'deviceId': deviceId,
    'channelIdx': channelIdx,
    'state': state.toJson(),
  };
}

/// A household-wide, one-tap set of switch states (see `/scenes` in the
/// user-features contract). Backend-only — no offline cache, same as
/// automations. All wire parsing for scenes lives in this file.
class Scene {
  const Scene({
    required this.id,
    required this.name,
    required this.actions,
    this.householdId,
    this.icon,
    this.createdAt,
    this.updatedAt,
  });

  static const maxActions = 64;
  static const maxNameLength = 64;

  final int id;
  final int? householdId;
  final String name;

  /// One of [SceneIcons.all], or null/unknown.
  final String? icon;
  final List<SceneAction> actions;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  factory Scene.fromJson(Map<String, dynamic> json) => Scene(
    id: (json['id'] as num).toInt(),
    householdId: (json['householdId'] as num?)?.toInt(),
    name: json['name'] as String,
    icon: json['icon'] as String?,
    actions: ((json['actions'] as List<dynamic>?) ?? const [])
        .map((e) => SceneAction.fromJson(e as Map<String, dynamic>))
        .toList(),
    createdAt: _parseDate(json['createdAt']),
    updatedAt: _parseDate(json['updatedAt']),
  );

  /// Body for `POST /scenes` — [id] omitted creates a new scene.
  static Map<String, dynamic> upsertBody({
    int? id,
    int? householdId,
    required String name,
    String? icon,
    required List<SceneAction> actions,
  }) => {
    'id': ?id,
    'householdId': ?householdId,
    'name': name,
    'icon': icon,
    'actions': actions.map((a) => a.toJson()).toList(),
  };
}

/// One action's outcome from `POST /scenes/:id/run`.
class SceneActionResult {
  const SceneActionResult({
    required this.deviceId,
    required this.channelIdx,
    required this.state,
    required this.ok,
    this.error,
    this.retryAfterSeconds,
  });

  final String deviceId;
  final int channelIdx;
  final ChannelPowerState state;
  final bool ok;

  /// Backend error code when ![ok], e.g. `switch_locked`, `min_off_time`,
  /// `device_offline`.
  final String? error;

  /// Only for `min_off_time`, if the backend includes it per action.
  final int? retryAfterSeconds;

  factory SceneActionResult.fromJson(Map<String, dynamic> json) =>
      SceneActionResult(
        deviceId: json['deviceId'] as String,
        channelIdx: (json['channelIdx'] as num).toInt(),
        state: ChannelPowerState.fromJson(json['state'] as String? ?? 'OFF'),
        ok: json['ok'] as bool? ?? false,
        error: json['error'] as String?,
        retryAfterSeconds: (json['retryAfterSeconds'] as num?)?.ceil(),
      );
}

/// `POST /scenes/:id/run` → `{results, succeeded, failed}`.
class SceneRunSummary {
  const SceneRunSummary({
    required this.results,
    required this.succeeded,
    required this.failed,
  });

  final List<SceneActionResult> results;
  final int succeeded;
  final int failed;

  int get total => succeeded + failed;

  List<SceneActionResult> get failures =>
      results.where((r) => !r.ok).toList();

  factory SceneRunSummary.fromJson(Map<String, dynamic> json) {
    final results = ((json['results'] as List<dynamic>?) ?? const [])
        .map((e) => SceneActionResult.fromJson(e as Map<String, dynamic>))
        .toList();
    return SceneRunSummary(
      results: results,
      succeeded:
          (json['succeeded'] as num?)?.toInt() ??
          results.where((r) => r.ok).length,
      failed:
          (json['failed'] as num?)?.toInt() ??
          results.where((r) => !r.ok).length,
    );
  }
}

DateTime? _parseDate(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;
