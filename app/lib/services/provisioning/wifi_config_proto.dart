import 'dart:convert';
import 'dart:typed_data';

import 'proto_wire.dart';

// WiFiConfigMsgType (wifi_provisioning/proto/wifi_config.proto)
const _typeCmdGetStatus = 0;
const _typeCmdSetConfig = 2;
const _typeCmdApplyConfig = 4;

// Status (protocomm/proto/constants.proto)
const _statusSuccess = 0;

/// WifiStationState (wifi_provisioning/proto/wifi_constants.proto).
enum WifiStationState { connected, connecting, disconnected, failed, unknown }

WifiStationState _stationStateFromWire(int? value) => switch (value) {
  0 => WifiStationState.connected,
  1 => WifiStationState.connecting,
  2 => WifiStationState.disconnected,
  3 => WifiStationState.failed,
  _ => WifiStationState.unknown,
};

/// WifiConnectFailedReason (wifi_provisioning/proto/wifi_constants.proto).
enum WifiFailReason { authError, networkNotFound, unknown }

WifiFailReason _failReasonFromWire(int? value) => switch (value) {
  0 => WifiFailReason.authError,
  1 => WifiFailReason.networkNotFound,
  _ => WifiFailReason.unknown,
};

/// `WiFiConfigPayload{msg=TypeCmdSetConfig, cmd_set_config:{ssid,passphrase}}`.
Uint8List buildSetConfigRequest({
  required String ssid,
  required String password,
}) {
  final cmd = ProtoWriter()
    ..writeBytes(1, utf8.encode(ssid))
    ..writeBytes(2, utf8.encode(password));
  return (ProtoWriter()
        ..writeVarint(1, _typeCmdSetConfig)
        ..writeMessage(12, cmd.toBytes()))
      .toBytes();
}

bool parseSetConfigResponse(Uint8List body) {
  final resp = decodeMessage(body)[13]?.bytesValue; // resp_set_config
  if (resp == null) {
    return false;
  }
  return decodeMessage(resp)[1]?.varintValue == _statusSuccess;
}

/// `WiFiConfigPayload{msg=TypeCmdApplyConfig}` — `CmdApplyConfig` has no
/// fields, and (matching the ESP-IDF reference exactly) the oneof isn't
/// even populated for this one: only `msg` is sent.
Uint8List buildApplyConfigRequest() {
  return (ProtoWriter()..writeVarint(1, _typeCmdApplyConfig)).toBytes();
}

bool parseApplyConfigResponse(Uint8List body) {
  final resp = decodeMessage(body)[15]?.bytesValue; // resp_apply_config
  if (resp == null) {
    return false;
  }
  return decodeMessage(resp)[1]?.varintValue == _statusSuccess;
}

/// `WiFiConfigPayload{msg=TypeCmdGetStatus, cmd_get_status:{}}` — unlike
/// apply-config, the reference implementation *does* explicitly populate
/// this (empty) oneof field.
Uint8List buildGetStatusRequest() {
  return (ProtoWriter()
        ..writeVarint(1, _typeCmdGetStatus)
        ..writeMessage(10, const <int>[]))
      .toBytes();
}

class GetStatusResult {
  const GetStatusResult({required this.state, this.failReason});

  final WifiStationState state;
  final WifiFailReason? failReason;
}

GetStatusResult parseGetStatusResponse(Uint8List body) {
  final resp = decodeMessage(body)[11]?.bytesValue; // resp_get_status
  if (resp == null) {
    return const GetStatusResult(state: WifiStationState.unknown);
  }
  final fields = decodeMessage(resp);
  final state = _stationStateFromWire(fields[2]?.varintValue);
  final failReason = state == WifiStationState.failed
      ? _failReasonFromWire(fields[10]?.varintValue)
      : null;
  return GetStatusResult(state: state, failReason: failReason);
}
