/// One switch pinned to the Android home-screen widget (spec: App 5,
/// docs/plan.md) — enough to render a row and route a tap straight to the
/// device over HTTP from a headless isolate, without needing the full app.
class PinnedSwitch {
  const PinnedSwitch({
    required this.deviceId,
    this.lastKnownIp,
    required this.channelIdx,
    required this.switchName,
  });

  final String deviceId;
  // Null for a device only known via the cloud (never seen on this LAN) —
  // the widget then toggles it through the backend relay instead.
  final String? lastKnownIp;
  final int channelIdx;
  final String switchName;

  factory PinnedSwitch.fromJson(Map<String, dynamic> json) => PinnedSwitch(
    deviceId: json['device_id'] as String,
    lastKnownIp: json['last_known_ip'] as String?,
    channelIdx: json['channel_idx'] as int,
    switchName: json['switch_name'] as String,
  );

  Map<String, dynamic> toJson() => {
    'device_id': deviceId,
    'last_known_ip': ?lastKnownIp,
    'channel_idx': channelIdx,
    'switch_name': switchName,
  };
}
