import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

const _channel = MethodChannel('tech.hybri.smart_switch/network_binding');

bool get _supported =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

/// Binds this process's network traffic to whatever WiFi network the phone
/// is currently on — required on Android, which otherwise silently routes
/// app traffic over mobile data instead of a WiFi network it can't validate
/// as having internet access (exactly what an ESP32's SoftAP looks like).
/// Without this, HTTP calls during provisioning appear to just time out
/// even though the phone shows as "connected" to the device's AP. Returns
/// whether binding succeeded; iOS/web are no-ops that return `true` (no
/// equivalent issue there for this MVP's manual-join flow).
Future<bool> bindToCurrentWifi() async {
  if (!_supported) {
    return true;
  }
  try {
    return (await _channel.invokeMethod<bool>('bindToWifi')) ?? false;
  } catch (_) {
    return false;
  }
}

/// Restores normal network routing — must be called once provisioning
/// finishes (success or failure), or the whole app keeps routing through
/// the SoftAP binding indefinitely.
Future<void> unbindNetwork() async {
  if (!_supported) {
    return;
  }
  try {
    await _channel.invokeMethod('unbindNetwork');
  } catch (_) {}
}
