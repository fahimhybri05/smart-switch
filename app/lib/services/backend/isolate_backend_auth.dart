import 'package:flutter/foundation.dart';
import 'dart:convert';

import 'package:hive_ce_flutter/hive_ce_flutter.dart';
import 'package:http/http.dart' as http;

import 'credential_store.dart';
import 'jwt.dart';

const _authSessionBoxName = 'auth_session';

/// Lets a headless isolate (a widget tap, the background monitor — neither
/// has access to the running app's Riverpod `ProviderContainer` or
/// in-memory JWT) read, and if needed refresh, the persisted login session
/// on its own. Real precedent: background_monitor_service.dart already
/// reopens Hive boxes directly from its own isolate — this extends that
/// pattern to auth. See docs/plan.md's cloud-aware widget relay section.
class IsolateBackendAuth {
  /// Returns a not-yet-expired access token, or null if not logged in, or
  /// a refresh was needed but failed — including the rotate-on-use race
  /// (refresh tokens are single-use; if the main app isolate refreshed
  /// first, this gets a 401 on an already-revoked token). Either way,
  /// callers should just skip this relay attempt rather than retry — the
  /// race window is narrow enough (WorkManager's 15min floor, sporadic
  /// widget taps) that it isn't worth a cross-isolate lock.
  static Future<String?> getValidAccessToken(String backendUrl) async {
    // Headless isolate (widget tap / background monitor) opening the same
    // `auth_session` box the main app isolate keeps open for its whole
    // lifetime — Hive CE documents this as unsafe
    // (`HiveWarning.unsafeIsolate`: independent per-isolate box caches can
    // corrupt state). A full fix would route this through a platform
    // channel back to the main isolate; out of scope for this pass.
    // Mitigation: open, do the one read (and maybe a refresh-triggered
    // write), close immediately via `finally` below — shrinks, doesn't
    // eliminate, the window both isolates could have this box open at
    // once.
    final box = await Hive.openBox(_authSessionBoxName);
    try {
      final accessToken = box.get('access_token') as String?;
      final refreshToken = box.get('refresh_token') as String?;
      if (accessToken == null || refreshToken == null) {
        debugPrint('IsolateBackendAuth: no saved session in auth_session box');
        return null;
      }
      if (!isJwtExpiredOrExpiringSoon(accessToken)) {
        return accessToken;
      }
      try {
        final resp = await http
            .post(
              Uri.parse('$backendUrl/auth/refresh'),
              headers: {'Content-Type': 'application/json'},
              body: jsonEncode({'refreshToken': refreshToken}),
            )
            .timeout(const Duration(seconds: 8));
        if (resp.statusCode == 401) {
          // Refresh token already rotated by the main app (or expired) —
          // sign back in with the "Remember me" credentials instead.
          return await _reloginAndStore(box, backendUrl);
        }
        if (resp.statusCode != 200) {
          debugPrint('IsolateBackendAuth: refresh failed HTTP ${resp.statusCode}');
          return null;
        }
        return await _storeTokens(box, resp.body);
      } catch (e) {
        debugPrint('IsolateBackendAuth: refresh error $e');
        return null;
      }
    } finally {
      await box.close();
    }
  }

  static Future<String> _storeTokens(Box box, String body) async {
    final json = jsonDecode(body) as Map<String, dynamic>;
    final newAccessToken = json['accessToken'] as String;
    await box.putAll({
      'access_token': newAccessToken,
      'refresh_token': json['refreshToken'] as String,
    });
    return newAccessToken;
  }

  static Future<String?> _reloginAndStore(Box box, String backendUrl) async {
    final creds = await CredentialStore.read();
    if (creds == null || creds.email != box.get('email')) {
      return null;
    }
    final resp = await http
        .post(
          Uri.parse('$backendUrl/auth/login'),
          headers: {'Content-Type': 'application/json'},
          body: jsonEncode({'email': creds.email, 'password': creds.password}),
        )
        .timeout(const Duration(seconds: 8));
    if (resp.statusCode != 200) {
      return null;
    }
    return _storeTokens(box, resp.body);
  }
}
