import 'dart:convert';

import 'package:hive_ce_flutter/hive_ce_flutter.dart';
import 'package:http/http.dart' as http;

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
    final box = await Hive.openBox(_authSessionBoxName);
    final accessToken = box.get('access_token') as String?;
    final refreshToken = box.get('refresh_token') as String?;
    if (accessToken == null || refreshToken == null) {
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
      if (resp.statusCode != 200) {
        return null;
      }
      final json = jsonDecode(resp.body) as Map<String, dynamic>;
      final newAccessToken = json['accessToken'] as String;
      final newRefreshToken = json['refreshToken'] as String;
      await box.putAll({
        'access_token': newAccessToken,
        'refresh_token': newRefreshToken,
      });
      return newAccessToken;
    } catch (_) {
      return null;
    }
  }
}
