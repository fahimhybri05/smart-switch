import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

const _channel = MethodChannel('tech.hybri.smart_switch/network_binding');

bool get _supported =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

// The binding is shared: the add-device wizard may still be running a
// WiFi scan (esp8266_provisioning_client.dart's scanNetworks) when the user
// taps Connect, so each successful bind is counted and only the last
// matching unbind actually releases it — otherwise the scan finishing would
// unbind the network out from under the in-flight provision() call.
Future<bool>? _binding;
int _holders = 0;

/// Binds this process's network traffic to whatever WiFi network the phone
/// is currently on — required on Android, which otherwise silently routes
/// app traffic over mobile data instead of a WiFi network it can't validate
/// as having internet access (exactly what an ESP32's SoftAP looks like).
/// Without this, HTTP calls during provisioning appear to just time out
/// even though the phone shows as "connected" to the device's AP. Returns
/// whether binding succeeded; iOS/web are no-ops that return `true` (no
/// equivalent issue there for this MVP's manual-join flow). Every `true`
/// must be paired with one [unbindNetwork] call.
Future<bool> bindToCurrentWifi() async {
  if (!_supported) {
    return true;
  }
  final ok = await (_binding ??= _nativeBind());
  if (!ok) {
    _binding = null;
    return false;
  }
  _holders++;
  return true;
}

Future<bool> _nativeBind() async {
  try {
    return (await _channel.invokeMethod<bool>('bindToWifi')) ?? false;
  } catch (_) {
    return false;
  }
}

/// Restores normal network routing — must be called once provisioning
/// finishes (success or failure), or the whole app keeps routing through
/// the SoftAP binding indefinitely. Only the last outstanding holder's call
/// actually unbinds (see [bindToCurrentWifi]).
Future<void> unbindNetwork() async {
  if (!_supported) {
    return;
  }
  if (_holders > 1) {
    _holders--;
    return;
  }
  _holders = 0;
  _binding = null;
  try {
    await _channel.invokeMethod('unbindNetwork');
  } catch (_) {}
}
