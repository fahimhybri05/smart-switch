import 'dart:async';
import 'dart:convert';

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
      _accessToken = accessToken;

  final String _wsUrl;
  final String _accessToken;

  WebSocketChannel? _channel;
  Future<void>? _connecting;
  int _nextReqId = 0;
  final _pending = <String, Completer<DeviceTransportResponse>>{};
  final _stateChangeController =
      StreamController<Map<String, dynamic>>.broadcast();

  /// Unsolicited `{event: "state_changed", deviceId, channelIdx, state}`
  /// pushes — not wired into any provider yet (see docs/plan.md's
  /// "explicitly out of scope this pass"), exposed for a future consumer.
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
    await channel.ready;
    _channel = channel;
    channel.stream.listen(
      _handleMessage,
      onDone: () => _channel = null,
      onError: (_) => _channel = null,
      cancelOnError: false,
    );
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
    await _channel?.sink.close();
    _channel = null;
  }
}
