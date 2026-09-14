import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../models/local/switch_group.dart';
import 'backend_api_exception.dart';

const _requestTimeout = Duration(seconds: 8);

/// One method per `/groups/*` endpoint (see backend/src/routes/groups.js).
/// Groups are account-wide now, not phone-local — every member device must
/// already be claimed by the same account (the backend validates this
/// server-side). Callers must supply an already-fresh access token — see
/// `ensureFreshAccessToken` in providers/service_providers.dart.
class BackendGroupsClient {
  BackendGroupsClient({required this.baseUrl, required this.accessToken});

  final String baseUrl;
  final String accessToken;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $accessToken',
  };

  Future<List<SwitchGroup>> list() async {
    final resp = await http
        .get(_uri('/groups'), headers: _headers)
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return (json['groups'] as List<dynamic>)
        .map((e) => _groupFromBackendJson(e as Map<String, dynamic>))
        .toList();
  }

  /// [id] omitted creates a new group; given, replaces the named group's
  /// name + full member list. Returns the saved group (with its real,
  /// backend-assigned id when creating).
  Future<SwitchGroup> upsert({
    String? id,
    required String name,
    required List<GroupMember> members,
  }) async {
    final resp = await http
        .post(
          _uri('/groups'),
          headers: _headers,
          body: jsonEncode({
            'id': ?(id == null ? null : int.parse(id)),
            'name': name,
            // Note: camelCase here, unlike GroupMember.toJson()'s
            // snake_case (that shape is for the local Hive cache) — the
            // backend's zod schema expects {deviceId, channelIdx}.
            'members': members
                .map(
                  (m) => {'deviceId': m.deviceId, 'channelIdx': m.channelIdx},
                )
                .toList(),
          }),
        )
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return _groupFromBackendJson(json);
  }

  Future<void> delete(String id) async {
    final resp = await http
        .delete(_uri('/groups/$id'), headers: _headers)
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }

  SwitchGroup _groupFromBackendJson(Map<String, dynamic> json) => SwitchGroup(
    id: (json['id'] as num).toString(),
    name: json['name'] as String,
    members: (json['members'] as List<dynamic>)
        .map(
          (e) => GroupMember(
            deviceId: (e as Map<String, dynamic>)['deviceId'] as String,
            channelIdx: e['channelIdx'] as int,
          ),
        )
        .toList(),
  );
}
