import '../models/device/channel_state.dart';
import '../models/device/device_config.dart';
import '../models/device/device_info.dart';
import '../models/device/schedule.dart';
import '../models/device/switch_config.dart';
import 'api_error_body.dart';
import 'device_transport.dart';

/// Thrown on any non-2xx response. [message] is the server's `{"error":...}`
/// body when present, otherwise a generic description.
class DeviceApiException implements Exception {
  DeviceApiException(this.statusCode, this.message, {this.retryAfterSeconds});

  final int statusCode;
  final String message;

  /// Set when the backend rejected a turn-ON with
  /// [CommandErrorCodes.minOffTime] (409) — seconds until it's allowed.
  final int? retryAfterSeconds;

  @override
  String toString() => 'DeviceApiException($statusCode): $message';
}

/// GET /api/wifi's body. [state] is one of IDLE / TESTING / CONNECTED /
/// FAILED_ROLLED_BACK (see firmware wifi_provisioning.h).
class WifiStatus {
  const WifiStatus({
    required this.state,
    required this.connected,
    required this.ssid,
    this.rssi,
    this.ip,
  });

  factory WifiStatus.fromJson(Map<String, dynamic> json) => WifiStatus(
    state: json['state'] as String? ?? 'IDLE',
    connected: json['connected'] as bool? ?? false,
    ssid: json['ssid'] as String? ?? '',
    rssi: (json['rssi'] as num?)?.toInt(),
    ip: json['ip'] as String?,
  );

  final String state;
  final bool connected;
  final String ssid;
  final int? rssi;

  /// LAN IP, only while connected (newer firmware).
  final String? ip;
}

/// One entry of GET /api/wifi/scan — a network the DEVICE can see (not the
/// phone), so it reflects what the device's own radio can actually reach.
class WifiNetwork {
  const WifiNetwork({
    required this.ssid,
    required this.rssi,
    required this.secure,
    this.channel,
  });

  factory WifiNetwork.fromJson(Map<String, dynamic> json) => WifiNetwork(
    ssid: json['ssid'] as String? ?? '',
    rssi: (json['rssi'] as num?)?.toInt() ?? -100,
    secure: json['secure'] as bool? ?? true,
    channel: (json['channel'] as num?)?.toInt(),
  );

  final String ssid;
  final int rssi;
  final bool secure;
  final int? channel;
}

/// GET /api/wifi/scan's body. While [scanning] is true the device is still
/// running a fresh async scan and [networks] may be the previous cached
/// result — poll again (see [pollWifiScan]). The firmware already sorts
/// strongest-first, dedupes by SSID and drops hidden networks.
class WifiScanResult {
  const WifiScanResult({required this.scanning, required this.networks});

  factory WifiScanResult.fromJson(Map<String, dynamic> json) => WifiScanResult(
    scanning: json['scanning'] as bool? ?? false,
    networks: [
      for (final e in json['networks'] as List<dynamic>? ?? const [])
        if (e is Map<String, dynamic>) WifiNetwork.fromJson(e),
    ].where((n) => n.ssid.isNotEmpty).toList(),
  );

  final bool scanning;
  final List<WifiNetwork> networks;
}

/// The device's firmware predates GET /api/wifi/scan (404) — callers fall
/// back to manual SSID entry without showing an error.
class WifiScanUnsupportedException implements Exception {
  const WifiScanUnsupportedException();

  @override
  String toString() => 'WiFi scan not supported by this firmware';
}

/// Runs one GET /api/wifi/scan via [fetch] and, while the device reports
/// `scanning`, keeps polling every [interval] (at most [maxPolls] times,
/// ~12 s by default). Returns the finished list — or, if the scan never
/// finishes in time, whatever the device last returned. Shared by the
/// normal [DeviceApiClient] path and the SoftAP setup path
/// (esp8266_provisioning_client.dart).
Future<List<WifiNetwork>> pollWifiScan(
  Future<WifiScanResult> Function(bool refresh) fetch, {
  bool refresh = false,
  Duration interval = const Duration(milliseconds: 1500),
  int maxPolls = 8,
}) async {
  var result = await fetch(refresh);
  for (var i = 0; result.scanning && i < maxPolls; i++) {
    await Future<void>.delayed(interval);
    try {
      result = await fetch(false);
    } on WifiScanUnsupportedException {
      rethrow;
    } catch (_) {
      // The radio hops channels while scanning, which can briefly drop a
      // request (especially over the device's own SoftAP) — keep polling.
    }
  }
  return result.networks;
}

/// One method per firmware §3 endpoint. Talks to a device through whatever
/// [DeviceTransport] it's given — direct LAN HTTP (the default constructor,
/// unchanged from before), a cloud relay, or an automatic fallback between
/// the two (see device_transport.dart / docs/plan.md). Every method's
/// signature is untouched by which transport is in play — callers/screens
/// never need to know.
class DeviceApiClient {
  /// Direct-to-device over the LAN — today's behavior, unchanged.
  DeviceApiClient({required String baseUrl, String? authToken})
    : _transport = LocalHttpTransport(baseUrl: baseUrl, authToken: authToken);

  DeviceApiClient.withTransport(DeviceTransport transport)
    : _transport = transport;

  final DeviceTransport _transport;

  /// Exposes the underlying transport — used by `channelStatesProvider`
  /// (service_providers.dart) to detect whether polls are being served
  /// locally or via cloud relay (see
  /// [FallbackDeviceTransport.lastServedByCloud]) so it can back its poll
  /// interval off while off-LAN. Not needed by any other caller — normal
  /// device control should stick to the methods below.
  DeviceTransport get transport => _transport;

  Future<Map<String, dynamic>> _decodeOrThrow(
    DeviceTransportResponse resp,
  ) async {
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return (resp.body as Map<String, dynamic>?) ?? {};
    }
    final error = ApiErrorBody.parse(resp.body);
    throw DeviceApiException(
      resp.statusCode,
      error.code ?? 'HTTP ${resp.statusCode}',
      retryAfterSeconds: error.retryAfterSeconds,
    );
  }

  Future<DeviceInfo> getInfo() async {
    final resp = await _transport.send('GET', '/api/info');
    return DeviceInfo.fromJson(await _decodeOrThrow(resp));
  }

  Future<DeviceConfig> getConfig() async {
    final resp = await _transport.send('GET', '/api/config');
    return DeviceConfig.fromJson(await _decodeOrThrow(resp));
  }

  Future<void> upsertSwitch(SwitchConfig switchConfig) async {
    final resp = await _transport.send(
      'POST',
      '/api/switches',
      body: switchConfig.toJson(),
    );
    await _decodeOrThrow(resp);
  }

  Future<void> deleteSwitch(int channelIdx) async {
    final resp = await _transport.send('DELETE', '/api/switches/$channelIdx');
    await _decodeOrThrow(resp);
  }

  Future<List<ChannelState>> getChannels() async {
    final resp = await _transport.send('GET', '/api/channels');
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      await _decodeOrThrow(resp);
    }
    final list = resp.body as List<dynamic>;
    return list
        .map((e) => ChannelState.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> setChannelState(int channelIdx, ChannelPowerState state) async {
    final resp = await _transport.send(
      'POST',
      '/api/channels/$channelIdx/state',
      body: {'state': state.toJson()},
    );
    await _decodeOrThrow(resp);
  }

  Future<Schedule> upsertSchedule(Schedule schedule) async {
    // Schedule CREATION (empty id) is not idempotent — a local timeout is
    // ambiguous (the device may have already created it), so a blind cloud
    // retry after that timeout risks a second, duplicate schedule (see
    // device_transport.dart's FallbackDeviceTransport doc comment / Fix 6).
    // A local timeout on an UPDATE (non-empty id) is naturally idempotent
    // (same id, same final state) so it keeps the normal fallback-on-
    // timeout behavior.
    final resp = await _transport.send(
      'POST',
      '/api/schedules',
      body: schedule.toJson(),
      allowFallbackAfterTimeout: schedule.id.isNotEmpty,
    );
    return Schedule.fromJson(await _decodeOrThrow(resp));
  }

  Future<void> deleteSchedule(String scheduleId) async {
    final resp = await _transport.send('DELETE', '/api/schedules/$scheduleId');
    await _decodeOrThrow(resp);
  }

  /// Always returns after a 202 — the firmware can never deliver a
  /// synchronous CONNECTED/FAILED_ROLLED_BACK (single STA radio can't stay
  /// associated to the current AP while test-connecting to a candidate).
  /// Poll [getWifiStatus] afterward to learn the outcome. Works over LAN
  /// and the cloud relay alike. Not retried over the cloud after a local
  /// timeout — a duplicate would hit the device's 409 "already in progress".
  Future<void> requestWifiReconfig({
    required String ssid,
    required String password,
  }) async {
    final resp = await _transport.send(
      'POST',
      '/api/wifi',
      body: {'ssid': ssid, 'password': password},
      allowFallbackAfterTimeout: false,
    );
    if (resp.statusCode != 202) {
      await _decodeOrThrow(resp);
    }
  }

  /// GET /api/wifi — the device's real reconfig state plus its current
  /// network. Prefer this over [getInfo]'s `wifiReconfigState`, which the
  /// cloud path only fills with a placeholder.
  Future<WifiStatus> getWifiStatus() async {
    final resp = await _transport.send('GET', '/api/wifi');
    return WifiStatus.fromJson(await _decodeOrThrow(resp));
  }

  /// GET /api/wifi/scan — one request; see [scanWifiUntilDone] for the
  /// polling wrapper most callers want. [refresh] forces the device to
  /// start a fresh scan instead of returning its cached result. Throws
  /// [WifiScanUnsupportedException] on older firmware (404).
  Future<WifiScanResult> scanWifi({bool refresh = false}) async {
    final resp = await _transport.send(
      'GET',
      refresh ? '/api/wifi/scan?refresh=1' : '/api/wifi/scan',
    );
    if (resp.statusCode == 404) {
      throw const WifiScanUnsupportedException();
    }
    return WifiScanResult.fromJson(await _decodeOrThrow(resp));
  }

  /// [scanWifi] plus the "still scanning" poll loop — see [pollWifiScan].
  Future<List<WifiNetwork>> scanWifiUntilDone({bool refresh = false}) =>
      pollWifiScan((r) => scanWifi(refresh: r), refresh: refresh);

  /// Out of scope for this pass — no OTA upload UI (see docs/plan.md).
  Future<void> uploadOta(List<int> firmwareBytes) => throw UnimplementedError();

  Future<void> setPassword(String newPassword) async {
    final resp = await _transport.send(
      'POST',
      '/api/auth/password',
      body: {'password': newPassword},
    );
    await _decodeOrThrow(resp);
  }

  /// [offsetMinutes] is local-minus-UTC, e.g. +330 for IST, -300 for EST —
  /// matches `DateTime.now().timeZoneOffset.inMinutes`. Applied only at
  /// schedule-match time on the device; never touches its RTC.
  Future<void> setTimezone(int offsetMinutes) async {
    final resp = await _transport.send(
      'POST',
      '/api/timezone',
      body: {'utc_offset_min': offsetMinutes},
    );
    await _decodeOrThrow(resp);
  }

  /// POST /api/settings — interlock and/or location, independently
  /// optional (pass only what changed; the device leaves the other
  /// unspecified fields untouched). Passing exactly one of [latitude]/
  /// [longitude] without the other is a client-side error the device
  /// rejects with a 400 — always supply both together. Returns the
  /// resulting, persisted `{interlock_enabled, latitude, longitude,
  /// location_set}`.
  Future<Map<String, dynamic>> setDeviceSettings({
    bool? interlockEnabled,
    double? latitude,
    double? longitude,
  }) async {
    final resp = await _transport.send(
      'POST',
      '/api/settings',
      body: {
        'interlock_enabled': ?interlockEnabled,
        'latitude': ?latitude,
        'longitude': ?longitude,
      },
    );
    return _decodeOrThrow(resp);
  }

  /// Switches the device to a fixed IP (or back to DHCP with [mode]
  /// `'dhcp'`, other params ignored) — the device persists this and
  /// reboots to apply it, so this call's response may race the reboot;
  /// callers should treat any error here as "probably applied anyway,
  /// re-check `/api/info` after a few seconds" rather than a hard failure.
  Future<void> setNetworkConfig({
    required String mode,
    String? ip,
    String? gateway,
    String? subnet,
    String? dns,
  }) async {
    final resp = await _transport.send(
      'POST',
      '/api/network',
      body: {
        'mode': mode,
        'ip': ?ip,
        'gateway': ?gateway,
        'subnet': ?subnet,
        'dns': ?dns,
      },
    );
    await _decodeOrThrow(resp);
  }
}
