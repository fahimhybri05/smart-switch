import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../models/local/usage.dart';
import '../../theme/spacing.dart';

const _monthsShort = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// "Sep 18" from a `YYYY-MM-DD` usage day key (falls back to the raw key).
String formatUsageDay(String day) {
  final parsed = DateTime.tryParse(day);
  if (parsed == null) return day;
  return '${_monthsShort[parsed.month - 1]} ${parsed.day}';
}

/// A small single-series daily ON-time bar chart, drawn with a
/// [CustomPainter] (no chart package). Tap a bar to read its day's value in
/// the caption row; tap again (or elsewhere) to clear. Bars share one
/// scale ([maxSeconds]) when several charts sit in one list so they're
/// comparable at a glance.
class UsageBars extends StatefulWidget {
  const UsageBars({
    super.key,
    required this.days,
    required this.dailyOnSeconds,
    this.maxSeconds,
    this.height = 56,
  });

  final List<String> days;
  final List<int> dailyOnSeconds;

  /// Shared y-scale ceiling; defaults to this chart's own max.
  final int? maxSeconds;
  final double height;

  @override
  State<UsageBars> createState() => _UsageBarsState();
}

class _UsageBarsState extends State<UsageBars> {
  int? _selected;

  @override
  void didUpdateWidget(UsageBars oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.dailyOnSeconds.length != widget.dailyOnSeconds.length) {
      _selected = null;
    }
  }

  void _handleTap(Offset position, double width) {
    final count = widget.dailyOnSeconds.length;
    if (count == 0) return;
    final index = (position.dx / width * count).floor().clamp(0, count - 1);
    setState(() => _selected = _selected == index ? null : index);
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final values = widget.dailyOnSeconds;
    final maxValue = math.max(
      widget.maxSeconds ?? values.fold<int>(0, math.max),
      1,
    );
    final muted = textTheme.labelSmall?.copyWith(
      color: colorScheme.onSurfaceVariant,
    );
    final selected = _selected;
    final hasDays = widget.days.length == values.length && values.isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LayoutBuilder(
          builder: (context, constraints) => GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTapDown: (d) => _handleTap(d.localPosition, constraints.maxWidth),
            child: Semantics(
              label: _semanticsLabel(),
              child: CustomPaint(
                size: Size(constraints.maxWidth, widget.height),
                painter: _BarsPainter(
                  values: values,
                  maxValue: maxValue,
                  selected: selected,
                  barColor: colorScheme.primary,
                  baselineColor: colorScheme.outlineVariant,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: Spacing.xs),
        if (selected != null && hasDays)
          Text(
            '${formatUsageDay(widget.days[selected])}: '
            '${formatOnDuration(values[selected])} on',
            style: textTheme.labelSmall?.copyWith(
              color: colorScheme.onSurface,
              fontWeight: FontWeight.w700,
            ),
          )
        else if (hasDays)
          Row(
            children: [
              Text(formatUsageDay(widget.days.first), style: muted),
              const Spacer(),
              Text(formatUsageDay(widget.days.last), style: muted),
            ],
          ),
      ],
    );
  }

  String _semanticsLabel() {
    final values = widget.dailyOnSeconds;
    if (widget.days.length != values.length) return 'Daily on time';
    return [
      for (var i = 0; i < values.length; i++)
        '${formatUsageDay(widget.days[i])} ${formatOnDuration(values[i])}',
    ].join(', ');
  }
}

class _BarsPainter extends CustomPainter {
  _BarsPainter({
    required this.values,
    required this.maxValue,
    required this.selected,
    required this.barColor,
    required this.baselineColor,
  });

  final List<int> values;
  final int maxValue;
  final int? selected;
  final Color barColor;
  final Color baselineColor;

  @override
  void paint(Canvas canvas, Size size) {
    final baseline = Paint()
      ..color = baselineColor
      ..strokeWidth = 1;
    canvas.drawLine(
      Offset(0, size.height - 0.5),
      Offset(size.width, size.height - 0.5),
      baseline,
    );
    if (values.isEmpty) return;

    const gap = 2.0;
    final slot = size.width / values.length;
    final barWidth = math.max(slot - gap, 1.0);
    final radius = Radius.circular(math.min(4, barWidth / 2));
    final chartHeight = size.height - 1;

    for (var i = 0; i < values.length; i++) {
      final value = values[i];
      if (value <= 0) continue;
      // Any non-zero day gets at least a 2px sliver so it's visible.
      final h = math.max(chartHeight * value / maxValue, 2.0);
      final left = i * slot + gap / 2;
      final rect = RRect.fromRectAndCorners(
        Rect.fromLTWH(left, chartHeight - h, barWidth, h),
        topLeft: radius,
        topRight: radius,
      );
      final dimmed = selected != null && selected != i;
      canvas.drawRRect(
        rect,
        Paint()..color = dimmed ? barColor.withValues(alpha: 0.35) : barColor,
      );
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) =>
      old.values != values ||
      old.maxValue != maxValue ||
      old.selected != selected ||
      old.barColor != barColor ||
      old.baselineColor != baselineColor;
}

/// Big-number summary used above usage lists: total ON time plus kWh when
/// any switch has watts set.
class UsageTotals extends StatelessWidget {
  const UsageTotals({super.key, required this.report, required this.days});

  final UsageReport report;
  final int days;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final kwh = report.totalKwh;
    Widget metric(String value, String label) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          style: textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        Text(
          label,
          style: textTheme.labelMedium?.copyWith(
            color: colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
    return Row(
      children: [
        Expanded(
          child: metric(
            formatOnDuration(report.totalOnSeconds),
            'on time, last $days days',
          ),
        ),
        Expanded(
          child: kwh == null
              ? metric('—', 'kWh (set watts on a switch)')
              : metric(formatKwh(kwh), 'estimated energy'),
        ),
      ],
    );
  }
}

/// 7 / 30 day range picker shared by the device and household usage views.
class UsageRangeToggle extends StatelessWidget {
  const UsageRangeToggle({
    super.key,
    required this.days,
    required this.onChanged,
  });

  static const options = [7, 30];

  final int days;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    return SegmentedButton<int>(
      showSelectedIcon: false,
      style: const ButtonStyle(visualDensity: VisualDensity.compact),
      segments: [
        for (final d in options)
          ButtonSegment(value: d, label: Text('$d days')),
      ],
      selected: {days},
      onSelectionChanged: (s) => onChanged(s.first),
    );
  }
}

/// One switch's usage: name, total/kWh, and its daily bars.
class UsageSwitchRow extends StatelessWidget {
  const UsageSwitchRow({
    super.key,
    required this.usage,
    required this.days,
    required this.maxSeconds,
    this.showDeviceName = false,
  });

  final SwitchUsage usage;
  final List<String> days;
  final int maxSeconds;
  final bool showDeviceName;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    final kwh = usage.kwh;
    final subtitle = [
      if (showDeviceName && usage.deviceName != null) usage.deviceName!,
      if (usage.watts != null) '${usage.watts} W',
    ].join(' • ');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Spacing.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      usage.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (subtitle.isNotEmpty)
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: textTheme.bodySmall?.copyWith(
                          color: colorScheme.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text(
                    formatOnDuration(usage.totalOnSeconds),
                    style: textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if (kwh != null)
                    Text(
                      formatKwh(kwh),
                      style: textTheme.bodySmall?.copyWith(
                        color: colorScheme.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ],
          ),
          const SizedBox(height: Spacing.sm),
          UsageBars(
            days: days,
            dailyOnSeconds: usage.dailyOnSeconds,
            maxSeconds: maxSeconds,
          ),
        ],
      ),
    );
  }
}

/// The largest single-day value across [switches] — the shared bar scale.
int sharedUsageMax(List<SwitchUsage> switches) {
  var max = 0;
  for (final s in switches) {
    for (final v in s.dailyOnSeconds) {
      if (v > max) max = v;
    }
  }
  return max;
}
