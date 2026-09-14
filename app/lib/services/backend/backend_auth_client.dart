import 'dart:convert';

import 'package:http/http.dart' as http;

import 'backend_api_exception.dart';

const _requestTimeout = Duration(seconds: 8);

typedef TokenPair = ({String accessToken, String refreshToken});

/// One method per `/auth/*` endpoint (see backend/src/routes/auth.js).
/// A single instance targets one backend deployment directly.
class BackendAuthClient {
  BackendAuthClient({required this.baseUrl});

  final String baseUrl;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Future<TokenPair> _postCredentials(
    String path,
    String email,
    String password,
  ) async {
    final resp = await http
        .post(
          _uri(path),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'email': email, 'password': password}),
        )
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return (
      accessToken: json['accessToken'] as String,
      refreshToken: json['refreshToken'] as String,
    );
  }

  Future<TokenPair> signup(String email, String password) =>
      _postCredentials('/auth/signup', email, password);

  Future<TokenPair> login(String email, String password) =>
      _postCredentials('/auth/login', email, password);

  Future<TokenPair> refresh(String refreshToken) async {
    final resp = await http
        .post(
          _uri('/auth/refresh'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'refreshToken': refreshToken}),
        )
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return (
      accessToken: json['accessToken'] as String,
      refreshToken: json['refreshToken'] as String,
    );
  }

  /// Best-effort — callers should clear local session state regardless of
  /// whether this succeeds (matches the backend accepting any refresh
  /// token value, valid or not, and just returning 204 either way).
  Future<void> logout(String refreshToken) async {
    await http
        .post(
          _uri('/auth/logout'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'refreshToken': refreshToken}),
        )
        .timeout(_requestTimeout);
  }
}
