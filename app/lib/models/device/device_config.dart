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
    this.interlockEnabled = false,
    this.latitude = 0.0,
    this.longitude = 0.0,
    this.locationSet = false,
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

  /// If true, turning any channel ON forces every other channel OFF
  /// (curtain/blind-module-style interlock) — see `DeviceApiClient.setDeviceSettings`.
  final bool interlockEnabled;

  /// Degrees, east-positive longitude. Only meaningful when [locationSet].
  final double latitude;
  final double longitude;

  /// False until latitude/longitude have been explicitly set — gates
  /// whether sunrise/sunset schedules can be created (the device rejects
  /// them with an error otherwise).
  final bool locationSet;

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
    interlockEnabled: json['interlock_enabled'] as bool? ?? false,
    latitude: (json['latitude'] as num?)?.toDouble() ?? 0.0,
    longitude: (json['longitude'] as num?)?.toDouble() ?? 0.0,
    locationSet: json['location_set'] as bool? ?? false,
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
    'interlock_enabled': interlockEnabled,
    'latitude': latitude,
    'longitude': longitude,
    'location_set': locationSet,
  };
}
