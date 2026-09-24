import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/models/device/device_health.dart';
import 'package:smart_switch/models/local/known_device.dart';
import 'package:smart_switch/screens/device_health/device_health_screen.dart';

void main() {
  test('fromJson reads the backend shape', () {
    final h = DeviceHealth.fromJson({
      'online': true,
      'lastConnectedAt': '2026-09-24T09:00:00.000Z',
      'offlineSince': null,
      'firmware': '2.1.0',
      'resetReason': 'Hardware Watchdog',
      'rssi': -82,
      'freeHeap': 31000,
      'uptimeS': 3700,
    });
    expect(h.online, isTrue);
    expect(h.rssi, -82);
    expect(h.uptimeS, 3700);
    expect(h.hasDiagnostics, isTrue);
    expect(DeviceHealth.fromJson({'online': false}).hasDiagnostics, isFalse);
  });

  test('signal and reset reason are explained in plain language', () {
    expect(signalQuality(-50).label, 'Excellent');
    expect(signalQuality(-70).label, 'Fair');
    expect(signalQuality(-85).weak, isTrue);
    expect(resetReasonInfo('Power On').problem, isFalse);
    expect(resetReasonInfo('Hardware Watchdog').problem, isTrue);
    expect(resetReasonInfo('Exception').label, 'Crashed and recovered');
    expect(formatDuration(const Duration(hours: 26, minutes: 5)), '1d 2h');
  });

  testWidgets('weak signal + crash restart show a tip and warnings', (
    tester,
  ) async {
    const device = KnownDevice(
      deviceId: 'esp-1',
      mdnsHostname: null,
      lastKnownIp: null,
      friendlyName: 'Pump room',
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          deviceHealthProvider('esp-1').overrideWith(
            (ref) async => const DeviceHealth(
              online: true,
              rssi: -84,
              resetReason: 'Exception',
              uptimeS: 7200,
              freeHeap: 30000,
              firmware: '2.1.0',
            ),
          ),
        ],
        child: const MaterialApp(home: DeviceHealthScreen(device: device)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Weak · -84 dBm'), findsOneWidget);
    expect(find.text('Crashed and recovered'), findsOneWidget);
    expect(find.text('2h 0m'), findsOneWidget);
    expect(find.textContaining('Wi-Fi extender'), findsWidgets);
  });
}
