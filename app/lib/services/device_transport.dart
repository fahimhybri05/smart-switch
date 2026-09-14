import 'dart:convert';

import 'package:http/http.dart' as http;

const _requestTimeout = Duration(seconds: 5);

/// A device response, already JSON-decoded (a `Map`, `List`, or `null` for
/// an empty body) regardless of which transport produced it.
class DeviceTransportResponse {
  const DeviceTransportResponse({required this.statusCode, this.body});

  final int statusCode;
  final dynamic body;
}

/// What `DeviceApiClient` (device_api_client.dart) actually needs to talk
/// to a device — either directly over the home LAN ([LocalHttpTransport])
/// or relayed through the cloud backend ([CloudRelayTransport]), or
/// automatically whichever works ([FallbackDeviceTransport]). Screens never
/// see this — `DeviceApiClient`'s public methods/signatures are unchanged
/// either way (see docs/plan.md).
abstract class DeviceTransport {
  Future<DeviceTransportResponse> send(
    String method,
    String path, {
    Object? body,
  });
}

/// Today's behavior — a plain HTTP call to the device's own base URL. Same
/// Basic Auth logic `DeviceApiClient` used to build inline.
class LocalHttpTransport implements DeviceTransport {
  LocalHttpTransport({required this.baseUrl, this.authToken});

  final String baseUrl;

  /// The device's API password (plaintext) — any Basic Auth username works,
  /// the firmware only checks the password half. Null/empty means no
  /// Authorization header is sent (fine against a fresh device with no
  /// password configured yet).
  final String? authToken;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> _headers({bool json = false}) {
    final headers = <String, String>{};
    if (json) {
      headers['Content-Type'] = 'application/json';
    }
    if (authToken != null && authToken!.isNotEmpty) {
      final creds = base64Encode(utf8.encode('device:$authToken'));
      headers['Authorization'] = 'Basic $creds';
    }
    return headers;
  }

  @override
  Future<DeviceTransportResponse> send(
    String method,
    String path, {
    Object? body,
  }) async {
    final uri = _uri(path);
    final headers = _headers(json: body != null);
    final encodedBody = body == null ? null : jsonEncode(body);

    final http.Response resp;
    switch (method) {
      case 'GET':
        resp = await http.get(uri, headers: headers).timeout(_requestTimeout);
      case 'POST':
        resp = await http
            .post(uri, headers: headers, body: encodedBody)
            .timeout(_requestTimeout);
      case 'DELETE':
        resp = await http
            .delete(uri, headers: headers)
            .timeout(_requestTimeout);
      default:
        throw ArgumentError.value(method, 'method', 'unsupported');
    }

    return DeviceTransportResponse(
      statusCode: resp.statusCode,
      body: resp.body.isEmpty ? null : jsonDecode(resp.body),
    );
  }
}

/// Relays through the backend's WebSocket tunnel to one specific device —
/// see backend_ws_client.dart and backend/src/ws/registry.js's matching
/// server-side relay logic.
class CloudRelayTransport implements DeviceTransport {
  CloudRelayTransport({required this.deviceId, required this.sendCommand});

  final String deviceId;

  /// Bound to a `BackendWsClient.sendCommand` — kept as a plain function
  /// reference (rather than holding the whole client) so this class stays
  /// trivially testable without a real WebSocket.
  final Future<DeviceTransportResponse> Function(
    String deviceId,
    String method,
    String path,
    Object? body,
  )
  sendCommand;

  @override
  Future<DeviceTransportResponse> send(
    String method,
    String path, {
    Object? body,
  }) => sendCommand(deviceId, method, path, body);
}

/// Relays through the backend's plain REST endpoint
/// (`POST /devices/:deviceId/command`, see backend/src/routes/devices.js)
/// instead of a persistent WebSocket — for callers that can't hold one
/// open, namely a headless widget/background-monitor isolate (see
/// isolate_device_relay.dart). [CloudRelayTransport] (above) stays what
/// the main app isolate uses; this is purely additive.
class RestRelayTransport implements DeviceTransport {
  RestRelayTransport({
    required this.backendUrl,
    required this.deviceId,
    required this.accessToken,
  });

  final String backendUrl;
  final String deviceId;
  final String accessToken;

  // Comfortably over the backend's own 10s device relay timeout
  // (RELAY_TIMEOUT_MS in registry.js) so a genuine device_timeout response
  // has time to come back before this client-side timeout fires first.
  static const _relayTimeout = Duration(seconds: 15);

  @override
  Future<DeviceTransportResponse> send(
    String method,
    String path, {
    Object? body,
  }) async {
    final resp = await http
        .post(
          Uri.parse('$backendUrl/devices/$deviceId/command'),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $accessToken',
          },
          body: jsonEncode({'method': method, 'path': path, 'body': body}),
        )
        .timeout(_relayTimeout);

    final decoded = resp.body.isEmpty ? null : jsonDecode(resp.body);
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      // The relay itself failed (device offline/timeout, bad auth) — the
      // backend's own HTTP status/error body, not the device's — surface
      // it as-is so DeviceApiException carries a meaningful message.
      return DeviceTransportResponse(statusCode: resp.statusCode, body: decoded);
    }
    final map = decoded as Map<String, dynamic>;
    return DeviceTransportResponse(
      statusCode: map['status'] as int,
      body: map['body'],
    );
  }
}

/// Tries [local] first; on *any* failure (timeout, connection refused,
/// non-2xx is NOT a failure here — only transport-level exceptions are)
/// falls back to [cloud] if one was supplied. This one combinator is what
/// makes "local-first, cloud-fallback" apply uniformly to every
/// `DeviceApiClient` method with no per-call special-casing.
class FallbackDeviceTransport implements DeviceTransport {
  FallbackDeviceTransport({required this.local, this.cloud});

  final DeviceTransport local;
  final DeviceTransport? cloud;

  @override
  Future<DeviceTransportResponse> send(
    String method,
    String path, {
    Object? body,
  }) async {
    try {
      return await local.send(method, path, body: body);
    } catch (_) {
      final cloudTransport = cloud;
      if (cloudTransport == null) {
        rethrow;
      }
      return cloudTransport.send(method, path, body: body);
    }
  }
}
