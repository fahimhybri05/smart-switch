import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/services/device_api_client.dart';

void main() {
  group('WifiScanResult.fromJson', () {
    test('parses a finished scan', () {
      final result = WifiScanResult.fromJson({
        'scanning': false,
        'networks': [
          {'ssid': 'Home', 'rssi': -52, 'secure': true, 'channel': 6},
          {'ssid': 'Cafe', 'rssi': -80, 'secure': false, 'channel': 11},
        ],
      });
      expect(result.scanning, isFalse);
      expect(result.networks, hasLength(2));
      expect(result.networks[0].ssid, 'Home');
      expect(result.networks[0].rssi, -52);
      expect(result.networks[0].secure, isTrue);
      expect(result.networks[0].channel, 6);
      expect(result.networks[1].secure, isFalse);
    });

    test('tolerates missing fields and drops empty SSIDs', () {
      final result = WifiScanResult.fromJson({
        'scanning': true,
        'networks': [
          {'ssid': '', 'rssi': -40},
          {'ssid': 'NoExtras'},
          'garbage',
        ],
      });
      expect(result.scanning, isTrue);
      expect(result.networks, hasLength(1));
      expect(result.networks.single.ssid, 'NoExtras');
      expect(result.networks.single.secure, isTrue);
      expect(result.networks.single.channel, isNull);
    });

    test('empty body means no networks, not scanning', () {
      final result = WifiScanResult.fromJson({});
      expect(result.scanning, isFalse);
      expect(result.networks, isEmpty);
    });
  });

  group('pollWifiScan', () {
    const home = {'ssid': 'Home', 'rssi': -52, 'secure': true, 'channel': 6};

    test('polls until scanning is false, refreshing only first', () async {
      final refreshes = <bool>[];
      var calls = 0;
      final networks = await pollWifiScan(
        (refresh) async {
          refreshes.add(refresh);
          calls++;
          return WifiScanResult.fromJson({
            'scanning': calls < 3,
            'networks': calls < 3 ? [] : [home],
          });
        },
        refresh: true,
        interval: Duration.zero,
      );
      expect(refreshes, [true, false, false]);
      expect(networks.single.ssid, 'Home');
    });

    test('keeps polling past a transient error', () async {
      var calls = 0;
      final networks = await pollWifiScan((_) async {
        calls++;
        if (calls == 2) throw Exception('dropped during channel hop');
        return WifiScanResult.fromJson({
          'scanning': calls < 3,
          'networks': [home],
        });
      }, interval: Duration.zero);
      expect(calls, 3);
      expect(networks, hasLength(1));
    });

    test('gives up after maxPolls with the last result', () async {
      var calls = 0;
      final networks = await pollWifiScan(
        (_) async {
          calls++;
          return WifiScanResult.fromJson({
            'scanning': true,
            'networks': [home],
          });
        },
        interval: Duration.zero,
        maxPolls: 3,
      );
      expect(calls, 4);
      expect(networks.single.ssid, 'Home');
    });

    test('propagates unsupported firmware', () async {
      expect(
        pollWifiScan((_) async => throw const WifiScanUnsupportedException()),
        throwsA(isA<WifiScanUnsupportedException>()),
      );
    });
  });
}
