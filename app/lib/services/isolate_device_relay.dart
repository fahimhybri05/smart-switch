import 'backend/isolate_backend_auth.dart';
import 'device_api_client.dart';
import 'device_transport.dart';

/// The local-first, cloud-fallback *policy* every screen gets for free via
/// `activeDeviceApiClientProvider` — reimplemented for a headless isolate
/// (widget tap, background monitor) that has no Riverpod `Ref`/
/// `ProviderContainer` to read that provider from. Used by both
/// widget_service.dart and background_monitor_service.dart so the
/// fallback logic isn't duplicated. See docs/plan.md's cloud-aware widget
/// relay section.
///
/// Returns null (never throws) if neither transport worked, or if no
/// backend/login is available to try the cloud fallback at all — callers
/// should treat null the same as any other "unreachable" outcome.
Future<T?> viaLocalOrCloud<T>({
  required String deviceId,
  required String? lastKnownIp,
  required String? backendUrl,
  required Future<T> Function(DeviceApiClient client) call,
}) async {
  if (lastKnownIp != null) {
    try {
      return await call(DeviceApiClient(baseUrl: 'http://$lastKnownIp'));
    } catch (_) {
      // Fall through to the cloud relay below. Same root cause as
      // device_transport.dart's FallbackDeviceTransport had (Fix 6): the
      // plain `DeviceApiClient(baseUrl: ...)` constructed above uses
      // LocalHttpTransport's own `.timeout()`, which stops *waiting* for
      // the request without cancelling it, so a local timeout here can
      // still race a cloud retry against an in-flight local call.
      // Intentionally left as-is (no `allowFallbackAfterTimeout`-style
      // opt-out here) — every caller of this function (widget tap-to-
      // toggle, background monitor) only ever does idempotent
      // channel-state-set calls, not schedule creation, so a possible
      // duplicate local+cloud execution just means "set ON" happens
      // twice, which is harmless (unlike Fix 6's schedule-creation case,
      // where a duplicate is a genuinely new, visible resource).
    }
  }
  if (backendUrl == null) {
    return null;
  }
  final token = await IsolateBackendAuth.getValidAccessToken(backendUrl);
  if (token == null) {
    return null;
  }
  try {
    return await call(
      DeviceApiClient.withTransport(
        RestRelayTransport(
          backendUrl: backendUrl,
          deviceId: deviceId,
          accessToken: token,
        ),
      ),
    );
  } catch (_) {
    return null;
  }
}
