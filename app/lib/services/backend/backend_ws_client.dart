import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../device_transport.dart';

class CloudRelayException implements Exception {
  CloudRelayException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// One shared WebSocket connection to the backend's `/ws` endpoint (see
/// backend/src/ws/clientServer.js), reused for every claimed device — the
/// wire protocol addresses commands by `deviceId` per message, not by
/// having one socket per device.
class BackendWsClient {
  BackendWsClient({required String wsUrl, required String accessToken})
    : _wsUrl = wsUrl,
      _accessToken = accessToken {
    // Connect eagerly, not just lazily on the first sendCommand — otherwise
    // a phone that only ever controls devices over the local LAN (never
    // triggers a CloudRelayTransport call) would never open this socket at
    // all, and `stateChanges` push would silently never start despite being
    // logged in with a backend configured. Errors are swallowed here;
    // _scheduleReconnect (called from the failure path) takes over.
    unawaited(_ensureConnected().catchError((_) {}));
  }

  final String _wsUrl;
  final String _accessToken;

  WebSocketChannel? _channel;
  Future<void>? _connecting;
  bool _closed = false;
  int _consecutiveFailures = 0;
  Timer? _reconnectTimer;
  int _nextReqId = 0;
  final _pending = <String, Completer<DeviceTransportResponse>>{};
  final _stateChangeController =
      StreamController<Map<String, dynamic>>.broadcast();

  /// Unsolicited `{event: "state_changed", deviceId, channelIdx, state}`
  /// pushes — consumed by `channelStatePushListenerProvider`
  /// (service_providers.dart), which invalidates the matching device's
  /// `channelStatesProvider` on each push so a remote toggle lands as soon
  /// as the push arrives instead of waiting for the next poll tick. Kept
  /// flowing for as long as this client is alive: a dropped socket
  /// auto-reconnects (see _scheduleReconnect) rather than silently going
  /// quiet until something happens to call sendCommand again.
  Stream<Map<String, dynamic>> get stateChanges =>
      _stateChangeController.stream;

  Future<void> _ensureConnected() {
    if (_channel != null) {
      return Future.value();
    }
    return _connecting ??= _connect().whenComplete(() => _connecting = null);
  }

  Future<void> _connect() async {
    final uri = Uri.parse(
      _wsUrl,
    ).replace(queryParameters: {'token': _accessToken});
    final channel = WebSocketChannel.connect(uri);
    try {
      await channel.ready;
    } catch (_) {
      _scheduleReconnect();
      rethrow;
    }
    _channel = channel;
    _consecutiveFailures = 0;
    _reconnectTimer?.cancel();
    channel.stream.listen(
      _handleMessage,
      onDone: _handleDisconnect,
      onError: (_) => _handleDisconnect(),
      cancelOnError: false,
    );
  }

  void _handleDisconnect() {
    _channel = null;
    _failAllPending('connection dropped');
    _scheduleReconnect();
  }

  /// Rejects every in-flight [sendCommand] immediately instead of leaving
  /// each to discover the drop on its own 10s timeout — the drop is already
  /// known here, so there's no reason to make callers wait out a timeout
  /// for news that's already in. Copies [_pending]'s values before clearing
  /// it so completing them can't mutate the map while this iterates it.
  void _failAllPending(String reason) {
    if (_pending.isEmpty) {
      return;
    }
    final inFlight = _pending.values.toList();
    _pending.clear();
    for (final completer in inFlight) {
      completer.completeError(CloudRelayException(reason));
    }
  }

  /// Doubling backoff capped at 30s, plus jitter — same shape as this
  /// codebase's other reconnect-backoff spots (cloud_client.cpp,
  /// http_auth.cpp's lockout). Keeps a brief blip reconnecting almost
  /// immediately while not hammering a genuinely down backend forever.
  void _scheduleReconnect() {
    if (_closed) {
      return;
    }
    _reconnectTimer?.cancel();
    final shift = _consecutiveFailures.clamp(0, 5);
    final backoffMs = (1000 * (1 << shift)).clamp(1000, 30000);
    _consecutiveFailures++;
    final jitterMs = Random().nextInt(1000);
    _reconnectTimer = Timer(Duration(milliseconds: backoffMs + jitterMs), () {
      if (!_closed) {
        unawaited(_ensureConnected().catchError((_) {}));
      }
    });
  }

  /// Triggers an immediate reconnect attempt instead of waiting out
  /// whatever's left of [_scheduleReconnect]'s backoff timer — called from
  /// `app.dart`'s `WidgetsBindingObserver` on `AppLifecycleState.resumed`,
  /// since the OS may have silently dropped the socket while backgrounded
  /// and the timer-driven backoff alone can leave WS push (near-instant
  /// remote state updates) lagging up to 30s after the user returns. Safe
  /// no-op if already connected (nothing to do) or already mid-connect
  /// (`_ensureConnected` dedupes via `_connecting`, same as every other
  /// caller) or if this client has been [close]d.
  void reconnectNow() {
    if (_closed || _channel != null) {
      return;
    }
    _reconnectTimer?.cancel();
    unawaited(_ensureConnected().catchError((_) {}));
  }

  void _handleMessage(dynamic raw) {
    final Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }

    if (msg['event'] != null) {
      _stateChangeController.add(msg);
      return;
    }

    final reqId = msg['reqId'] as String?;
    final completer = reqId == null ? null : _pending.remove(reqId);
    if (completer == null) {
      return; // already timed out, or an unmatched frame
    }

    final status = msg['status'] as int? ?? 0;
    if (status == 0) {
      completer.completeError(
        CloudRelayException(msg['error'] as String? ?? 'cloud_relay_error'),
      );
    } else {
      completer.complete(
        DeviceTransportResponse(statusCode: status, body: msg['body']),
      );
    }
  }

  /// Matches `CloudRelayTransport`'s expected function shape exactly (see
  /// device_transport.dart) — pass this method reference directly.
  Future<DeviceTransportResponse> sendCommand(
    String deviceId,
    String method,
    String path,
    Object? body,
  ) async {
    await _ensureConnected();

    final reqId = 'req-${_nextReqId++}';
    final completer = Completer<DeviceTransportResponse>();
    _pending[reqId] = completer;

    _channel!.sink.add(
      jsonEncode({
        'reqId': reqId,
        'deviceId': deviceId,
        'method': method,
        'path': path,
        'body': body,
      }),
    );

    return completer.future.timeout(
      const Duration(seconds: 10),
      onTimeout: () {
        _pending.remove(reqId);
        throw CloudRelayException('cloud relay timed out');
      },
    );
  }

  Future<void> close() async {
    _closed = true;
    _reconnectTimer?.cancel();
    _failAllPending('connection closed');
    await _channel?.sink.close();
    _channel = null;
  }
}
