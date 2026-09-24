import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/models/local/usage.dart';

void main() {
  group('UsageReport', () {
    test('parses GET /devices/:id/usage and sums totals client-side', () {
      final report = UsageReport.fromJson({
        'timezone': 'Asia/Karachi',
        'days': ['2026-09-22', '2026-09-23', '2026-09-24'],
        'switches': [
          {
            'channelIdx': 0,
            'name': 'Pump',
            'watts': 1000,
            'dailyOnSeconds': [3600, 0, 1800],
            'totalOnSeconds': 5400,
            'kwh': 1.5,
          },
          {
            'channelIdx': 1,
            'name': 'Lamp',
            'watts': null,
            'dailyOnSeconds': [60, 60, 60],
            'totalOnSeconds': 180,
            'kwh': null,
          },
        ],
      });
      expect(report.timezone, 'Asia/Karachi');
      expect(report.days, hasLength(3));
      expect(report.switches.first.dailyOnSeconds, [3600, 0, 1800]);
      expect(report.switches.first.kwh, 1.5);
      expect(report.switches.last.watts, isNull);
      expect(report.switches.last.kwh, isNull);
      expect(report.switches.first.deviceId, isNull);
      expect(report.totalOnSeconds, 5580);
      expect(report.totalKwh, 1.5);
    });

    test('parses GET /usage with deviceId/deviceName and totals', () {
      final report = UsageReport.fromJson({
        'timezone': 'UTC',
        'days': ['2026-09-24'],
        'switches': [
          {
            'deviceId': 'dev-a',
            'deviceName': 'Kitchen',
            'channelIdx': 2,
            'name': 'Kettle',
            'watts': 2000,
            'dailyOnSeconds': [900],
            'totalOnSeconds': 900,
            'kwh': 0.5,
          },
        ],
        'totals': {'onSeconds': 900, 'kwh': 0.5},
      });
      expect(report.switches.single.deviceId, 'dev-a');
      expect(report.switches.single.deviceName, 'Kitchen');
      expect(report.reportedTotalOnSeconds, 900);
      expect(report.totalOnSeconds, 900);
      expect(report.totalKwh, 0.5);
    });

    test('totalKwh is null when no switch has watts', () {
      final report = UsageReport.fromJson({
        'timezone': 'UTC',
        'days': <dynamic>[],
        'switches': [
          {
            'channelIdx': 0,
            'name': 'A',
            'dailyOnSeconds': <dynamic>[],
            'totalOnSeconds': 0,
            'kwh': null,
          },
        ],
        'totals': {'onSeconds': 0, 'kwh': null},
      });
      expect(report.totalKwh, isNull);
    });
  });

  test('formatOnDuration', () {
    expect(formatOnDuration(0), '0 m');
    expect(formatOnDuration(20), '<1 m');
    expect(formatOnDuration(45 * 60), '45 m');
    expect(formatOnDuration(3 * 3600 + 5 * 60), '3 h 5 m');
    expect(formatOnDuration(2 * 3600), '2 h');
    expect(formatOnDuration(30 * 3600 + 60), '30 h');
  });

  test('formatKwh', () {
    expect(formatKwh(0.4213), '0.42 kWh');
    expect(formatKwh(12.34), '12.3 kWh');
  });
}
