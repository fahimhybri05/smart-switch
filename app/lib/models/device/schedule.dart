enum ScheduleType {
  once,
  daily,
  weekly,
  countdown,
  sunrise,
  sunset;

  String toJson() => switch (this) {
    ScheduleType.once => 'once',
    ScheduleType.daily => 'daily',
    ScheduleType.weekly => 'weekly',
    ScheduleType.countdown => 'countdown',
    ScheduleType.sunrise => 'sunrise',
    ScheduleType.sunset => 'sunset',
  };

  static ScheduleType fromJson(String value) => switch (value) {
    'daily' => ScheduleType.daily,
    'weekly' => ScheduleType.weekly,
    'countdown' => ScheduleType.countdown,
    'sunrise' => ScheduleType.sunrise,
    'sunset' => ScheduleType.sunset,
    _ => ScheduleType.once,
  };
}

enum ScheduleAction {
  on,
  off;

  String toJson() => this == ScheduleAction.on ? 'ON' : 'OFF';

  static ScheduleAction fromJson(String value) =>
      value == 'ON' ? ScheduleAction.on : ScheduleAction.off;
}

/// Mirrors spec §2's schedule rows. [time]/[days] are only populated for
/// clock-based types (once/daily/weekly); [durationS] only for countdown;
/// [solarOffsetMin] only for sunrise/sunset (minutes to shift the device's
/// computed sunrise/sunset time — negative = before, positive = after;
/// requires the device to have a location configured, see
/// `DeviceConfig.locationSet`).
class Schedule {
  const Schedule({
    required this.id,
    required this.channelIdx,
    required this.action,
    required this.type,
    required this.enabled,
    this.time,
    this.days,
    this.durationS,
    this.solarOffsetMin,
  });

  final String id;
  final int channelIdx;
  final ScheduleAction action;
  final ScheduleType type;
  final bool enabled;
  final String? time; // "HH:MM", clock-based schedules only
  final List<int>? days; // 1=Mon..7=Sun, clock-based schedules only
  final int? durationS; // countdown schedules only
  final int? solarOffsetMin; // sunrise/sunset schedules only

  factory Schedule.fromJson(Map<String, dynamic> json) => Schedule(
    id: json['id'] as String,
    channelIdx: json['channel_idx'] as int,
    action: ScheduleAction.fromJson(json['action'] as String),
    type: ScheduleType.fromJson(json['type'] as String),
    enabled: json['enabled'] as bool,
    time: json['time'] as String?,
    days: (json['days'] as List<dynamic>?)?.cast<int>(),
    durationS: json['duration_s'] as int?,
    solarOffsetMin: json['solar_offset_min'] as int?,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'channel_idx': channelIdx,
    'action': action.toJson(),
    'type': type.toJson(),
    'enabled': enabled,
    if (time != null) 'time': time,
    if (days != null) 'days': days,
    if (durationS != null) 'duration_s': durationS,
    if (solarOffsetMin != null) 'solar_offset_min': solarOffsetMin,
  };
}
