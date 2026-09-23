import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const _emailKey = 'saved_email';
const _passwordKey = 'saved_password';

/// "Remember me" login credentials, kept in the platform's encrypted
/// storage (Android Keystore / iOS Keychain) — never in the plain Hive
/// boxes the session tokens live in. Used to prefill the login form and to
/// sign back in silently when the refresh token is rejected, from the app
/// or from a headless widget/background isolate. Every call swallows
/// storage errors: a missing credential just means "ask the user".
class CredentialStore {
  static const _storage = FlutterSecureStorage();

  static Future<({String email, String password})?> read() async {
    try {
      final email = await _storage.read(key: _emailKey);
      final password = await _storage.read(key: _passwordKey);
      if (email == null || password == null) {
        return null;
      }
      return (email: email, password: password);
    } catch (_) {
      return null;
    }
  }

  static Future<void> save(String email, String password) async {
    try {
      await _storage.write(key: _emailKey, value: email);
      await _storage.write(key: _passwordKey, value: password);
    } catch (_) {}
  }

  static Future<void> clear() async {
    try {
      await _storage.delete(key: _emailKey);
      await _storage.delete(key: _passwordKey);
    } catch (_) {}
  }
}
