/// One confirmed channel state change, as returned by `GET /activity` (see
/// backend/src/routes/activity.js). Backend-only — no offline Hive cache,
/// same reasoning as [Household] (a history feed is meaningless without a
/// live connection). See docs/plan.md's activity history section.
class ActivityEntry {
  const ActivityEntry({
    required this.id,
    required this.deviceId,
    required this.deviceFriendlyName,
    required this.channelIdx,
    required this.state,
    required this.source,
    required this.actorEmail,
    required this.automationId,
    required this.createdAt,
  });

  final int id;
  final String deviceId;
  final String deviceFriendlyName;
  final int channelIdx;
  final String state;

  /// One of `app`, `widget`, `group`, `scene`, `automation`, `device`.
  final String source;
  final String? actorEmail;
  final int? automationId;
  final DateTime createdAt;

  factory ActivityEntry.fromJson(Map<String, dynamic> json) => ActivityEntry(
    id: (json['id'] as num).toInt(),
    deviceId: json['deviceId'] as String,
    deviceFriendlyName: json['deviceFriendlyName'] as String,
    channelIdx: json['channelIdx'] as int,
    state: json['state'] as String,
    source: json['source'] as String,
    actorEmail: json['actorEmail'] as String?,
    automationId: (json['automationId'] as num?)?.toInt(),
    createdAt: DateTime.parse(json['createdAt'] as String),
  );
}
