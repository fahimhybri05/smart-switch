import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../device_api_client.dart'
    show
        WifiNetwork,
        WifiScanResult,
        WifiScanUnsupportedException,
        pollWifiScan;
import 'network_binding.dart';
import 'softap_provisioning_client.dart'
    show ProvisioningException, ProvisioningOutcome, kDeviceHotspotPassword;

const _requestTimeout = Duration(seconds: 10);
const _pollInterval = Duration(seconds: 3);
const _maxPolls =
    12; // ~36s, comfortably above the firmware's own 15s connect timeout

/// Talks directly to an ESP8266 in SoftAP provisioning mode
/// (`http://192.168.4.1` by default). No Security1/protocomm equivalent on
/// this chip (see docs/plan.md) — WiFi credentials go over a plain JSON
/// POST instead, gated only by the SoftAP's own WPA2 password
/// ([kDeviceHotspotPassword]). Same [ProvisioningOutcome]/[ProvisioningException] shape
/// as [SoftApProvisioningClient] (the ESP32 client) so the wizard screen
/// can treat both interchangeably.
class Esp8266ProvisioningClient {
  Esp8266ProvisioningClient({this.baseUrl = 'http://192.168.4.1'});

  final String baseUrl;

  /// Networks the device itself can see, via GET /api/wifi/scan over its
  /// SoftAP — lets the setup screen offer a pick-list instead of making the
  /// user type their SSID. Polls until the device's async scan finishes
  /// (see [pollWifiScan]). Throws [WifiScanUnsupportedException] on
  /// firmware without the endpoint (404), [ProvisioningException] if the
  /// phone isn't on the device's hotspot.
  Future<List<WifiNetwork>> scanNetworks({bool refresh = false}) async {
    final bound = await bindToCurrentWifi();
    if (!bound) {
      throw ProvisioningException(
        'Could not bind to the device WiFi network — make sure your phone '
        'is joined to the SmartSwitch-… network (password '
        '$kDeviceHotspotPassword) and try again.',
      );
    }
    try {
      return await pollWifiScan(_fetchScan, refresh: refresh);
    } finally {
      await unbindNetwork();
    }
  }

  Future<WifiScanResult> _fetchScan(bool refresh) async {
    final resp = await http
        .get(
          Uri.parse(
            refresh
                ? '$baseUrl/api/wifi/scan?refresh=1'
                : '$baseUrl/api/wifi/scan',
          ),
        )
        .timeout(_requestTimeout);
    if (resp.statusCode == 404) {
      throw const WifiScanUnsupportedException();
    }
    if (resp.statusCode != 200) {
      throw ProvisioningException(
        'Device WiFi scan failed (HTTP ${resp.statusCode}).',
      );
    }
    return WifiScanResult.fromJson(
      jsonDecode(resp.body) as Map<String, dynamic>,
    );
  }

  Future<ProvisioningOutcome> provision({
    required String ssid,
    required String password,
    void Function(String status)? onStatus,
  }) async {
    // Same Android routing workaround the ESP32 client needs — see
    // network_binding.dart.
    final bound = await bindToCurrentWifi();
    if (!bound) {
      throw ProvisioningException(
        'Could not bind to the device WiFi network — make sure your phone '
        'is joined to the SmartSwitch-… network (password '
        '$kDeviceHotspotPassword) and try again.',
      );
    }

    try {
      onStatus?.call('Sending WiFi credentials…');
      try {
        final resp = await http
            .post(
              Uri.parse('$baseUrl/api/wifi'),
              headers: const {'Content-Type': 'application/json'},
              body: jsonEncode({'ssid': ssid, 'password': password}),
            )
            .timeout(_requestTimeout);
        if (resp.statusCode != 202) {
          throw ProvisioningException(
            'Device rejected the WiFi credentials (HTTP ${resp.statusCode}).',
          );
        }
      } catch (e) {
        if (e is ProvisioningException) rethrow;
        throw ProvisioningException(
          'Could not reach the device — make sure your phone is still joined '
          'to its SmartSwitch-… WiFi network. ($e)',
        );
      }

      onStatus?.call('Waiting for the device to join your WiFi…');
      for (var i = 0; i < _maxPolls; i++) {
        await Future.delayed(_pollInterval);
        String state;
        try {
          final infoResp = await http
              .get(Uri.parse('$baseUrl/api/info'))
              .timeout(_requestTimeout);
          final info = jsonDecode(infoResp.body) as Map<String, dynamic>;
          state = info['wifi_reconfig_state'] as String? ?? 'TESTING';
        } catch (_) {
          // The SoftAP itself drops once the device joins the new network
          // and switches out of AP mode — an unreachable poll here usually
          // just means it already succeeded and moved on.
          onStatus?.call('Connected!');
          return ProvisioningOutcome.connected;
        }

        if (state == 'CONNECTED') {
          onStatus?.call('Connected!');
          return ProvisioningOutcome.connected;
        }
        if (state == 'FAILED_ROLLED_BACK') {
          onStatus?.call('Failed — reverted to the previous network.');
          return ProvisioningOutcome.failed;
        }
        onStatus?.call('Still connecting…');
      }

      onStatus?.call('Timed out waiting for the device.');
      return ProvisioningOutcome.failed;
    } finally {
      await unbindNetwork();
    }
  }
}
