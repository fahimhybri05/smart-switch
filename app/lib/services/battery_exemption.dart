import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

const _channel = MethodChannel('tech.hybri.smart_switch/battery');

/// Home-screen widget taps run while the app is in the background, where
/// Android's Battery Saver / app standby block this app's network unless
/// it's exempt from battery optimization. Android-only; a no-op elsewhere.
Future<bool> isBatteryExempt() async {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return true;
  try {
    return await _channel.invokeMethod<bool>('isExempt') ?? true;
  } catch (_) {
    return true;
  }
}

/// Opens Android's "allow unrestricted battery use?" prompt for this app.
Future<void> requestBatteryExemption() async {
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return;
  try {
    await _channel.invokeMethod<void>('requestExemption');
  } catch (_) {}
}
