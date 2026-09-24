import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../models/local/scene.dart';
import 'backend_api_exception.dart';

const _requestTimeout = Duration(seconds: 8);

// Running a scene fans out device commands in parallel on the backend, each
// bounded by its own ~10s device relay timeout — leave room for that.
const _runTimeout = Duration(seconds: 20);

/// One method per `/scenes/*` endpoint (see the user-features contract).
/// Wire shapes are parsed in models/local/scene.dart. Callers must supply
/// an already-fresh access token — see `ensureFreshAccessTokenForNotifier`
/// in providers/service_providers.dart.
class BackendScenesClient {
  BackendScenesClient({required this.baseUrl, required this.accessToken});

  final String baseUrl;
  final String accessToken;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $accessToken',
  };

  /// [householdId] omitted returns scenes across every household the
  /// caller belongs to.
  Future<List<Scene>> list({int? householdId}) async {
    final query = householdId == null ? '' : '?householdId=$householdId';
    final resp = await http
        .get(_uri('/scenes$query'), headers: _headers)
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return ((json['scenes'] as List<dynamic>?) ?? const [])
        .map((e) => Scene.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// [id] omitted creates a new scene; given, replaces it.
  Future<Scene> upsert({
    int? id,
    int? householdId,
    required String name,
    String? icon,
    required List<SceneAction> actions,
  }) async {
    final resp = await http
        .post(
          _uri('/scenes'),
          headers: _headers,
          body: jsonEncode(
            Scene.upsertBody(
              id: id,
              householdId: householdId,
              name: name,
              icon: icon,
              actions: actions,
            ),
          ),
        )
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    // Accept either the bare scene or a `{scene: {...}}` wrapper.
    final scene = json['scene'] is Map<String, dynamic>
        ? json['scene'] as Map<String, dynamic>
        : json;
    return Scene.fromJson(scene);
  }

  Future<void> delete(int id) async {
    final resp = await http
        .delete(_uri('/scenes/$id'), headers: _headers)
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }

  Future<SceneRunSummary> run(int id) async {
    final resp = await http
        .post(_uri('/scenes/$id/run'), headers: _headers)
        .timeout(_runTimeout);
    return SceneRunSummary.fromJson(await decodeBackendResponseOrThrow(resp));
  }
}
