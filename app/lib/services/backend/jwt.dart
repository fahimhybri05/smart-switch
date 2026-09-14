import 'dart:convert';

/// Decodes a JWT's payload without verifying the signature — only used
/// client-side to decide whether a proactive refresh is worth doing before
/// a call; the backend remains the actual source of truth for validity.
Map<String, dynamic> decodeJwtPayload(String token) {
  final parts = token.split('.');
  if (parts.length != 3) {
    throw const FormatException('not a JWT');
  }
  var payload = parts[1];
  final remainder = payload.length % 4;
  if (remainder != 0) {
    payload += '=' * (4 - remainder);
  }
  return jsonDecode(utf8.decode(base64Url.decode(payload)))
      as Map<String, dynamic>;
}

DateTime? jwtExpiry(String token) {
  try {
    final exp = decodeJwtPayload(token)['exp'];
    if (exp is int) {
      return DateTime.fromMillisecondsSinceEpoch(exp * 1000);
    }
  } catch (_) {
    // malformed token — treated as expired by the caller
  }
  return null;
}

bool isJwtExpiredOrExpiringSoon(
  String token, {
  Duration buffer = const Duration(seconds: 30),
}) {
  final expiry = jwtExpiry(token);
  if (expiry == null) {
    return true;
  }
  return DateTime.now().isAfter(expiry.subtract(buffer));
}
