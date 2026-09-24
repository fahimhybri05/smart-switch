import 'dart:convert';

import 'package:http/http.dart' as http;

/// Current conditions plus today's forecast from Open-Meteo (free, no API key).
typedef CurrentWeather = ({
  double temperatureC,
  int weatherCode,
  bool isDay,
  double? highC,
  double? lowC,
  int? forecastCode,
});

class WeatherService {
  static Future<CurrentWeather> fetch(double latitude, double longitude) async {
    final uri = Uri.https('api.open-meteo.com', '/v1/forecast', {
      'latitude': latitude.toStringAsFixed(3),
      'longitude': longitude.toStringAsFixed(3),
      'current': 'temperature_2m,weather_code,is_day',
      'daily': 'temperature_2m_max,temperature_2m_min,weather_code',
      'forecast_days': '1',
      'timezone': 'auto',
    });
    final resp = await http.get(uri).timeout(const Duration(seconds: 8));
    if (resp.statusCode != 200) {
      throw Exception('weather ${resp.statusCode}');
    }
    final body = jsonDecode(resp.body) as Map<String, dynamic>;
    final current = body['current'] as Map<String, dynamic>;
    final daily = body['daily'] as Map<String, dynamic>?;
    num? firstOf(String key) {
      final list = daily?[key];
      return list is List && list.isNotEmpty ? list.first as num? : null;
    }

    return (
      temperatureC: (current['temperature_2m'] as num).toDouble(),
      weatherCode: (current['weather_code'] as num).toInt(),
      isDay: (current['is_day'] as num?) != 0,
      highC: firstOf('temperature_2m_max')?.toDouble(),
      lowC: firstOf('temperature_2m_min')?.toDouble(),
      forecastCode: firstOf('weather_code')?.toInt(),
    );
  }

  /// City-level location from the phone's public IP — used only when no
  /// device has a location set. No permission prompt; null on failure.
  static Future<({double latitude, double longitude})?>
  approximateLocation() async {
    const sources = [('get.geojs.io', '/v1/ip/geo.json'), ('ipwho.is', '/')];
    for (final (host, path) in sources) {
      try {
        final resp = await http
            .get(Uri.https(host, path))
            .timeout(const Duration(seconds: 6));
        if (resp.statusCode != 200) continue;
        final body = jsonDecode(resp.body) as Map<String, dynamic>;
        // geojs returns strings, ipwho.is numbers.
        final lat = double.tryParse('${body['latitude']}');
        final lon = double.tryParse('${body['longitude']}');
        if (lat != null && lon != null) return (latitude: lat, longitude: lon);
      } catch (_) {
        // Try the next source.
      }
    }
    return null;
  }
}
