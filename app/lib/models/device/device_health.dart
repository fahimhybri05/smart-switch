/// `GET /devices/:id/health` — connection state plus the firmware
/// diagnostics the device sent on its latest connect.
class DeviceHealth {
  const DeviceHealth({
    required this.online,
    this.lastConnectedAt,
    this.offlineSince,
    this.addedAt,
    this.firmware,
    this.resetReason,
    this.rssi,
    this.freeHeap,
    this.uptimeS,
    this.reportedAt,
  });

  final bool online;
  final DateTime? lastConnectedAt;

  /// When the connection dropped; null while online.
  final DateTime? offlineSince;
  final DateTime? addedAt;
  final String? firmware;

  /// ESP8266 reset reason from the latest boot, e.g. "Power On".
  final String? resetReason;

  /// Wi-Fi signal (dBm) measured when it last connected.
  final int? rssi;
  final int? freeHeap;

  /// Seconds since the device booted; only known while online.
  final int? uptimeS;
  final DateTime? reportedAt;

  /// Older firmware sends no diagnostics at all.
  bool get hasDiagnostics =>
      firmware != null ||
      resetReason != null ||
      rssi != null ||
      freeHeap != null;

  static DateTime? _date(Object? v) =>
      v is String ? DateTime.tryParse(v)?.toLocal() : null;

  static int? _int(Object? v) => v is num ? v.round() : null;

  factory DeviceHealth.fromJson(Map<String, dynamic> json) => DeviceHealth(
    online: json['online'] as bool? ?? false,
    lastConnectedAt: _date(json['lastConnectedAt']),
    offlineSince: _date(json['offlineSince']),
    addedAt: _date(json['addedAt']),
    firmware: json['firmware'] as String?,
    resetReason: json['resetReason'] as String?,
    rssi: _int(json['rssi']),
    freeHeap: _int(json['freeHeap']),
    uptimeS: _int(json['uptimeS']),
    reportedAt: _date(json['reportedAt']),
  );
}
