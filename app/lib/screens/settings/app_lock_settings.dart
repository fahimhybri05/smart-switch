import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../theme/spacing.dart';
import '../lock/app_lock.dart';

/// Settings › General card: turn App lock on/off and pick how soon it
/// re-locks. Turning it on requires one successful unlock first, so nobody
/// can lock themselves out with a phone that has no screen lock.
class AppLockSettingsCard extends ConsumerWidget {
  const AppLockSettingsCard({super.key});

  static const _timeouts = <(int, String)>[
    (0, 'Instantly'),
    (60, '1 min'),
    (300, '5 min'),
  ];

  Future<void> _toggle(BuildContext context, WidgetRef ref, bool enable) async {
    final messenger = ScaffoldMessenger.of(context);
    if (enable) {
      if (!await appLockAvailable()) {
        messenger.showSnackBar(
          const SnackBar(
            content: Text(
              'Set up a screen lock or fingerprint on this phone first.',
            ),
          ),
        );
        return;
      }
      if (!await authenticateUser('Confirm to turn on App lock')) return;
    }
    await ref.read(appLockProvider.notifier).setEnabled(enable);
    messenger.showSnackBar(
      SnackBar(content: Text(enable ? 'App lock is on' : 'App lock is off')),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lock = ref.watch(appLockProvider);
    final colorScheme = Theme.of(context).colorScheme;
    return Card(
      child: Column(
        children: [
          SwitchListTile(
            secondary: Container(
              width: 34,
              height: 34,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: colorScheme.primary.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(
                Icons.fingerprint_rounded,
                size: 18,
                color: colorScheme.primary,
              ),
            ),
            title: const Text('App lock'),
            subtitle: const Text(
              'Fingerprint, face or screen lock to open the app',
            ),
            value: lock.enabled,
            onChanged: (v) => _toggle(context, ref, v),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 200),
            alignment: Alignment.topCenter,
            child: !lock.enabled
                ? const SizedBox(width: double.infinity)
                : Padding(
                    padding: const EdgeInsets.fromLTRB(
                      Spacing.md,
                      0,
                      Spacing.md,
                      Spacing.md,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          'Lock again after leaving the app',
                          style: Theme.of(context).textTheme.labelLarge,
                        ),
                        const SizedBox(height: Spacing.xs),
                        SegmentedButton<int>(
                          segments: [
                            for (final (seconds, label) in _timeouts)
                              ButtonSegment(value: seconds, label: Text(label)),
                          ],
                          selected: {lock.timeoutSeconds},
                          showSelectedIcon: false,
                          onSelectionChanged: (s) => ref
                              .read(appLockProvider.notifier)
                              .setTimeout(s.first),
                        ),
                        const SizedBox(height: Spacing.sm),
                        Text(
                          'Home-screen widgets and the Quick Settings tile keep working while the app is locked.',
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: colorScheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
          ),
        ],
      ),
    );
  }
}
