import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../models/device/device_health.dart';
import 'backend_api_exception.dart';

const _requestTimeout = Duration(seconds: 8);

class CloudDeviceSummary {
  const CloudDeviceSummary({
    required this.deviceId,
    required this.friendlyName,
    required this.isOnline,
  });

  final String deviceId;
  final String friendlyName;
  final bool isOnline;

  factory CloudDeviceSummary.fromJson(Map<String, dynamic> json) =>
      CloudDeviceSummary(
        deviceId: json['device_id'] as String,
        friendlyName:
            json['friendly_name'] as String? ?? json['device_id'] as String,
        isOnline: json['is_online'] as bool? ?? false,
      );
}

/// One method per `/devices/*` endpoint (see backend/src/routes/devices.js).
/// Callers must supply an already-fresh access token — see
/// `ensureFreshAccessToken` in providers/service_providers.dart.
class BackendDevicesClient {
  BackendDevicesClient({required this.baseUrl, required this.accessToken});

  final String baseUrl;
  final String accessToken;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $accessToken',
  };

  Future<void> claim({
    required String deviceId,
    required String cloudSecret,
    String? friendlyName,
  }) async {
    final resp = await http
        .post(
          _uri('/devices/claim'),
          headers: _headers,
          body: jsonEncode({
            'deviceId': deviceId,
            'cloudSecret': cloudSecret,
            'friendlyName': ?friendlyName,
          }),
        )
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }

  Future<List<CloudDeviceSummary>> list() async {
    final resp = await http
        .get(_uri('/devices'), headers: _headers)
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return (json['devices'] as List<dynamic>)
        .map((e) => CloudDeviceSummary.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// Updates the account-wide canonical name — propagates to every other
  /// phone logged into the same account on their next
  /// `syncClaimedDevicesFromBackend` (see service_providers.dart). Unlike
  /// [claim], doesn't need the device's `cloudSecret`.
  Future<void> rename(String deviceId, String friendlyName) async {
    final resp = await http
        .patch(
          _uri('/devices/$deviceId'),
          headers: _headers,
          body: jsonEncode({'friendlyName': friendlyName}),
        )
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }

  Future<DeviceHealth> health(String deviceId) async {
    final resp = await http
        .get(
          _uri('/devices/${Uri.encodeComponent(deviceId)}/health'),
          headers: _headers,
        )
        .timeout(_requestTimeout);
    return DeviceHealth.fromJson(await decodeBackendResponseOrThrow(resp));
  }

  Future<void> unclaim(String deviceId) async {
    final resp = await http
        .delete(_uri('/devices/$deviceId'), headers: _headers)
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }
}
