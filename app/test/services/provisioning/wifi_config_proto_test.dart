import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/services/provisioning/proto_wire.dart';
import 'package:smart_switch/services/provisioning/wifi_config_proto.dart';

/// Builds a `WiFiConfigPayload`-shaped `RespSetConfig`/`RespApplyConfig`
/// response with the given status, mirroring what the device would send.
Uint8List _statusResponse(int payloadField, int status) {
  final resp = ProtoWriter()..writeVarint(1, status);
  return (ProtoWriter()..writeMessage(payloadField, resp.toBytes())).toBytes();
}

void main() {
  test('buildSetConfigRequest embeds ssid/password as bytes', () {
    final bytes = buildSetConfigRequest(ssid: 'HomeNet', password: 'hunter2');
    final payload = decodeMessage(bytes);
    expect(payload[1]?.varintValue, 2); // TypeCmdSetConfig
    final cmd = decodeMessage(payload[12]!.bytesValue!);
    expect(utf8.decode(cmd[1]!.bytesValue!), 'HomeNet');
    expect(utf8.decode(cmd[2]!.bytesValue!), 'hunter2');
  });

  test('parseSetConfigResponse reads Success', () {
    expect(parseSetConfigResponse(_statusResponse(13, 0)), isTrue);
  });

  test('parseSetConfigResponse reads a non-Success status as failure', () {
    expect(parseSetConfigResponse(_statusResponse(13, 4)), isFalse);
  });

  test(
    'buildApplyConfigRequest sends only the msg field, no payload oneof',
    () {
      final bytes = buildApplyConfigRequest();
      final payload = decodeMessage(bytes);
      expect(payload[1]?.varintValue, 4); // TypeCmdApplyConfig
      expect(payload.containsKey(14), isFalse);
    },
  );

  test('parseApplyConfigResponse reads Success', () {
    expect(parseApplyConfigResponse(_statusResponse(15, 0)), isTrue);
  });

  test('buildGetStatusRequest explicitly populates the empty CmdGetStatus', () {
    final payload = decodeMessage(buildGetStatusRequest());
    expect(payload[1]?.varintValue, 0); // TypeCmdGetStatus
    expect(payload[10]?.bytesValue, isNotNull);
  });

  test(
    'parseGetStatusResponse maps sta_state to WifiStationState.connected',
    () {
      final statusMsg = ProtoWriter()
        ..writeVarint(1, 0) // Status.Success
        ..writeVarint(2, 0); // WifiStationState.Connected
      final bytes = (ProtoWriter()..writeMessage(11, statusMsg.toBytes()))
          .toBytes();

      final result = parseGetStatusResponse(bytes);
      expect(result.state, WifiStationState.connected);
      expect(result.failReason, isNull);
    },
  );

  test('parseGetStatusResponse surfaces fail_reason only when failed', () {
    final statusMsg = ProtoWriter()
      ..writeVarint(1, 0)
      ..writeVarint(2, 3) // WifiStationState.ConnectionFailed
      ..writeVarint(10, 0); // WifiConnectFailedReason.AuthError
    final bytes = (ProtoWriter()..writeMessage(11, statusMsg.toBytes()))
        .toBytes();

    final result = parseGetStatusResponse(bytes);
    expect(result.state, WifiStationState.failed);
    expect(result.failReason, WifiFailReason.authError);
  });

  test(
    'parseGetStatusResponse defaults to unknown when payload is missing',
    () {
      final result = parseGetStatusResponse(
        (ProtoWriter()..writeVarint(99, 1)).toBytes(),
      );
      expect(result.state, WifiStationState.unknown);
    },
  );
}
