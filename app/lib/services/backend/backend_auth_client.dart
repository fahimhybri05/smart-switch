import 'dart:convert';

import 'package:http/http.dart' as http;

import 'backend_api_exception.dart';

const _requestTimeout = Duration(seconds: 8);

typedef TokenPair = ({String accessToken, String refreshToken});

/// `GET /auth/me` — the signed-in account, for the Account screen.
typedef AccountInfo = ({
  String email,
  DateTime? createdAt,
  List<({String name, String role})> households,
});

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

  Map<String, String> _authHeaders(String accessToken) => {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $accessToken',
  };

  Future<AccountInfo> me(String accessToken) async {
    final resp = await http
        .get(_uri('/auth/me'), headers: _authHeaders(accessToken))
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    final created = json['createdAt'];
    return (
      email: json['email'] as String,
      createdAt: created is String ? DateTime.tryParse(created) : null,
      households: [
        for (final h in (json['households'] as List<dynamic>? ?? const []))
          (
            name: (h as Map<String, dynamic>)['name'] as String? ?? 'Home',
            role: h['role'] as String? ?? 'member',
          ),
      ],
    );
  }

  /// Signs out every other session (all refresh tokens revoked server-side)
  /// and returns a fresh pair for this one. 403 = wrong current password.
  Future<TokenPair> changePassword(
    String accessToken, {
    required String currentPassword,
    required String newPassword,
  }) async {
    final resp = await http
        .patch(
          _uri('/auth/password'),
          headers: _authHeaders(accessToken),
          body: jsonEncode({
            'currentPassword': currentPassword,
            'newPassword': newPassword,
          }),
        )
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return (
      accessToken: json['accessToken'] as String,
      refreshToken: json['refreshToken'] as String,
    );
  }

  /// Returns the stored (normalized, lower-cased) email. 403 = wrong
  /// password, 409 = email already registered.
  Future<String> changeEmail(
    String accessToken, {
    required String newEmail,
    required String password,
  }) async {
    final resp = await http
        .patch(
          _uri('/auth/email'),
          headers: _authHeaders(accessToken),
          body: jsonEncode({'newEmail': newEmail, 'password': password}),
        )
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return json['email'] as String? ?? newEmail;
  }

  /// Permanently deletes the account. 403 = wrong password, 409 = last admin.
  Future<void> deleteAccount(
    String accessToken, {
    required String password,
  }) async {
    final resp = await http
        .delete(
          _uri('/auth/account'),
          headers: _authHeaders(accessToken),
          body: jsonEncode({'password': password}),
        )
        .timeout(_requestTimeout);
    await decodeBackendResponseOrThrow(resp);
  }
}
