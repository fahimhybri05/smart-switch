/// One switch's ON-time breakdown from `GET /devices/:id/usage` or
/// `GET /usage` (see the user-features contract). All usage wire parsing
/// lives in this file.
class SwitchUsage {
  const SwitchUsage({
    required this.channelIdx,
    required this.name,
    required this.dailyOnSeconds,
    required this.totalOnSeconds,
    this.deviceId,
    this.deviceName,
    this.watts,
    this.kwh,
  });

  /// Only present in the household-wide report.
  final String? deviceId;
  final String? deviceName;
  final int channelIdx;
  final String name;
  final int? watts;

  /// One entry per [UsageReport.days] entry, same order.
  final List<int> dailyOnSeconds;
  final int totalOnSeconds;

  /// Null when [watts] isn't set.
  final double? kwh;

  factory SwitchUsage.fromJson(Map<String, dynamic> json) {
    final daily = ((json['dailyOnSeconds'] as List<dynamic>?) ?? const [])
        .map((e) => (e as num).round())
        .toList();
    return SwitchUsage(
      deviceId: json['deviceId'] as String?,
      deviceName: json['deviceName'] as String?,
      channelIdx: (json['channelIdx'] as num).toInt(),
      name: json['name'] as String? ?? 'Switch ${json['channelIdx']}',
      watts: (json['watts'] as num?)?.toInt(),
      dailyOnSeconds: daily,
      totalOnSeconds:
          (json['totalOnSeconds'] as num?)?.round() ??
          daily.fold<int>(0, (a, b) => a + b),
      kwh: (json['kwh'] as num?)?.toDouble(),
    );
  }
}

class UsageReport {
  const UsageReport({
    required this.timezone,
    required this.days,
    required this.switches,
    this.reportedTotalOnSeconds,
    this.reportedTotalKwh,
  });

  /// IANA zone the day boundaries were computed in.
  final String timezone;

  /// `YYYY-MM-DD`, oldest first.
  final List<String> days;
  final List<SwitchUsage> switches;

  /// `totals` from the household report; absent for a single device.
  final int? reportedTotalOnSeconds;
  final double? reportedTotalKwh;

  int get totalOnSeconds =>
      reportedTotalOnSeconds ??
      switches.fold<int>(0, (sum, s) => sum + s.totalOnSeconds);

  /// Null when no switch in the report has watts set.
  double? get totalKwh {
    if (reportedTotalKwh != null) return reportedTotalKwh;
    final withKwh = switches.where((s) => s.kwh != null);
    if (withKwh.isEmpty) return null;
    return withKwh.fold<double>(0, (sum, s) => sum + s.kwh!);
  }

  factory UsageReport.fromJson(Map<String, dynamic> json) {
    final totals = json['totals'] as Map<String, dynamic>?;
    return UsageReport(
      timezone: json['timezone'] as String? ?? 'UTC',
      days: ((json['days'] as List<dynamic>?) ?? const [])
          .map((e) => e as String)
          .toList(),
      switches: ((json['switches'] as List<dynamic>?) ?? const [])
          .map((e) => SwitchUsage.fromJson(e as Map<String, dynamic>))
          .toList(),
      reportedTotalOnSeconds: (totals?['onSeconds'] as num?)?.round(),
      reportedTotalKwh: (totals?['kwh'] as num?)?.toDouble(),
    );
  }
}

/// "0 m", "45 m", "3 h 5 m", "26 h" — compact ON-time label.
String formatOnDuration(int seconds) {
  if (seconds <= 0) return '0 m';
  final totalMinutes = (seconds / 60).round();
  if (totalMinutes < 1) return '<1 m';
  final hours = totalMinutes ~/ 60;
  final minutes = totalMinutes % 60;
  if (hours == 0) return '$minutes m';
  if (minutes == 0 || hours >= 24) return '$hours h';
  return '$hours h $minutes m';
}

/// "0.42 kWh" / "12.3 kWh".
String formatKwh(double kwh) =>
    '${kwh < 10 ? kwh.toStringAsFixed(2) : kwh.toStringAsFixed(1)} kWh';
