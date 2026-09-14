import 'schedule.dart';
import 'switch_config.dart';

/// GET /api/config root object — the full device-resident config (spec §2).
class DeviceConfig {
  const DeviceConfig({
    required this.deviceId,
    required this.name,
    required this.boardType,
    required this.channelCount,
    required this.channelDriver,
    required this.fwVersion,
    required this.switches,
    required this.schedules,
    this.utcOffsetMinutes = 0,
  });

  final String deviceId;
  final String name;
  final String boardType;
  final int channelCount;
  final String channelDriver; // "GPIO_DIRECT" | "I2C_EXPANDER"
  final String fwVersion;
  final List<SwitchConfig> switches;
  final List<Schedule> schedules;

  /// Local-minus-UTC, in minutes — see `DeviceApiClient.setTimezone`.
  final int utcOffsetMinutes;

  factory DeviceConfig.fromJson(Map<String, dynamic> json) => DeviceConfig(
    deviceId: json['device_id'] as String,
    name: json['name'] as String,
    boardType: json['board_type'] as String,
    channelCount: json['channel_count'] as int,
    channelDriver: json['channel_driver'] as String,
    fwVersion: json['fw_version'] as String,
    switches: (json['switches'] as List<dynamic>)
        .map((e) => SwitchConfig.fromJson(e as Map<String, dynamic>))
        .toList(),
    schedules: (json['schedules'] as List<dynamic>)
        .map((e) => Schedule.fromJson(e as Map<String, dynamic>))
        .toList(),
    utcOffsetMinutes: json['utc_offset_min'] as int? ?? 0,
  );

  Map<String, dynamic> toJson() => {
    'device_id': deviceId,
    'name': name,
    'board_type': boardType,
    'channel_count': channelCount,
    'channel_driver': channelDriver,
    'fw_version': fwVersion,
    'switches': switches.map((s) => s.toJson()).toList(),
    'schedules': schedules.map((s) => s.toJson()).toList(),
    'utc_offset_min': utcOffsetMinutes,
  };
}
