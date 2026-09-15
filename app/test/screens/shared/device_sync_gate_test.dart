import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:smart_switch/models/local/known_device.dart';
import 'package:smart_switch/providers/service_providers.dart';
import 'package:smart_switch/screens/shared/device_sync_gate.dart';
import 'package:smart_switch/screens/shared/empty_devices_view.dart';
import 'package:smart_switch/screens/shared/error_view.dart';
import 'package:smart_switch/screens/shared/skeleton_loader.dart';

const _knownDevice = KnownDevice(
  deviceId: 'dev-1',
  mdnsHostname: null,
  lastKnownIp: '192.168.1.50',
  friendlyName: 'Living room switch',
);

/// Lets a test pin [deviceSyncStatusProvider] to an arbitrary starting
/// state without going through a real sync — `NotifierProvider.overrideWith`
/// needs a `Notifier` subclass, not a bare value.
class _FixedDeviceSyncNotifier extends DeviceSyncNotifier {
  _FixedDeviceSyncNotifier(this._initial);
  final AsyncValue<void> _initial;

  @override
  AsyncValue<void> build() => _initial;
}

class _Harness extends ConsumerWidget {
  const _Harness({required this.devices});
  final List<KnownDevice> devices;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final gate = buildDeviceEmptyOrLoadingState(ref, devices);
    return gate ?? const Text('REAL CONTENT');
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required AsyncValue<void> syncStatus,
  required List<KnownDevice> devices,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        deviceSyncStatusProvider.overrideWith(
          () => _FixedDeviceSyncNotifier(syncStatus),
        ),
      ],
      child: MaterialApp(home: _Harness(devices: devices)),
    ),
  );
}

void main() {
  group('buildDeviceEmptyOrLoadingState', () {
    testWidgets('empty + loading shows a skeleton placeholder', (
      tester,
    ) async {
      await _pump(
        tester,
        syncStatus: const AsyncValue.loading(),
        devices: const [],
      );
      // Not pumpAndSettle: SkeletonListPlaceholder's shimmer runs a
      // continuously-repeating animation by design, which never settles.
      await tester.pump();

      expect(find.byType(SkeletonListPlaceholder), findsOneWidget);
      expect(find.byType(ErrorView), findsNothing);
      expect(find.byType(EmptyDevicesView), findsNothing);
      expect(find.text('REAL CONTENT'), findsNothing);
    });

    testWidgets('empty + error shows ErrorView with a retry affordance', (
      tester,
    ) async {
      await _pump(
        tester,
        syncStatus: AsyncValue.error(Exception('network down'), StackTrace.empty),
        devices: const [],
      );
      await tester.pumpAndSettle();

      expect(find.byType(ErrorView), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      expect(find.byType(SkeletonListPlaceholder), findsNothing);
      expect(find.byType(EmptyDevicesView), findsNothing);
    });

    testWidgets('empty + settled (no error) shows the genuine empty state', (
      tester,
    ) async {
      await _pump(
        tester,
        syncStatus: const AsyncValue.data(null),
        devices: const [],
      );
      await tester.pumpAndSettle();

      expect(find.byType(EmptyDevicesView), findsOneWidget);
      expect(find.byType(ErrorView), findsNothing);
      expect(find.byType(SkeletonListPlaceholder), findsNothing);
    });

    testWidgets(
      'non-empty devices always renders real content, even if sync errored '
      '(local/LAN-discovered devices must not regress when cloud sync fails)',
      (tester) async {
        await _pump(
          tester,
          syncStatus: AsyncValue.error(Exception('network down'), StackTrace.empty),
          devices: const [_knownDevice],
        );
        await tester.pumpAndSettle();

        expect(find.text('REAL CONTENT'), findsOneWidget);
        expect(find.byType(ErrorView), findsNothing);
        expect(find.byType(SkeletonListPlaceholder), findsNothing);
        expect(find.byType(EmptyDevicesView), findsNothing);
      },
    );
  });
}
