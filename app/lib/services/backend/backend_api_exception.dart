import 'dart:convert';

import 'package:http/http.dart' as http;

import '../api_error_body.dart';

/// Thrown on any non-2xx response from the backend. Shared by every
/// backend/* client — mirrors DeviceApiException's shape in
/// device_api_client.dart.
class BackendApiException implements Exception {
  BackendApiException(this.statusCode, this.message, {this.retryAfterSeconds});

  final int statusCode;
  final String message;

  /// See `DeviceApiException.retryAfterSeconds`.
  final int? retryAfterSeconds;

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
  var error = const ApiErrorBody();
  try {
    error = ApiErrorBody.parse(jsonDecode(resp.body));
  } catch (_) {
    // body wasn't JSON — keep the generic message
  }
  throw BackendApiException(
    resp.statusCode,
    error.code ?? 'HTTP ${resp.statusCode}',
    retryAfterSeconds: error.retryAfterSeconds,
  );
}
