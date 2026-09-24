import 'dart:async';

import 'package:http/http.dart' as http;

import '../../services/api_error_body.dart';
import '../../services/backend/backend_api_exception.dart';
import '../../services/backend/backend_ws_client.dart';
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
  final (code, retryAfterSeconds) = commandErrorOf(error);
  final commandMessage = friendlyCommandError(code, retryAfterSeconds);
  if (commandMessage != null) {
    return commandMessage;
  }
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

/// Pulls the backend error code (+ min-off retry hint) out of whichever
/// exception type the command path produced: a LAN/REST-relay
/// [DeviceApiException] (423/409 JSON), a WS-relay [CloudRelayException]
/// (`{status: 0, error, retryAfterSeconds}`), or a [BackendApiException].
(String?, int?) commandErrorOf(Object error) => switch (error) {
  DeviceApiException(:final message, :final retryAfterSeconds) => (
    message,
    retryAfterSeconds,
  ),
  CloudRelayException(:final message, :final retryAfterSeconds) => (
    message,
    retryAfterSeconds,
  ),
  BackendApiException(:final message, :final retryAfterSeconds) => (
    message,
    retryAfterSeconds,
  ),
  _ => (null, null),
};

/// User-facing text for a rejected-command error code, or null when [code]
/// isn't one of the safety/lock codes. Also used for per-action scene run
/// results, which carry the bare code string.
String? friendlyCommandError(String? code, int? retryAfterSeconds) {
  switch (code) {
    case CommandErrorCodes.switchLocked:
      return 'This switch is locked.';
    case CommandErrorCodes.minOffTime:
      if (retryAfterSeconds == null || retryAfterSeconds <= 0) {
        return 'Protection: wait a moment before turning it on again.';
      }
      final minutes = (retryAfterSeconds / 60).ceil();
      return 'Protection: wait $minutes min before turning it on again.';
  }
  return null;
}
