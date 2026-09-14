import 'dart:async';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'network_binding.dart';
import 'security1_session.dart';
import 'wifi_config_proto.dart';

class ProvisioningException implements Exception {
  ProvisioningException(this.message);

  final String message;

  @override
  String toString() => message;
}

enum ProvisioningOutcome { connected, failed }

const _requestTimeout = Duration(seconds: 10);
const _pollInterval = Duration(seconds: 5);
const _maxRetries = 3;

/// Talks directly to an ESP32 in SoftAP provisioning mode
/// (`http://192.168.4.1` by default) — a native Dart port of ESP-IDF's
/// protocomm "Security1" handshake plus its wifi_provisioning
/// SetConfig/ApplyConfig/GetStatus flow, so first-time WiFi provisioning
/// no longer needs a separate Espressif app. See docs/plan.md for the
/// full protocol this was ported from.
class SoftApProvisioningClient {
  SoftApProvisioningClient({this.baseUrl = 'http://192.168.4.1'});

  final String baseUrl;

  Future<Uint8List> _post(String endpoint, Uint8List body) async {
    late final http.Response resp;
    try {
      resp = await http
          .post(
            Uri.parse('$baseUrl/$endpoint'),
            headers: const {'Content-Type': 'application/octet-stream'},
            body: body,
          )
          .timeout(_requestTimeout);
    } catch (e) {
      throw ProvisioningException(
        'Could not reach the device — make sure your phone is still joined '
        'to its SmartSwitch-… WiFi network. ($e)',
      );
    }
    if (resp.statusCode != 200) {
      throw ProvisioningException('$endpoint returned HTTP ${resp.statusCode}');
    }
    return resp.bodyBytes;
  }

  /// Runs the full flow: Security1 handshake (POP-gated) → send WiFi
  /// config → apply → poll for connection. [onStatus] receives short
  /// human-readable progress strings for a UI to display live.
  Future<ProvisioningOutcome> provision({
    required String pop,
    required String ssid,
    required String password,
    void Function(String status)? onStatus,
  }) async {
    // Android otherwise silently routes this traffic over mobile data
    // instead of the (no-internet) SoftAP the phone is joined to — see
    // network_binding.dart. Always unbind afterward so the rest of the app
    // isn't stuck routing through a network that's about to disappear.
    final bound = await bindToCurrentWifi();
    if (!bound) {
      throw ProvisioningException(
        'Could not bind to the device WiFi network — make sure your phone '
        'is joined to the SmartSwitch-… network and try again.',
      );
    }

    try {
      onStatus?.call('Connecting to device…');
      final session = Security1Session(pop: pop);

      final req0 = await session.buildHandshakeRequest0();
      final resp0 = await _post('prov-session', req0);
      await session.consumeHandshakeResponse0(resp0);

      final req1 = session.buildHandshakeRequest1();
      final resp1 = await _post('prov-session', req1);
      if (!session.consumeHandshakeResponse1(resp1)) {
        throw ProvisioningException(
          "Device didn't accept the pairing code — check you joined the "
          'right SmartSwitch-… network and try again.',
        );
      }

      onStatus?.call('Sending WiFi credentials…');
      final setConfigResp = await _post(
        'prov-config',
        session.encrypt(buildSetConfigRequest(ssid: ssid, password: password)),
      );
      if (!parseSetConfigResponse(session.decrypt(setConfigResp))) {
        throw ProvisioningException('Device rejected the WiFi credentials.');
      }

      final applyResp = await _post(
        'prov-config',
        session.encrypt(buildApplyConfigRequest()),
      );
      if (!parseApplyConfigResponse(session.decrypt(applyResp))) {
        throw ProvisioningException(
          'Device failed to apply the new WiFi config.',
        );
      }

      onStatus?.call('Waiting for the device to join your WiFi…');
      var retriesLeft = _maxRetries;
      while (true) {
        await Future.delayed(_pollInterval);
        final statusResp = await _post(
          'prov-config',
          session.encrypt(buildGetStatusRequest()),
        );
        final result = parseGetStatusResponse(session.decrypt(statusResp));

        if (result.state == WifiStationState.connected) {
          onStatus?.call('Connected!');
          return ProvisioningOutcome.connected;
        }
        if (result.state == WifiStationState.connecting) {
          onStatus?.call('Still connecting…');
          continue;
        }

        if (retriesLeft > 0) {
          retriesLeft--;
          onStatus?.call('Retrying… ($retriesLeft left)');
          continue;
        }

        final reason = switch (result.failReason) {
          WifiFailReason.authError => 'incorrect WiFi password',
          WifiFailReason.networkNotFound => 'WiFi network not found',
          _ => 'unknown error',
        };
        onStatus?.call('Failed: $reason');
        return ProvisioningOutcome.failed;
      }
    } finally {
      await unbindNetwork();
    }
  }
}
