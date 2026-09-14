/// GET /api/info — lightweight discovery-confirm payload (spec §3), fetched
/// before the app pulls the full DeviceConfig.
class DeviceInfo {
  const DeviceInfo({
    required this.deviceId,
    required this.boardType,
    required this.channelCount,
    required this.fwVersion,
    this.wifiReconfigState = 'IDLE',
    this.cloudSecret,
    this.capabilities = const [],
  });

  final String deviceId;
  final String boardType;
  final int channelCount;
  final String fwVersion;

  /// Non-spec firmware addition: "IDLE" | "TESTING" | "CONNECTED" |
  /// "FAILED_ROLLED_BACK" — lets the app poll the outcome of an async
  /// POST /api/wifi reconfig (which always responds 202 immediately, since
  /// a single-radio ESP32 can't hold the original connection open through
  /// a test-connect).
  final String wifiReconfigState;

  /// Present only on firmware with the cloud_client component (see
  /// docs/plan.md's Phase 2 — not built yet at the time this field was
  /// added, so it's null on all firmware today). Read once during the
  /// app's "Enable remote control" claim step; never displayed/stored
  /// beyond that single backend call.
  final String? cloudSecret;

  /// Forward-compatible capability list (e.g. `["switch"]`) — always just
  /// `["switch"]` on today's firmware (relay_hal is strictly binary), empty
  /// on older firmware that predates this field. Not used for any UI yet;
  /// exists so a future dimmer/fan/power-meter product doesn't need a
  /// breaking schema change. See docs/plan.md.
  final List<String> capabilities;

  factory DeviceInfo.fromJson(Map<String, dynamic> json) => DeviceInfo(
    deviceId: json['device_id'] as String,
    boardType: json['board_type'] as String,
    channelCount: json['channel_count'] as int,
    fwVersion: json['fw_version'] as String,
    wifiReconfigState: json['wifi_reconfig_state'] as String? ?? 'IDLE',
    cloudSecret: json['cloud_secret'] as String?,
    capabilities:
        (json['capabilities'] as List<dynamic>?)?.cast<String>() ?? const [],
  );

  Map<String, dynamic> toJson() => {
    'device_id': deviceId,
    'board_type': boardType,
    'channel_count': channelCount,
    'fw_version': fwVersion,
    'wifi_reconfig_state': wifiReconfigState,
    if (cloudSecret != null) 'cloud_secret': cloudSecret,
    'capabilities': capabilities,
  };
}
