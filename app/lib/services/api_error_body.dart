/// Error codes the backend returns when it rejects a remote ON/OFF command
/// (see the user-features contract: lock + min-off-time enforcement). The
/// same codes arrive over every command path — the device's LAN API
/// (which forwards to the backend), the REST relay (423/409 JSON), the
/// client WebSocket relay (`{status: 0, error, retryAfterSeconds}`) and
/// per-action scene run results.
abstract final class CommandErrorCodes {
  static const switchLocked = 'switch_locked';
  static const minOffTime = 'min_off_time';
}

/// The one place an error response body is parsed, so every client
/// (`DeviceApiClient`, the backend REST clients, `BackendWsClient`) reads
/// the same shapes the same way:
///
/// - `{error: "code", retryAfterSeconds?: n}` — REST, WS relay, device API
/// - `{error: {code, message, retryAfterSeconds?}}` — `/v1` and hook URLs
class ApiErrorBody {
  const ApiErrorBody({this.code, this.retryAfterSeconds});

  /// The machine-readable error string, e.g. [CommandErrorCodes.switchLocked].
  final String? code;

  /// Only set for [CommandErrorCodes.minOffTime].
  final int? retryAfterSeconds;

  static ApiErrorBody parse(Object? body) {
    if (body is! Map) {
      return const ApiErrorBody();
    }
    final error = body['error'];
    var retry = parseRetryAfter(body['retryAfterSeconds']);
    String? code;
    if (error is String) {
      code = error;
    } else if (error is Map) {
      final nested = error['code'];
      code = nested is String ? nested : null;
      retry ??= parseRetryAfter(error['retryAfterSeconds']);
    }
    return ApiErrorBody(code: code, retryAfterSeconds: retry);
  }

  static int? parseRetryAfter(Object? value) =>
      value is num ? value.ceil() : null;
}
