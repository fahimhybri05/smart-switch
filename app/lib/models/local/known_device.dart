/// One row of the app's local known-devices table (spec §4). Persisted via
/// Hive — mDNS refresh keeps [lastKnownIp] fresh on LAN; when that fails
/// (e.g. remote via Tailscale, where multicast doesn't traverse the subnet
/// route), the app falls back to this cached IP.
///
/// [lastKnownIp]/[mdnsHostname] are nullable: a device synced in from the
/// backend (claimed on a *different* phone, never locally mDNS-discovered
/// on this one) has neither yet — see `activeDeviceApiClientProvider`,
/// which routes such a device through the cloud relay instead of a doomed
/// local HTTP call. See docs/plan.md's account-wide sync section.
class KnownDevice {
  const KnownDevice({
    required this.deviceId,
    required this.mdnsHostname,
    required this.lastKnownIp,
    required this.friendlyName,
  });

  final String deviceId;
  final String? mdnsHostname;
  final String? lastKnownIp;
  final String friendlyName;

  factory KnownDevice.fromJson(Map<String, dynamic> json) => KnownDevice(
    deviceId: json['device_id'] as String,
    mdnsHostname: json['mdns_hostname'] as String?,
    lastKnownIp: json['last_known_ip'] as String?,
    friendlyName: json['friendly_name'] as String,
  );

  Map<String, dynamic> toJson() => {
    'device_id': deviceId,
    'mdns_hostname': mdnsHostname,
    'last_known_ip': lastKnownIp,
    'friendly_name': friendlyName,
  };

  KnownDevice copyWith({String? lastKnownIp, String? friendlyName}) =>
      KnownDevice(
        deviceId: deviceId,
        mdnsHostname: mdnsHostname,
        lastKnownIp: lastKnownIp ?? this.lastKnownIp,
        friendlyName: friendlyName ?? this.friendlyName,
      );

  // Identity is deviceId alone — required so the family-keyed providers in
  // service_providers.dart (deviceConfigProvider/channelStatesProvider)
  // treat two KnownDevice instances for the same device as the same cache
  // key. Without this, every KnownDevicesNotifier.upsert() (now far more
  // frequent — see syncClaimedDevicesFromBackend, called on every login
  // and app cold start) would orphan live polling streams for *unchanged*
  // devices too, flickering every tile to "Connecting" on each app launch.
  @override
  bool operator ==(Object other) =>
      other is KnownDevice && other.deviceId == deviceId;

  @override
  int get hashCode => deviceId.hashCode;
}
