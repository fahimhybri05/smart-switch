import 'dart:async';

import 'package:http/http.dart' as http;

import '../../services/device_api_client.dart';

/// Maps a raw exception thrown by a device/backend call into a short,
/// plain-language message safe to show directly in the UI (e.g. a
/// SnackBar) — callers should use this instead of interpolating the raw
/// exception (`'$e'`), which can leak technical details like
/// `DeviceApiException(401): ...` or raw socket error text.
///
/// [action] is a short present-tense description of what was being
/// attempted (e.g. `'Toggle'`, `'Save'`) — used only in the generic
/// fallback message.
String friendlyErrorMessage(Object error, String action) {
  if (error is DeviceApiException && error.statusCode == 401) {
    return 'Your session expired — please sign in again.';
  }
  // Every network-level failure from package:http (connection refused, DNS
  // failure, etc., on both IO and web) surfaces as `http.ClientException` —
  // see io_client.dart's `_ClientSocketException`, which implements both
  // `ClientException` and `SocketException`, so checking the former alone
  // covers it without an IO-only import that would break web builds.
  if (error is TimeoutException || error is http.ClientException) {
    return 'Check your connection and try again.';
  }
  return '$action failed. Please try again.';
}
