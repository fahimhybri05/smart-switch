import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../providers/service_providers.dart';
import '../../services/weather_service.dart';
import '../../theme/motion.dart';

/// Weather at the first device that has a location set (the same location
/// sunrise/sunset schedules use); falls back to an IP-based city location
/// when none has one. Null only when both fail. Refreshes every 15 min; the
/// phone's GPS is never requested.
final homeWeatherProvider = FutureProvider<CurrentWeather?>((ref) async {
  final timer = Timer(const Duration(minutes: 15), ref.invalidateSelf);
  ref.onDispose(timer.cancel);
  final devices = ref.watch(knownDevicesProvider);
  for (final device in devices) {
    final config = ref.watch(deviceConfigProvider(device)).asData?.value;
    if (config != null && config.locationSet) {
      return WeatherService.fetch(config.latitude, config.longitude);
    }
  }
  final approx = await ref.watch(_approximateLocationProvider.future);
  if (approx == null) return null;
  return WeatherService.fetch(approx.latitude, approx.longitude);
});

/// Looked up once per app session — the phone rarely changes city.
final _approximateLocationProvider =
    FutureProvider<({double latitude, double longitude})?>(
      (ref) => WeatherService.approximateLocation(),
    );

/// Live clock + current weather for the home app bar.
class TimeWeatherChip extends ConsumerStatefulWidget {
  const TimeWeatherChip({super.key});

  @override
  ConsumerState<TimeWeatherChip> createState() => _TimeWeatherChipState();
}

class _TimeWeatherChipState extends ConsumerState<TimeWeatherChip> {
  Timer? _timer;
  DateTime _now = DateTime.now();

  @override
  void initState() {
    super.initState();
    _scheduleTick();
  }

  // Re-render on each minute boundary rather than polling every second.
  void _scheduleTick() {
    final now = DateTime.now();
    final next = DateTime(
      now.year,
      now.month,
      now.day,
      now.hour,
      now.minute + 1,
    );
    _timer = Timer(next.difference(now), () {
      if (!mounted) return;
      setState(() => _now = DateTime.now());
      _scheduleTick();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final weatherAsync = ref.watch(homeWeatherProvider);
    final weather = weatherAsync.asData?.value;
    // Only the first load shows dots; 15-min refreshes keep the last value.
    final weatherLoading = weatherAsync.isLoading && !weatherAsync.hasValue;
    final muted = colorScheme.onSurfaceVariant;
    final high = weather?.highC;
    final low = weather?.lowC;
    // Right-aligned stack: time, current conditions, today's forecast.
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(
          TimeOfDay.fromDateTime(_now).format(context),
          style: textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.w800,
            color: colorScheme.onSurface,
            height: 1.2,
          ),
        ),
        // Dots crossfade into the forecast once it lands.
        AnimatedSwitcher(
          duration: Motion.medium,
          switchInCurve: Motion.enter,
          layoutBuilder: (current, previous) => Stack(
            alignment: Alignment.topRight,
            children: [...previous, ?current],
          ),
          child: weatherLoading
              ? Padding(
                  key: const ValueKey('loading'),
                  padding: const EdgeInsets.only(top: 6),
                  child: _LoadingDots(color: muted),
                )
              : weather == null
              ? const SizedBox.shrink(key: ValueKey('none'))
              : Column(
                  key: const ValueKey('weather'),
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          weatherIcon(
                            weather.weatherCode,
                            isDay: weather.isDay,
                          ),
                          size: 15,
                          color: colorScheme.primary,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          '${weather.temperatureC.round()}° '
                          '${weatherLabel(weather.forecastCode ?? weather.weatherCode)}',
                          style: textTheme.labelMedium?.copyWith(
                            fontWeight: FontWeight.w700,
                            color: colorScheme.onSurface,
                          ),
                        ),
                      ],
                    ),
                    if (high != null && low != null)
                      Text(
                        'H ${high.round()}°  ·  L ${low.round()}°',
                        style: textTheme.labelSmall?.copyWith(color: muted),
                      ),
                  ],
                ),
        ),
      ],
    );
  }
}

/// Three dots pulsing in turn — a tiny "…" while the weather loads.
class _LoadingDots extends StatefulWidget {
  const _LoadingDots({required this.color});

  final Color color;

  @override
  State<_LoadingDots> createState() => _LoadingDotsState();
}

class _LoadingDotsState extends State<_LoadingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Loading weather',
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < 3; i++) ...[
              if (i > 0) const SizedBox(width: 4),
              _dot(i),
            ],
          ],
        ),
      ),
    );
  }

  Widget _dot(int i) {
    // Each dot peaks a third of a cycle after the previous one.
    final phase = (_controller.value - i / 3) % 1.0;
    final t = math.sin(phase * math.pi).clamp(0.0, 1.0);
    return Transform.translate(
      offset: Offset(0, -2.5 * t),
      child: Container(
        width: 5,
        height: 5,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: widget.color.withValues(alpha: 0.35 + 0.65 * t),
        ),
      ),
    );
  }
}

/// WMO weather code → short label for the header forecast line.
String weatherLabel(int code) {
  if (code == 0) return 'Clear';
  if (code <= 2) return 'Partly cloudy';
  if (code == 3) return 'Cloudy';
  if (code == 45 || code == 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code >= 85 && code <= 86) return 'Snow showers';
  if (code >= 95) return 'Storm';
  return 'Cloudy';
}

/// WMO weather code → icon (https://open-meteo.com/en/docs).
IconData weatherIcon(int code, {bool isDay = true}) {
  if (code == 0) return isDay ? Icons.wb_sunny_rounded : Icons.nightlight_round;
  if (code <= 3) return isDay ? Icons.wb_cloudy_rounded : Icons.cloud_rounded;
  if (code == 45 || code == 48) return Icons.foggy;
  if (code >= 51 && code <= 67) return Icons.water_drop_rounded;
  if (code >= 71 && code <= 77) return Icons.ac_unit_rounded;
  if (code >= 80 && code <= 82) return Icons.grain_rounded;
  if (code >= 85 && code <= 86) return Icons.ac_unit_rounded;
  if (code >= 95) return Icons.thunderstorm_rounded;
  return Icons.cloud_rounded;
}
