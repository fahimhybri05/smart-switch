import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/household.dart';
import '../../providers/service_providers.dart';
import '../../theme/spacing.dart';
import '../shared/empty_state_view.dart';
import '../shared/error_view.dart';
import '../shared/friendly_error.dart';
import '../shared/usage_bars.dart';

/// Household-wide usage (`GET /usage`): totals plus every switch's daily ON
/// time, busiest first. Reached from Settings › Household, next to
/// Activity history. Online-only, like Activity.
class UsageScreen extends ConsumerStatefulWidget {
  const UsageScreen({super.key});

  @override
  ConsumerState<UsageScreen> createState() => _UsageScreenState();
}

class _UsageScreenState extends ConsumerState<UsageScreen> {
  int _days = 7;
  int? _householdId;

  @override
  Widget build(BuildContext context) {
    if (ref.watch(authProvider) == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Usage')),
        body: const EmptyStateView(
          icon: Icons.insights_outlined,
          title: 'Log in to see usage',
        ),
      );
    }
    final households = ref.watch(householdsProvider);
    final household =
        households.where((h) => h.id == _householdId).firstOrNull ??
        households.firstOrNull;
    final key = (householdId: household?.id, days: _days);
    final usage = ref.watch(householdUsageProvider(key));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Usage'),
        actions: households.length > 1
            ? [
                DropdownButton<Household>(
                  value: household,
                  underline: const SizedBox.shrink(),
                  onChanged: (h) => setState(() => _householdId = h?.id),
                  items: [
                    for (final h in households)
                      DropdownMenuItem(value: h, child: Text(h.name)),
                  ],
                ),
                const SizedBox(width: Spacing.md),
              ]
            : null,
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(householdUsageProvider(key).future),
        child: ListView(
          padding: const EdgeInsets.all(Spacing.md),
          children: [
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: UsageRangeToggle(
                days: _days,
                onChanged: (d) => setState(() => _days = d),
              ),
            ),
            const SizedBox(height: Spacing.md),
            ...usage.when(
              skipLoadingOnReload: true,
              loading: () => const [
                Padding(
                  padding: EdgeInsets.symmetric(vertical: Spacing.xl),
                  child: Center(child: CircularProgressIndicator()),
                ),
              ],
              error: (e, _) => [
                ErrorView(
                  message: friendlyErrorMessage(e, 'Loading usage'),
                  onRetry: () => ref.invalidate(householdUsageProvider(key)),
                ),
              ],
              data: (report) {
                final switches = [
                  ...report.switches,
                ]..sort((a, b) => b.totalOnSeconds.compareTo(a.totalOnSeconds));
                final maxSeconds = sharedUsageMax(switches);
                return [
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(Spacing.md),
                      child: UsageTotals(report: report, days: _days),
                    ),
                  ),
                  const SizedBox(height: Spacing.sm),
                  if (switches.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(Spacing.lg),
                      child: Center(child: Text('No usage recorded yet.')),
                    )
                  else
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: Spacing.md,
                          vertical: Spacing.sm,
                        ),
                        child: Column(
                          children: [
                            for (var i = 0; i < switches.length; i++) ...[
                              UsageSwitchRow(
                                usage: switches[i],
                                days: report.days,
                                maxSeconds: maxSeconds,
                                showDeviceName: true,
                              ),
                              if (i != switches.length - 1)
                                const Divider(height: 1),
                            ],
                          ],
                        ),
                      ),
                    ),
                  Padding(
                    padding: const EdgeInsets.only(top: Spacing.sm),
                    child: Text(
                      'Days follow the household time zone '
                      '(${report.timezone}). kWh is estimated from each '
                      'switch\'s watts setting.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ];
              },
            ),
          ],
        ),
      ),
    );
  }
}
