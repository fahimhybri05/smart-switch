import 'dart:convert';

import 'package:http/http.dart' as http;

/// Thrown on any non-2xx response from the backend. Shared by every
/// backend/* client — mirrors DeviceApiException's shape in
/// device_api_client.dart.
class BackendApiException implements Exception {
  BackendApiException(this.statusCode, this.message);

  final int statusCode;
  final String message;

  @override
  String toString() => 'BackendApiException($statusCode): $message';
}

Future<Map<String, dynamic>> decodeBackendResponseOrThrow(
  http.Response resp,
) async {
  if (resp.statusCode >= 200 && resp.statusCode < 300) {
    if (resp.body.isEmpty) {
      return {};
    }
    return jsonDecode(resp.body) as Map<String, dynamic>;
  }
  String message = 'HTTP ${resp.statusCode}';
  try {
    final decoded = jsonDecode(resp.body) as Map<String, dynamic>;
    if (decoded['error'] is String) {
      message = decoded['error'] as String;
    }
  } catch (_) {
    // body wasn't JSON — keep the generic message
  }
  throw BackendApiException(resp.statusCode, message);
}
