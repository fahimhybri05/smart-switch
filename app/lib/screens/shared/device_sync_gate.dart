import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import 'empty_devices_view.dart';
import 'error_view.dart';
import 'skeleton_loader.dart';

/// Shared "no devices" gate for every device-consuming screen (Home,
/// Switches, Zones, Groups, Schedules, Automations) — replaces each
/// screen's old bare `if (devices.isEmpty) return EmptyDevicesView();`,
/// which couldn't tell "cloud sync still in flight," "cloud sync failed,"
/// and "account genuinely has zero devices" apart (see
/// providers/service_providers.dart's [deviceSyncStatusProvider] and
/// docs/plan.md's device-sync fix).
///
/// Returns `null` when [devices] is non-empty — the caller should render
/// its real content regardless of sync status, which is what preserves a
/// local/LAN-discovered device even when cloud sync is failing (no
/// regression to `FallbackDeviceTransport`'s local-first behavior).
/// Otherwise returns the placeholder widget the caller should render
/// instead of its normal body:
/// - sync in flight → a skeleton placeholder
/// - sync failed → [ErrorView] with a retry that re-runs the real sync
///   (not [refreshAllDevices], which only re-polls already-known devices)
/// - sync settled with no error → the genuine [EmptyDevicesView]
Widget? buildDeviceEmptyOrLoadingState(
  WidgetRef ref,
  List<KnownDevice> devices,
) {
  if (devices.isNotEmpty) {
    return null;
  }

  final syncStatus = ref.watch(deviceSyncStatusProvider);

  if (syncStatus.isLoading) {
    return const SkeletonListPlaceholder();
  }

  if (syncStatus.hasError) {
    return ErrorView(
      message:
          'Could not load your devices. Check your connection and try again.',
      onRetry: () => ref.read(deviceSyncStatusProvider.notifier).retry(),
    );
  }

  return const EmptyDevicesView();
}
