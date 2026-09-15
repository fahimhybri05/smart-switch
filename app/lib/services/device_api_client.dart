import '../models/device/channel_state.dart';
import '../models/device/device_config.dart';
import '../models/device/device_info.dart';
import '../models/device/schedule.dart';
import '../models/device/switch_config.dart';
import 'device_transport.dart';

/// Thrown on any non-2xx response. [message] is the server's `{"error":...}`
/// body when present, otherwise a generic description.
class DeviceApiException implements Exception {
  DeviceApiException(this.statusCode, this.message);

  final int statusCode;
  final String message;

  @override
  String toString() => 'DeviceApiException($statusCode): $message';
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
    String message = 'HTTP ${resp.statusCode}';
    final decoded = resp.body;
    if (decoded is Map<String, dynamic> && decoded['error'] is String) {
      message = decoded['error'] as String;
    }
    throw DeviceApiException(resp.statusCode, message);
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
    final resp = await _transport.send(
      'POST',
      '/api/schedules',
      body: schedule.toJson(),
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
  /// Poll [getInfo]'s `wifiReconfigState` afterward to learn the outcome.
  Future<void> requestWifiReconfig({
    required String ssid,
    required String password,
  }) async {
    final resp = await _transport.send(
      'POST',
      '/api/wifi',
      body: {'ssid': ssid, 'password': password},
    );
    if (resp.statusCode != 202) {
      await _decodeOrThrow(resp);
    }
  }

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
