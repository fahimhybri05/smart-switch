import 'dart:convert';

import 'package:http/http.dart' as http;

import '../../models/local/household.dart';
import 'backend_api_exception.dart';

const _requestTimeout = Duration(seconds: 8);

/// One method per `/households/*` endpoint (see
/// backend/src/routes/households.js). Callers must supply an already-fresh
/// access token — see `ensureFreshAccessToken`/`ensureFreshAccessTokenForNotifier`
/// in providers/service_providers.dart.
class BackendHouseholdsClient {
  BackendHouseholdsClient({required this.baseUrl, required this.accessToken});

  final String baseUrl;
  final String accessToken;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $accessToken',
  };

  Future<List<Household>> list() async {
    final resp = await http
        .get(_uri('/households'), headers: _headers)
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return (json['households'] as List<dynamic>)
        .map((e) => Household.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> rename(int householdId, String name) async {
    final resp = await http
        .patch(
          _uri('/households/$householdId'),
          headers: _headers,
          body: jsonEncode({'name': name}),
        )
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }

  Future<void> setTimezone(int householdId, String timezone) async {
    final resp = await http
        .patch(
          _uri('/households/$householdId'),
          headers: _headers,
          body: jsonEncode({'timezone': timezone}),
        )
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }

  /// Throws [BackendApiException] with statusCode 404 if [email] has no
  /// account — no email is sent (in-app only, see docs/plan.md).
  Future<void> invite(int householdId, String email) async {
    final resp = await http
        .post(
          _uri('/households/$householdId/invite'),
          headers: _headers,
          body: jsonEncode({'email': email}),
        )
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }

  Future<List<HouseholdInvite>> listInvites() async {
    final resp = await http
        .get(_uri('/households/invites'), headers: _headers)
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return (json['invites'] as List<dynamic>)
        .map((e) => HouseholdInvite.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> acceptInvite(int inviteId) async {
    final resp = await http
        .post(_uri('/households/invites/$inviteId/accept'), headers: _headers)
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }

  Future<void> declineInvite(int inviteId) async {
    final resp = await http
        .post(
          _uri('/households/invites/$inviteId/decline'),
          headers: _headers,
        )
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }

  Future<void> removeMember(int householdId, int userId) async {
    final resp = await http
        .delete(
          _uri('/households/$householdId/members/$userId'),
          headers: _headers,
        )
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }
}
