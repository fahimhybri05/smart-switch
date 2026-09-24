import 'package:http/http.dart' as http;

import '../../models/local/usage.dart';
import 'backend_api_exception.dart';

const _requestTimeout = Duration(seconds: 10);

/// `GET /devices/:id/usage` and `GET /usage` (see the user-features
/// contract). Wire shapes are parsed in models/local/usage.dart.
class BackendUsageClient {
  BackendUsageClient({required this.baseUrl, required this.accessToken});

  /// The backend accepts 1..90.
  static const maxDays = 90;

  final String baseUrl;
  final String accessToken;

  Map<String, String> get _headers => {'Authorization': 'Bearer $accessToken'};

  Future<UsageReport> deviceUsage(String deviceId, {int days = 7}) async {
    final uri = Uri.parse('$baseUrl/devices/${Uri.encodeComponent(deviceId)}/usage')
        .replace(queryParameters: {'days': '${days.clamp(1, maxDays)}'});
    final resp = await http
        .get(uri, headers: _headers)
        .timeout(_requestTimeout);
    return UsageReport.fromJson(await decodeBackendResponseOrThrow(resp));
  }

  /// [householdId] omitted lets the backend pick the caller's default.
  Future<UsageReport> householdUsage({int? householdId, int days = 7}) async {
    final uri = Uri.parse('$baseUrl/usage').replace(
      queryParameters: {
        'householdId': ?householdId?.toString(),
        'days': '${days.clamp(1, maxDays)}',
      },
    );
    final resp = await http
        .get(uri, headers: _headers)
        .timeout(_requestTimeout);
    return UsageReport.fromJson(await decodeBackendResponseOrThrow(resp));
  }
}
