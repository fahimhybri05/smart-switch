import 'package:hive_ce_flutter/hive_ce_flutter.dart';

const _boxName = 'auth_session';
const _accessTokenKey = 'access_token';
const _refreshTokenKey = 'refresh_token';
const _emailKey = 'email';

/// One logged-in session for the backend (spec: docs/plan.md's "Flutter app
/// — remote mode"). Same open/init pattern as device_registry_service.dart.
class AuthSessionService {
  Box? _box;

  Future<void> init() async {
    _box = await Hive.openBox(_boxName);
  }

  Box get _requireBox {
    final box = _box;
    if (box == null) {
      throw StateError('AuthSessionService.init() must be called before use');
    }
    return box;
  }

  ({String accessToken, String refreshToken, String email})? getSession() {
    final accessToken = _requireBox.get(_accessTokenKey) as String?;
    final refreshToken = _requireBox.get(_refreshTokenKey) as String?;
    final email = _requireBox.get(_emailKey) as String?;
    if (accessToken == null || refreshToken == null || email == null) {
      return null;
    }
    return (accessToken: accessToken, refreshToken: refreshToken, email: email);
  }

  Future<void> saveSession({
    required String accessToken,
    required String refreshToken,
    required String email,
  }) async {
    await _requireBox.putAll({
      _accessTokenKey: accessToken,
      _refreshTokenKey: refreshToken,
      _emailKey: email,
    });
  }

  /// Just updates the access token — used after a silent refresh, where the
  /// email/refresh token stay the same (or the refresh token also rotated,
  /// in which case pass both).
  Future<void> updateTokens({
    required String accessToken,
    required String refreshToken,
  }) async {
    await _requireBox.putAll({
      _accessTokenKey: accessToken,
      _refreshTokenKey: refreshToken,
    });
  }

  Future<void> clear() async {
    await _requireBox.clear();
  }
}
