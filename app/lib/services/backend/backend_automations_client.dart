import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../models/local/automation.dart';
import 'backend_api_exception.dart';

const _requestTimeout = Duration(seconds: 8);

/// One method per `/automations/*` endpoint (see
/// backend/src/routes/automations.js). Callers must supply an
/// already-fresh access token — see
/// `ensureFreshAccessToken`/`ensureFreshAccessTokenForNotifier` in
/// providers/service_providers.dart.
class BackendAutomationsClient {
  BackendAutomationsClient({required this.baseUrl, required this.accessToken});

  final String baseUrl;
  final String accessToken;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $accessToken',
  };

  /// [householdId] omitted returns every automation across every household
  /// the caller belongs to (mirrors devices/groups' default listing).
  Future<List<Automation>> list({int? householdId}) async {
    final query = householdId == null ? '' : '?householdId=$householdId';
    final resp = await http
        .get(_uri('/automations$query'), headers: _headers)
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return (json['automations'] as List<dynamic>)
        .map((e) => Automation.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// [id] omitted creates a new automation; given, replaces it entirely.
  /// Owner-only server-side (see docs/plan.md's roles decision).
  Future<Automation> upsert({
    int? id,
    int? householdId,
    required String name,
    required bool enabled,
    required AutomationTrigger trigger,
    required List<AutomationAction> actions,
  }) async {
    final resp = await http
        .post(
          _uri('/automations'),
          headers: _headers,
          body: jsonEncode({
            'id': ?id,
            'householdId': ?householdId,
            'name': name,
            'enabled': enabled,
            'trigger': trigger.toJson(),
            'actions': actions.map((a) => a.toJson()).toList(),
          }),
        )
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return Automation.fromJson(json);
  }

  Future<void> delete(int id) async {
    final resp = await http
        .delete(_uri('/automations/$id'), headers: _headers)
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }
}
