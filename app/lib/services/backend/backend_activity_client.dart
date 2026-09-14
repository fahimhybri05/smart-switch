import '../../models/local/activity_entry.dart';
import 'package:http/http.dart' as http;

import 'backend_api_exception.dart';

const _requestTimeout = Duration(seconds: 8);

class ActivityPage {
  const ActivityPage({required this.entries, required this.nextCursor});

  final List<ActivityEntry> entries;
  final int? nextCursor;
}

/// `GET /activity` (see backend/src/routes/activity.js) — cursor-paginated,
/// keep-everything (no retention job, per docs/plan.md). Callers must
/// supply an already-fresh access token — see
/// `ensureFreshAccessToken`/`ensureFreshAccessTokenForNotifier` in
/// providers/service_providers.dart.
class BackendActivityClient {
  BackendActivityClient({required this.baseUrl, required this.accessToken});

  final String baseUrl;
  final String accessToken;

  Future<ActivityPage> list({
    required int householdId,
    int? cursor,
    int limit = 50,
  }) async {
    final uri = Uri.parse('$baseUrl/activity').replace(
      queryParameters: {
        'householdId': '$householdId',
        'limit': '$limit',
        if (cursor != null) 'before': '$cursor',
      },
    );
    final resp = await http
        .get(uri, headers: {'Authorization': 'Bearer $accessToken'})
        .timeout(_requestTimeout);
    final json = await decodeBackendResponseOrThrow(resp);
    return ActivityPage(
      entries: (json['entries'] as List<dynamic>)
          .map((e) => ActivityEntry.fromJson(e as Map<String, dynamic>))
          .toList(),
      nextCursor: (json['nextCursor'] as num?)?.toInt(),
    );
  }
}
