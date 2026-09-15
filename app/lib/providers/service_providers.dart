import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/device/channel_state.dart';
import '../models/device/device_config.dart';
import '../models/local/automation.dart';
import '../models/local/household.dart';
import '../models/local/known_device.dart';
import '../models/local/switch_group.dart';
import '../models/local/smart_scene.dart';
import '../services/app_settings_service.dart';
import '../services/backend/auth_session_service.dart';
import '../services/backend/backend_auth_client.dart';
import '../services/backend/backend_devices_client.dart';
import '../services/backend/backend_groups_client.dart';
import '../services/backend/backend_automations_client.dart';
import '../services/backend/backend_households_client.dart';
import '../services/backend/backend_ws_client.dart';
import '../services/backend/jwt.dart';
import '../services/backup_service.dart';
import '../services/device_api_client.dart';
import '../services/device_registry_service.dart';
import '../services/device_transport.dart';
import '../services/discovery_service.dart';
import '../services/group_service.dart';
import '../services/scene_service.dart';
import '../services/zone_aggregation_service.dart';

final deviceRegistryServiceProvider = Provider<DeviceRegistryService>(
  (ref) => DeviceRegistryService(),
);

final groupServiceProvider = Provider<GroupService>((ref) => GroupService());

final sceneServiceProvider = Provider<SceneService>((ref) => SceneService());

class ScenesNotifier extends Notifier<List<SmartScene>> {
  SceneService get _service => ref.read(sceneServiceProvider);

  @override
  List<SmartScene> build() {
    _reload();
    return const [];
  }

  Future<void> _reload() async {
    state = await _service.getAll();
  }

  Future<void> upsert(SmartScene scene) async {
    await _service.upsert(scene);
    await _reload();
  }

  Future<void> remove(String id) async {
    await _service.remove(id);
    await _reload();
  }
}

final scenesProvider = NotifierProvider<ScenesNotifier, List<SmartScene>>(
  ScenesNotifier.new,
);

final backupServiceProvider = Provider<BackupService>((ref) => BackupService());

final appSettingsServiceProvider = Provider<AppSettingsService>(
  (ref) => AppSettingsService(),
);

/// Persisted app-wide theme preference (spec: visual overhaul pass) — same
/// Notifier shape as [KnownDevicesNotifier].
class ThemeModeNotifier extends Notifier<ThemeMode> {
  AppSettingsService get _settings => ref.read(appSettingsServiceProvider);

  @override
  ThemeMode build() => _settings.getThemeMode();

  Future<void> setThemeMode(ThemeMode mode) async {
    await _settings.setThemeMode(mode);
    state = mode;
  }
}

final themeModeProvider = NotifierProvider<ThemeModeNotifier, ThemeMode>(
  ThemeModeNotifier.new,
);

/// The user's self-hosted backend URL — same Notifier shape as
/// [ThemeModeNotifier] so Settings changing it properly invalidates every
/// dependent provider below (auth client, WS client, ...).
class BackendUrlNotifier extends Notifier<String?> {
  AppSettingsService get _settings => ref.read(appSettingsServiceProvider);

  @override
  String? build() => _settings.getBackendUrl();

  Future<void> setBackendUrl(String url) async {
    await _settings.setBackendUrl(url);
    state = url.trim().isEmpty ? null : url.trim();
  }
}

final backendUrlProvider = NotifierProvider<BackendUrlNotifier, String?>(
  BackendUrlNotifier.new,
);

final authSessionServiceProvider = Provider<AuthSessionService>(
  (ref) => AuthSessionService(),
);

/// Null when logged out. A plain record rather than a class — this state
/// is just data, no behavior belongs on it (see [AuthNotifier] for that).
typedef AuthState = ({String email, String accessToken, String refreshToken})?;

/// Backend login/session state — same Notifier shape as
/// [KnownDevicesNotifier]. `app.dart` gates the whole app behind this being
/// non-null (login is mandatory to reach `HomeShell`) — devices/rooms/
/// groups are account-wide now (see docs/plan.md's account-wide sync
/// section), so there's no "local-only, logged-out" mode left to preserve.
class AuthNotifier extends Notifier<AuthState> {
  AuthSessionService get _session => ref.read(authSessionServiceProvider);

  @override
  AuthState build() {
    final saved = _session.getSession();
    if (saved == null) {
      return null;
    }
    return (
      email: saved.email,
      accessToken: saved.accessToken,
      refreshToken: saved.refreshToken,
    );
  }

  BackendAuthClient _client() {
    final url = ref.read(backendUrlProvider);
    if (url == null) {
      throw StateError('backend server URL not configured');
    }
    return BackendAuthClient(baseUrl: url);
  }

  Future<void> login(String email, String password) async {
    final tokens = await _client().login(email, password);
    await _persist(email, tokens);
  }

  Future<void> signup(String email, String password) async {
    final tokens = await _client().signup(email, password);
    await _persist(email, tokens);
  }

  Future<void> _persist(String email, TokenPair tokens) async {
    await _session.saveSession(
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      email: email,
    );
    state = (
      email: email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    );
    // Chained (not run in parallel) so the timezone push also covers any
    // device this login just discovered via cloud sync (e.g. claimed from
    // another phone) — not just devices already known on this one. Still
    // fully unawaited overall: never blocks the login screen from
    // returning. See pushTimezoneToKnownDevices's doc comment / Task D.
    unawaited(
      syncClaimedDevicesFromBackend(
        ref,
      ).then((_) => pushTimezoneToKnownDevices(ref)),
    );
    unawaited(ref.read(householdsProvider.notifier).refresh());
    unawaited(ref.read(householdInvitesProvider.notifier).refresh());
  }

  /// Best-effort backend call, but local session state is always cleared
  /// regardless of whether it succeeds.
  Future<void> logout() async {
    final current = state;
    if (current != null) {
      try {
        await _client().logout(current.refreshToken);
      } catch (_) {}
    }
    await _session.clear();
    state = null;
  }

  /// Used by [ensureFreshAccessToken] — logs the user out if the refresh
  /// token itself turns out to be invalid/expired (matches the backend's
  /// rotate-on-use refresh design; there's no recovering from that client-side).
  Future<String> refreshAccessToken() async {
    final current = state;
    if (current == null) {
      throw StateError('not logged in');
    }
    try {
      final tokens = await _client().refresh(current.refreshToken);
      await _session.updateTokens(
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      );
      state = (
        email: current.email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      );
      return tokens.accessToken;
    } catch (_) {
      await logout();
      rethrow;
    }
  }
}

final authProvider = NotifierProvider<AuthNotifier, AuthState>(
  AuthNotifier.new,
);

/// Returns a not-yet-expired access token, silently refreshing first if
/// needed. Throws if the user isn't logged in.
///
/// `WidgetRef` and `Ref` are unrelated types in Riverpod 3 (not a subtype
/// relationship like in Riverpod 2) — screens/widgets call this one, and
/// [ensureFreshAccessTokenForNotifier] below is the near-identical `Ref`
/// version for Notifiers (`GroupsNotifier`, `syncClaimedDevicesFromBackend`)
/// to call instead. The logic is small enough that duplicating it beats
/// fighting Riverpod 3's (deliberately `@internal`) shared base interfaces.
Future<String> ensureFreshAccessToken(WidgetRef ref) async {
  final current = ref.read(authProvider);
  if (current == null) {
    throw StateError('not logged in');
  }
  if (isJwtExpiredOrExpiringSoon(current.accessToken)) {
    return ref.read(authProvider.notifier).refreshAccessToken();
  }
  return current.accessToken;
}

/// See [ensureFreshAccessToken] — same logic, for callers that only have a
/// `Ref` (Notifiers), not a `WidgetRef`.
Future<String> ensureFreshAccessTokenForNotifier(Ref ref) async {
  final current = ref.read(authProvider);
  if (current == null) {
    throw StateError('not logged in');
  }
  if (isJwtExpiredOrExpiringSoon(current.accessToken)) {
    return ref.read(authProvider.notifier).refreshAccessToken();
  }
  return current.accessToken;
}

/// One shared WS connection to the backend, rebuilt whenever the backend
/// URL or login state changes (a token refresh means a fresh connection —
/// simpler than juggling a live token swap mid-socket, and refreshes are
/// infrequent enough — see docs/plan.md).
final backendWsClientProvider = Provider<BackendWsClient?>((ref) {
  final url = ref.watch(backendUrlProvider);
  final auth = ref.watch(authProvider);
  if (url == null || auth == null) {
    return null;
  }
  final wsUrl =
      '${url.replaceFirst('http://', 'ws://').replaceFirst('https://', 'wss://')}/ws';
  final client = BackendWsClient(wsUrl: wsUrl, accessToken: auth.accessToken);
  ref.onDispose(client.close);
  return client;
});

final discoveryServiceProvider = Provider<DiscoveryService>(
  (ref) => createDiscoveryService(),
);

final zoneAggregationServiceProvider = Provider<ZoneAggregationService>(
  (ref) => ZoneAggregationService(),
);

/// One DeviceApiClient per device base URL (`http://<lastKnownIp>`).
final deviceApiClientProvider = Provider.family<DeviceApiClient, String>(
  (ref, baseUrl) => DeviceApiClient(baseUrl: baseUrl),
);

/// Null when the device has never been reached on this LAN yet (e.g.
/// synced in from the backend via another phone's claim — see
/// docs/plan.md's account-wide sync section). Nullable on purpose: forces
/// every call site to either handle "no local address" explicitly or use
/// [activeDeviceApiClientProvider] instead, which already does.
String? baseUrlFor(KnownDevice device) =>
    device.lastKnownIp == null ? null : 'http://${device.lastKnownIp}';

/// Local-first, cloud-fallback (see docs/plan.md's `FallbackDeviceTransport`)
/// — the version screens should use for every device, claimed or not, known
/// locally or only via the backend. Skips the local attempt entirely (goes
/// straight to cloud-only, if available) when [KnownDevice.lastKnownIp] is
/// null — no point spending a timeout on a URL that can't exist. Falls back
/// to a pure local client automatically whenever no backend/login is
/// configured, so it's always safe to use even for a fully offline-first
/// setup.
final activeDeviceApiClientProvider =
    Provider.family<DeviceApiClient, KnownDevice>((ref, device) {
      final localUrl = baseUrlFor(device);
      final wsClient = ref.watch(backendWsClientProvider);

      DeviceTransport? cloud;
      if (wsClient != null) {
        cloud = CloudRelayTransport(
          deviceId: device.deviceId,
          sendCommand: wsClient.sendCommand,
        );
      }

      if (localUrl == null) {
        if (cloud == null) {
          // Neither reachable — surface an honest "not reachable" error
          // from whichever call fails, rather than silently no-op'ing.
          return DeviceApiClient.withTransport(
            FallbackDeviceTransport(
              local: LocalHttpTransport(baseUrl: 'http://0.0.0.0'),
              cloud: null,
            ),
          );
        }
        return DeviceApiClient.withTransport(cloud);
      }

      return DeviceApiClient.withTransport(
        FallbackDeviceTransport(
          local: LocalHttpTransport(baseUrl: localUrl),
          cloud: cloud,
        ),
      );
    });

/// Backs the local known-devices table (spec §4). Riverpod 3's non-codegen
/// `Notifier` API — the older `StateNotifier`/`StateNotifierProvider` used
/// in earlier Riverpod majors is no longer exported by `flutter_riverpod`.
class KnownDevicesNotifier extends Notifier<List<KnownDevice>> {
  DeviceRegistryService get _registry =>
      ref.read(deviceRegistryServiceProvider);

  @override
  List<KnownDevice> build() {
    _reload();
    return const [];
  }

  Future<void> _reload() async {
    state = await _registry.getAll();
  }

  Future<void> upsert(KnownDevice device) async {
    await _registry.upsert(device);
    await _reload();
  }

  Future<void> remove(String deviceId) async {
    await _registry.remove(deviceId);
    await _reload();
  }

  Future<void> updateLastKnownIp(String deviceId, String ip) async {
    await _registry.updateLastKnownIp(deviceId, ip);
    await _reload();
  }
}

final knownDevicesProvider =
    NotifierProvider<KnownDevicesNotifier, List<KnownDevice>>(
      KnownDevicesNotifier.new,
    );

/// Tracks the outcome of the most recent [syncClaimedDevicesFromBackend]
/// call — `loading` while a real backend sync is in flight, `error` if it
/// failed, `data(null)` once one has completed successfully (this also
/// covers "never synced yet" for a logged-out user / no backend configured
/// — that's not an error, just nothing to report). [knownDevicesProvider]
/// on its own is a plain `List<KnownDevice>` with no loading/error
/// distinction, which is what let "still loading," "fetch failed," and
/// "genuinely zero devices" collapse into the same false-empty UI (see
/// screens/shared/device_sync_gate.dart, which is what actually reads this).
class DeviceSyncNotifier extends Notifier<AsyncValue<void>> {
  @override
  AsyncValue<void> build() => const AsyncValue.data(null);

  /// Sets state to `loading`, runs [task], and captures its outcome (data
  /// or error) into state via [AsyncValue.guard] — never rethrows past
  /// itself, the resulting state is the only place the outcome is
  /// observable from.
  Future<void> run(Future<void> Function() task) async {
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(task);
  }

  /// Re-runs the real backend sync — used by the gate's retry affordance.
  /// Deliberately NOT [refreshAllDevices], which only re-polls devices
  /// already known locally and can't recover from "never synced in the
  /// first place." Uses this Notifier's own `ref` (rather than taking one
  /// as a parameter) since callers here are widgets holding a `WidgetRef`
  /// — an unrelated type from the `Ref` this file's internals use (see
  /// [ensureFreshAccessToken]'s doc comment above for the same
  /// Riverpod-3-specific gotcha).
  Future<void> retry() => run(() => _doSyncClaimedDevicesFromBackend(ref));
}

final deviceSyncStatusProvider =
    NotifierProvider<DeviceSyncNotifier, AsyncValue<void>>(
      DeviceSyncNotifier.new,
    );

/// One-shot kickoff for `main.dart`'s bootstrap, which only has the root
/// `ProviderContainer` (no widget tree yet, so no real `Ref`) — reading
/// this provider once hands `syncClaimedDevicesFromBackend` a genuine
/// `Ref` via this provider's own build callback.
final startupDeviceSyncProvider = Provider<void>((ref) {
  if (ref.read(authProvider) != null) {
    unawaited(syncClaimedDevicesFromBackend(ref));
    unawaited(ref.read(householdsProvider.notifier).refresh());
    unawaited(ref.read(householdInvitesProvider.notifier).refresh());
  }
});

/// Fetches every device claimed to the logged-in account and merges them
/// into [knownDevicesProvider] — this is what makes a device claimed on
/// one phone actually show up on another. A device new to this phone is
/// added with no local IP yet (routed through the cloud relay via
/// [activeDeviceApiClientProvider] until this phone discovers it on the
/// LAN); an already-known device only gets its `friendlyName` refreshed
/// (propagates a rename made elsewhere), never its local IP/hostname.
/// Best-effort in the sense that it never blocks login/app startup (always
/// called `unawaited`) — but unlike before, a failure now propagates into
/// [deviceSyncStatusProvider]'s `error` state instead of being swallowed,
/// so the UI (screens/shared/device_sync_gate.dart) can actually react to
/// it. See docs/plan.md's account-wide sync section.
Future<void> syncClaimedDevicesFromBackend(Ref ref) {
  return ref
      .read(deviceSyncStatusProvider.notifier)
      .run(() => _doSyncClaimedDevicesFromBackend(ref));
}

/// The actual sync logic — unchanged from before other than the shorter
/// timeout and no-longer-swallowed errors (see [syncClaimedDevicesFromBackend]
/// and [DeviceSyncNotifier] above, which is what now catches/reports the
/// outcome). A device new to this phone is added with no local IP yet
/// (routed through the cloud relay via [activeDeviceApiClientProvider]
/// until this phone discovers it on the LAN); an already-known device only
/// gets its `friendlyName` refreshed (propagates a rename made elsewhere),
/// never its local IP/hostname.
Future<void> _doSyncClaimedDevicesFromBackend(Ref ref) async {
  final backendUrl = ref.read(backendUrlProvider);
  if (ref.read(authProvider) == null || backendUrl == null) {
    return;
  }
  try {
    await _fetchAndMergeClaimedDevices(ref, backendUrl)
        // This opportunistic path is called unawaited from login/boot —
        // shrink the worst case (token refresh + device list, ~8s each,
        // sequential — up to ~16s) so a slow/unreachable backend fails
        // fast into deviceSyncStatusProvider's error state instead of
        // leaving the UI in a long false-empty-looking limbo. Other,
        // explicit user-initiated calls elsewhere keep their own 8s
        // timeouts unchanged.
        .timeout(const Duration(seconds: 6));
  } catch (e, st) {
    // Still never swallowed silently forever — `flutter logs`/`adb
    // logcat` (or Xcode's console) shows this line, but the exception
    // also propagates (rethrow) so DeviceSyncNotifier.run's
    // AsyncValue.guard captures it into deviceSyncStatusProvider.
    debugPrint('syncClaimedDevicesFromBackend failed: $e\n$st');
    rethrow;
  }
}

Future<void> _fetchAndMergeClaimedDevices(Ref ref, String backendUrl) async {
  final accessToken = await ensureFreshAccessTokenForNotifier(ref);
  final cloudDevices = await BackendDevicesClient(
    baseUrl: backendUrl,
    accessToken: accessToken,
  ).list();

  final notifier = ref.read(knownDevicesProvider.notifier);
  final known = ref.read(knownDevicesProvider);
  for (final cloudDevice in cloudDevices) {
    final existing = known.where((d) => d.deviceId == cloudDevice.deviceId);
    if (existing.isEmpty) {
      await notifier.upsert(
        KnownDevice(
          deviceId: cloudDevice.deviceId,
          mdnsHostname: null,
          lastKnownIp: null,
          friendlyName: cloudDevice.friendlyName,
        ),
      );
    } else if (existing.first.friendlyName != cloudDevice.friendlyName) {
      await notifier.upsert(
        existing.first.copyWith(friendlyName: cloudDevice.friendlyName),
      );
    }
  }
}

/// DST fix (Task D, docs/plan.md): re-pushes this phone's current UTC
/// offset to every device it can currently reach, since a device only
/// learns its offset from whichever phone last told it (at pairing time,
/// or here) — it never recomputes DST on its own. Called on every
/// successful login (see [AuthNotifier._persist], via this `Ref` version)
/// and on app foreground (see `app.dart`'s `WidgetsBindingObserver`, via
/// [pushTimezoneToKnownDevicesFromWidget] — `WidgetRef` and `Ref` are
/// unrelated types in Riverpod 3, see [ensureFreshAccessToken]'s doc
/// comment above for the same split). Best-effort and fire-and-forget,
/// same discipline as [syncClaimedDevicesFromBackend]: never blocks UI, a
/// single unreachable device's failure never blocks the rest. Skips a
/// device with no reachable transport at all (never seen on this LAN
/// *and* no backend/cloud relay configured) — nothing to push to.
///
/// Known residual limitation (documented, not fixed here): still wrong if
/// the app stays unopened across the exact DST transition moment, and
/// ambiguous in a multi-user household if members are in different zones —
/// acceptable tradeoff, not silently hidden.
Future<void> pushTimezoneToKnownDevices(Ref ref) => _pushTimezoneToDevices(
  knownDevices: ref.read(knownDevicesProvider),
  hasCloud: ref.read(backendWsClientProvider) != null,
  clientFor: (device) => ref.read(activeDeviceApiClientProvider(device)),
);

/// See [pushTimezoneToKnownDevices] — same logic, for callers (widgets)
/// that only have a `WidgetRef`.
Future<void> pushTimezoneToKnownDevicesFromWidget(WidgetRef ref) =>
    _pushTimezoneToDevices(
      knownDevices: ref.read(knownDevicesProvider),
      hasCloud: ref.read(backendWsClientProvider) != null,
      clientFor: (device) => ref.read(activeDeviceApiClientProvider(device)),
    );

Future<void> _pushTimezoneToDevices({
  required List<KnownDevice> knownDevices,
  required bool hasCloud,
  required DeviceApiClient Function(KnownDevice) clientFor,
}) async {
  if (knownDevices.isEmpty) {
    return;
  }
  final offsetMinutes = DateTime.now().timeZoneOffset.inMinutes;
  for (final device in knownDevices) {
    if (baseUrlFor(device) == null && !hasCloud) {
      continue; // no LAN address known, no cloud relay either — unreachable
    }
    try {
      await clientFor(device).setTimezone(offsetMinutes);
    } catch (_) {
      // Best-effort — one unreachable/failing device must never block the
      // rest, mirrors syncClaimedDevicesFromBackend's discipline.
    }
  }
}

/// Backs account-wide Groups (spec §7) — the backend is the source of
/// truth once logged in (every phone on the account sees the same
/// groups); the local Hive cache (via [GroupService]) is only a
/// read-through fallback for offline viewing. Writes (`save`/`remove`)
/// require backend reachability — surfaced as a thrown error rather than
/// a silent local-only edit that would need conflict resolution later.
/// See docs/plan.md's account-wide sync section.
class GroupsNotifier extends Notifier<List<SwitchGroup>> {
  GroupService get _groups => ref.read(groupServiceProvider);

  Future<BackendGroupsClient> _requireClient() async {
    if (ref.read(authProvider) == null ||
        ref.read(backendUrlProvider) == null) {
      throw StateError('Log in to manage groups.');
    }
    final accessToken = await ensureFreshAccessTokenForNotifier(ref);
    return BackendGroupsClient(
      baseUrl: ref.read(backendUrlProvider)!,
      accessToken: accessToken,
    );
  }

  @override
  List<SwitchGroup> build() {
    _reload();
    return const [];
  }

  Future<void> _reload() async {
    if (ref.read(authProvider) != null &&
        ref.read(backendUrlProvider) != null) {
      try {
        final client = await _requireClient();
        final remote = await client.list();
        state = remote;
        await _groups.replaceAll(remote);
        return;
      } catch (_) {
        // Fall through to the offline cache below — e.g. no network.
      }
    }
    state = await _groups.getAll();
  }

  Future<void> refresh() => _reload();

  /// [id] omitted creates a new group; given, replaces the named group's
  /// name + full member list.
  Future<void> save({
    String? id,
    required String name,
    required List<GroupMember> members,
  }) async {
    final client = await _requireClient();
    await client.upsert(id: id, name: name, members: members);
    await _reload();
  }

  Future<void> remove(String id) async {
    final client = await _requireClient();
    await client.delete(id);
    await _reload();
  }
}

final groupsProvider = NotifierProvider<GroupsNotifier, List<SwitchGroup>>(
  GroupsNotifier.new,
);

/// Backs households + pending invites (see docs/plan.md's households
/// section). Unlike [GroupsNotifier], **no Hive offline cache** — household
/// membership isn't needed for offline device control the way groups'
/// offline LAN-control fallback needed one, so the extra read-through-cache
/// complexity isn't earning its keep here. Backend-only: an offline user
/// simply sees an empty list until reconnected.
Future<BackendHouseholdsClient?> _householdsClient(Ref ref) async {
  if (ref.read(authProvider) == null || ref.read(backendUrlProvider) == null) {
    return null;
  }
  final accessToken = await ensureFreshAccessTokenForNotifier(ref);
  return BackendHouseholdsClient(
    baseUrl: ref.read(backendUrlProvider)!,
    accessToken: accessToken,
  );
}

class HouseholdsNotifier extends Notifier<List<Household>> {
  Future<BackendHouseholdsClient?> _client() => _householdsClient(ref);

  @override
  List<Household> build() {
    refresh();
    return const [];
  }

  Future<void> refresh() async {
    try {
      final client = await _client();
      if (client == null) {
        state = const [];
        return;
      }
      state = await client.list();
    } catch (_) {
      // Best-effort — never blocks login/startup, matches
      // syncClaimedDevicesFromBackend's discipline.
    }
  }

  Future<void> rename(int householdId, String name) async {
    final client = await _client();
    if (client == null) throw StateError('Log in to manage your household.');
    await client.rename(householdId, name);
    await refresh();
  }

  Future<void> setTimezone(int householdId, String timezone) async {
    final client = await _client();
    if (client == null) throw StateError('Log in to manage your household.');
    await client.setTimezone(householdId, timezone);
    await refresh();
  }

  Future<void> invite(int householdId, String email) async {
    final client = await _client();
    if (client == null) throw StateError('Log in to manage your household.');
    await client.invite(householdId, email);
  }

  Future<void> removeMember(int householdId, int userId) async {
    final client = await _client();
    if (client == null) throw StateError('Log in to manage your household.');
    await client.removeMember(householdId, userId);
    await refresh();
  }
}

final householdsProvider =
    NotifierProvider<HouseholdsNotifier, List<Household>>(
      HouseholdsNotifier.new,
    );

/// The logged-in user's own pending received invites — a separate provider
/// from [householdsProvider] (rather than a plain field on that Notifier)
/// so the dashboard's invite banner rebuilds reactively when this changes.
class HouseholdInvitesNotifier extends Notifier<List<HouseholdInvite>> {
  Future<BackendHouseholdsClient?> _client() => _householdsClient(ref);

  @override
  List<HouseholdInvite> build() {
    refresh();
    return const [];
  }

  Future<void> refresh() async {
    try {
      final client = await _client();
      if (client == null) {
        state = const [];
        return;
      }
      state = await client.listInvites();
    } catch (_) {
      // Best-effort, same discipline as syncClaimedDevicesFromBackend.
    }
  }

  Future<void> accept(int inviteId) async {
    final client = await _client();
    if (client == null) throw StateError('Log in to manage your household.');
    await client.acceptInvite(inviteId);
    await refresh();
    await ref.read(householdsProvider.notifier).refresh();
    // A newly-joined household may include devices/groups this phone has
    // never seen — pull them in immediately, same as a fresh login does.
    unawaited(syncClaimedDevicesFromBackend(ref));
  }

  Future<void> decline(int inviteId) async {
    final client = await _client();
    if (client == null) throw StateError('Log in to manage your household.');
    await client.declineInvite(inviteId);
    await refresh();
  }
}

/// Backs household-wide automations (spec: "advanced automations require
/// event and condition APIs") — server-evaluated, so there's nothing to
/// cache for offline use the way groups' offline LAN-control fallback
/// needed one. Same shape as [GroupsNotifier] otherwise: writes
/// (`save`/`remove`) require backend reachability, no silent local edits.
class AutomationsNotifier extends Notifier<List<Automation>> {
  Future<BackendAutomationsClient> _requireClient() async {
    if (ref.read(authProvider) == null || ref.read(backendUrlProvider) == null) {
      throw StateError('Log in to manage automations.');
    }
    final accessToken = await ensureFreshAccessTokenForNotifier(ref);
    return BackendAutomationsClient(
      baseUrl: ref.read(backendUrlProvider)!,
      accessToken: accessToken,
    );
  }

  @override
  List<Automation> build() {
    refresh();
    return const [];
  }

  Future<void> refresh() async {
    if (ref.read(authProvider) == null || ref.read(backendUrlProvider) == null) {
      state = const [];
      return;
    }
    try {
      state = await (await _requireClient()).list();
    } catch (_) {
      // Best-effort on refresh — an explicit save()/remove() call still
      // throws, surfacing a real error to whoever triggered it.
    }
  }

  Future<void> save({
    int? id,
    int? householdId,
    required String name,
    required bool enabled,
    required AutomationTrigger trigger,
    required List<AutomationAction> actions,
  }) async {
    final client = await _requireClient();
    await client.upsert(
      id: id,
      householdId: householdId,
      name: name,
      enabled: enabled,
      trigger: trigger,
      actions: actions,
    );
    await refresh();
  }

  Future<void> remove(int id) async {
    final client = await _requireClient();
    await client.delete(id);
    await refresh();
  }
}

final automationsProvider =
    NotifierProvider<AutomationsNotifier, List<Automation>>(
      AutomationsNotifier.new,
    );

final householdInvitesProvider =
    NotifierProvider<HouseholdInvitesNotifier, List<HouseholdInvite>>(
      HouseholdInvitesNotifier.new,
    );

/// One GET /api/config fetch per device. autoDispose so a device that's no
/// longer on screen stops being fetched/held in memory.
final deviceConfigProvider = FutureProvider.autoDispose
    .family<DeviceConfig, KnownDevice>((ref, device) async {
      final client = ref.watch(activeDeviceApiClientProvider(device));
      return client.getConfig();
    });

/// Polls GET /api/channels every 2s (spec §6's short-poll) for exactly as
/// long as some screen is watching it — autoDispose cancels the loop the
/// instant nothing does, satisfying "only poll the zone currently on screen"
/// without any manual start/stop wiring in the screens themselves.
const _channelPollIntervalLocal = Duration(seconds: 2);
const _channelPollIntervalCloudBackoff = Duration(seconds: 6);

/// Consecutive cloud-served polls (see
/// [FallbackDeviceTransport.lastServedByCloud]) before the poll interval
/// widens from 2s to ~6s — a couple of cloud polls in a row is a decent
/// signal the phone is genuinely off-LAN right now, not just one flaky LAN
/// hiccup.
const _cloudBackoffThreshold = 3;

final channelStatesProvider = StreamProvider.autoDispose
    .family<List<ChannelState>, KnownDevice>((ref, device) async* {
      final client = ref.watch(activeDeviceApiClientProvider(device));
      // Only a FallbackDeviceTransport can ever report "served by cloud" —
      // a cloud-only or local-only client (see activeDeviceApiClientProvider)
      // has no such signal, so the backoff below simply never engages for
      // those (consecutiveCloudPolls stays 0 forever), which is correct:
      // there's no "local" to snap back to for a cloud-only client anyway.
      final transport = client.transport;
      var consecutiveCloudPolls = 0;
      while (true) {
        try {
          yield await client.getChannels();
          final servedByCloud = transport is FallbackDeviceTransport
              ? transport.lastServedByCloud
              : null;
          if (servedByCloud == true) {
            consecutiveCloudPolls++;
          } else if (servedByCloud == false) {
            consecutiveCloudPolls = 0;
          }
        } catch (_) {
          yield const [];
        }
        await Future.delayed(
          consecutiveCloudPolls >= _cloudBackoffThreshold
              ? _channelPollIntervalCloudBackoff
              : _channelPollIntervalLocal,
        );
      }
    });

typedef ChannelOverrideKey = (String deviceId, int channelIdx);

/// Optimistic per-channel state overrides, set the instant a toggle is
/// tapped so tiles flip immediately instead of waiting for the next
/// [channelStatesProvider] poll tick (up to 2s away) on top of the HTTP
/// round-trip — that combined wait was the main source of "toggling feels
/// slow" (see docs/plan.md). Cleared automatically after [_overrideTtl]
/// regardless of outcome, so a failed/reverted command can't leave a tile
/// stuck showing the wrong state — by then the caller's forced
/// `ref.invalidate(channelStatesProvider(device))` (see every `_toggle`)
/// has long since delivered the real, confirmed value anyway.
const _channelOverrideTtl = Duration(seconds: 4);

class ChannelOverrideNotifier
    extends Notifier<Map<ChannelOverrideKey, ChannelPowerState>> {
  @override
  Map<ChannelOverrideKey, ChannelPowerState> build() => {};

  void set(String deviceId, int channelIdx, ChannelPowerState value) {
    final key = (deviceId, channelIdx);
    state = {...state, key: value};
    Future.delayed(_channelOverrideTtl, () {
      // Only clear if nothing re-set it in the meantime (e.g. a second tap).
      if (state[key] == value) {
        state = {...state}..remove(key);
      }
    });
  }
}

final channelOverrideProvider =
    NotifierProvider<
      ChannelOverrideNotifier,
      Map<ChannelOverrideKey, ChannelPowerState>
    >(ChannelOverrideNotifier.new);

/// Pull-to-refresh helper — forces every known device's config + channel
/// poll to refetch immediately, used by Home/Zones/Switches' RefreshIndicator.
Future<void> refreshAllDevices(WidgetRef ref, List<KnownDevice> devices) async {
  for (final device in devices) {
    ref.invalidate(deviceConfigProvider(device));
    ref.invalidate(channelStatesProvider(device));
  }
  // Give the invalidated providers a moment to kick off their refetch before
  // the RefreshIndicator's spinner disappears.
  await Future.delayed(const Duration(milliseconds: 400));
}

/// Serializes known_devices + groups (the only phone-local state) plus a
/// best-effort live snapshot of each device's switches/schedules, for
/// backup/restore across a phone swap or reinstall.
Future<String> exportBackup(WidgetRef ref) async {
  final devices = ref.read(knownDevicesProvider);
  final groups = ref.read(groupsProvider);

  final snapshots = <String, Map<String, dynamic>?>{};
  for (final device in devices) {
    try {
      final config = await ref
          .read(activeDeviceApiClientProvider(device))
          .getConfig();
      snapshots[device.deviceId] = config.toJson();
    } catch (_) {
      snapshots[device.deviceId] = null; // unreachable — diagnostic gap only
    }
  }

  return ref
      .read(backupServiceProvider)
      .buildExportJson(
        devices: devices,
        groups: groups,
        deviceSnapshots: snapshots,
      );
}

/// Restores known_devices + groups from a previously exported backup. Never
/// touches any device over HTTP — see [BackupService] doc comment.
Future<void> importBackup(WidgetRef ref, String rawJson) async {
  final parsed = ref.read(backupServiceProvider).parseImportJson(rawJson);
  for (final device in parsed.devices) {
    await ref.read(knownDevicesProvider.notifier).upsert(device);
  }
  for (final group in parsed.groups) {
    try {
      await ref
          .read(groupsProvider.notifier)
          .save(id: group.id, name: group.name, members: group.members);
    } catch (_) {
      // Best-effort — e.g. restoring onto a different account, or the
      // group's original id no longer exists upstream.
    }
  }
}
