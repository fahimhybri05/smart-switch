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
      // Fall through to the cloud relay below.
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
