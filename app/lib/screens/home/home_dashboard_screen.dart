import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/device/device_config.dart';
import '../../models/local/household.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../routing/app_routes.dart';
import '../../theme/app_theme.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../shared/device_sync_gate.dart';
import '../shared/device_tile.dart';
import '../shared/skeleton_loader.dart';

/// The app's real landing screen — an at-a-glance dashboard (Google Home /
/// Nest-style): greeting header, on/off summary, a grid of every switch as
/// a big tap-to-toggle tile, and quick shortcuts into the Zones tab.
class HomeDashboardScreen extends ConsumerWidget {
  const HomeDashboardScreen({super.key, required this.onNavigateToTab});

  /// Bottom-nav tab index to jump to (1 = Zones) when a zone shortcut is tapped.
  final void Function(int tabIndex) onNavigateToTab;

  String get _greeting {
    final hour = DateTime.now().hour;
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(knownDevicesProvider);

    final deviceGate = buildDeviceEmptyOrLoadingState(ref, devices);
    if (deviceGate != null) {
      return Scaffold(
        appBar: AppBar(
          title: Text(_greeting),
          actions: [
            IconButton(
              icon: const Icon(Icons.wifi_find_rounded),
              tooltip: 'Scan for devices',
              onPressed: () =>
                  Navigator.pushNamed(context, AppRoutes.scanDevices),
            ),
            IconButton(
              icon: const Icon(Icons.settings_outlined),
              tooltip: 'Settings',
              onPressed: () => Navigator.pushNamed(context, AppRoutes.settings),
            ),
          ],
        ),
        body: Column(
          children: [
            const _InviteBanner(),
            Expanded(child: deviceGate),
          ],
        ),
        floatingActionButton:
            FloatingActionButton.extended(
              heroTag:
                  null, // avoid Hero-tag collision with other tabs' FABs — see home_shell.dart's IndexedStack
              onPressed: () =>
                  Navigator.pushNamed(context, AppRoutes.addDevice),
              icon: const Icon(Icons.add),
              label: const Text('Add device'),
            ).animate().scaleXY(
              begin: 0,
              end: 1,
              duration: Motion.medium,
              curve: Curves.easeOutBack,
            ),
      );
    }

    final deviceConfigs = <(KnownDevice, DeviceConfig)>[];
    var anyConfigLoading = false;
    for (final device in devices) {
      ref
          .watch(deviceConfigProvider(device))
          .when(
            data: (config) => deviceConfigs.add((device, config)),
            loading: () => anyConfigLoading = true,
            error: (_, _) {},
          );
    }

    var totalSwitches = 0;
    final tiles = <Widget>[];
    for (final (device, config) in deviceConfigs) {
      totalSwitches += config.switches.length;
      for (final sw in config.switches) {
        final tileIndex = tiles.length;
        tiles.add(
          DeviceTile(device: device, switchConfig: sw)
              .animate(delay: Motion.fast * tileIndex)
              .fadeIn(duration: Motion.medium, curve: Motion.standard)
              .scaleXY(
                begin: 0.9,
                end: 1,
                duration: Motion.medium,
                curve: Motion.standard,
              ),
        );
      }
    }
    final onlineDevices = deviceConfigs.length;
    final offlineDevices = devices.length - onlineDevices;

    final zones = ref.read(zoneAggregationServiceProvider).buildZones([
      for (final (_, c) in deviceConfigs) c,
    ]);
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () => refreshAllDevices(ref, devices),
        child: CustomScrollView(
          slivers: [
            SliverAppBar.large(
              title: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'My home',
                    style: Theme.of(context).textTheme.labelLarge?.copyWith(
                      color: colorScheme.primary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(_greeting),
                ],
              ),
              expandedHeight: 120,
              pinned: true,
              actions: [
                IconButton(
                  icon: const Icon(Icons.wifi_find_rounded),
                  tooltip: 'Scan for devices',
                  onPressed: () =>
                      Navigator.pushNamed(context, AppRoutes.scanDevices),
                ),
                IconButton(
                  icon: const Icon(Icons.settings_outlined),
                  tooltip: 'Settings',
                  onPressed: () =>
                      Navigator.pushNamed(context, AppRoutes.settings),
                ),
              ],
            ),
            const SliverToBoxAdapter(child: _InviteBanner()),
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(
                Spacing.md,
                Spacing.md,
                Spacing.md,
                0,
              ),
              sliver: SliverToBoxAdapter(
                child: _LiveOnCount(
                  deviceConfigs: deviceConfigs,
                  builder: (context, onKeys) => _OverviewHero(
                    dateLabel: _dateLabel,
                    onlineDevices: onlineDevices,
                    offlineDevices: offlineDevices,
                    onCount: onKeys.length,
                    totalSwitches: totalSwitches,
                  ),
                ),
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.symmetric(horizontal: Spacing.md),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (zones.isNotEmpty) ...[
                      const SizedBox(height: Spacing.lg),
                      const _SectionLabel('Rooms'),
                      const SizedBox(height: Spacing.sm),
                      _LiveOnCount(
                        deviceConfigs: deviceConfigs,
                        builder: (context, onKeys) => SizedBox(
                          height: 96,
                          child: ListView.separated(
                            scrollDirection: Axis.horizontal,
                            itemCount: zones.length,
                            separatorBuilder: (_, _) =>
                                const SizedBox(width: Spacing.sm),
                            itemBuilder: (context, i) => _RoomCard(
                              name: zones[i].name,
                              total: zones[i].switches.length,
                              onCount: zones[i].switches
                                  .where(
                                    (z) => onKeys.contains(
                                      _onKey(z.deviceId, z.switchConfig.channelIdx),
                                    ),
                                  )
                                  .length,
                              onTap: () => onNavigateToTab(1),
                            ),
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: Spacing.lg),
                    const _SectionLabel('Devices'),
                    const SizedBox(height: Spacing.sm),
                  ],
                ),
              ),
            ),
            SliverPadding(
              padding: const EdgeInsets.symmetric(horizontal: Spacing.md),
              sliver: tiles.isEmpty
                  ? SliverToBoxAdapter(
                      child: anyConfigLoading
                          ? const SkeletonGridPlaceholder()
                          : Padding(
                              padding: const EdgeInsets.symmetric(
                                vertical: Spacing.lg,
                              ),
                              child: Row(
                                children: [
                                  Icon(
                                    Icons.toggle_off_outlined,
                                    color: colorScheme.onSurfaceVariant,
                                  ),
                                  const SizedBox(width: Spacing.sm),
                                  Text(
                                    'No switches labeled yet.',
                                    style: Theme.of(context).textTheme.bodyMedium
                                        ?.copyWith(
                                          color: colorScheme.onSurfaceVariant,
                                        ),
                                  ),
                                ],
                              ),
                            ),
                    )
                  : SliverGrid(
                      gridDelegate:
                          const SliverGridDelegateWithMaxCrossAxisExtent(
                            maxCrossAxisExtent: 200,
                            mainAxisSpacing: Spacing.sm,
                            crossAxisSpacing: Spacing.sm,
                            childAspectRatio: 0.88,
                          ),
                      delegate: SliverChildBuilderDelegate(
                        (context, i) => tiles[i],
                        childCount: tiles.length,
                      ),
                    ),
            ),
            const SliverPadding(padding: EdgeInsets.only(bottom: 96)),
          ],
        ),
      ),
      floatingActionButton:
          FloatingActionButton.extended(
            heroTag:
                null, // avoid Hero-tag collision with other tabs' FABs — see home_shell.dart's IndexedStack
            onPressed: () => Navigator.pushNamed(context, AppRoutes.addDevice),
            icon: const Icon(Icons.add),
            label: const Text('Add device'),
          ).animate().scaleXY(
            begin: 0,
            end: 1,
            duration: Motion.medium,
            curve: Curves.easeOutBack,
          ),
    );
  }

  String get _dateLabel {
    final now = DateTime.now();
    const months = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];
    return '${months[now.month - 1]} ${now.day}, ${now.year}';
  }
}

/// A dismissible-per-session banner surfacing pending household invites
/// (product decision: in-app only, no email — see docs/plan.md's
/// households section). Not a blocking dialog, so it doesn't stack on top
/// of the login flow right after signup/login.
class _InviteBanner extends ConsumerStatefulWidget {
  const _InviteBanner();

  @override
  ConsumerState<_InviteBanner> createState() => _InviteBannerState();
}

class _InviteBannerState extends ConsumerState<_InviteBanner> {
  final Set<int> _dismissed = {};
  final Set<int> _busy = {};

  Future<void> _respond(HouseholdInvite invite, bool accept) async {
    setState(() => _busy.add(invite.id));
    try {
      if (accept) {
        await ref.read(householdInvitesProvider.notifier).accept(invite.id);
      } else {
        await ref.read(householdInvitesProvider.notifier).decline(invite.id);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy.remove(invite.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final invites = ref
        .watch(householdInvitesProvider)
        .where((i) => !_dismissed.contains(i.id))
        .toList();
    if (invites.isEmpty) return const SizedBox.shrink();

    final colorScheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(Spacing.md, Spacing.md, Spacing.md, 0),
      child: Column(
        children: [
          for (final invite in invites)
            Card(
              color: colorScheme.secondaryContainer,
              margin: const EdgeInsets.only(bottom: Spacing.sm),
              child: Padding(
                padding: const EdgeInsets.all(Spacing.md),
                child: Row(
                  children: [
                    Icon(
                      Icons.family_restroom_outlined,
                      color: colorScheme.onSecondaryContainer,
                    ),
                    const SizedBox(width: Spacing.sm),
                    Expanded(
                      child: Text(
                        '${invite.invitedByEmail} invited you to "${invite.householdName}"',
                        style: TextStyle(color: colorScheme.onSecondaryContainer),
                      ),
                    ),
                    if (_busy.contains(invite.id))
                      const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    else ...[
                      TextButton(
                        onPressed: () => setState(() => _dismissed.add(invite.id)),
                        child: const Text('Later'),
                      ),
                      TextButton(
                        onPressed: () => _respond(invite, false),
                        child: const Text('Decline'),
                      ),
                      FilledButton(
                        onPressed: () => _respond(invite, true),
                        child: const Text('Accept'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// A plain Material section header — a short sentence-case label.
class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: Theme.of(
        context,
      ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
    );
  }
}

/// Isolates the per-poll-tick rebuild caused by [channelStatesProvider] to
/// just this small subtree, instead of the whole dashboard screen.
///
/// [channelStatesProvider] polls every device roughly every 2s (see
/// service_providers.dart's `_channelPollIntervalLocalNoPush`/`WithPush`).
/// `DeviceTile` already scopes its own watch of that provider per-tile, but
/// the on/off summary count needs to fold it across every device — watching
/// it directly in the screen's top-level `build()` would rebuild the entire
/// screen (header, zone chips, grid) on every tick for any device. Wrapping
/// just the summary-consuming widgets in this `ConsumerWidget` confines that
/// rebuild to here; everything built by [builder] is the only part that
/// re-renders on each tick.
class _LiveOnCount extends ConsumerWidget {
  const _LiveOnCount({required this.deviceConfigs, required this.builder});

  final List<(KnownDevice, DeviceConfig)> deviceConfigs;

  /// Gets the "deviceId:channelIdx" keys of every switch currently ON.
  final Widget Function(BuildContext context, Set<String> onKeys) builder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final onKeys = <String>{};
    for (final (device, _) in deviceConfigs) {
      final channelsAsync = ref.watch(channelStatesProvider(device));
      channelsAsync.whenData((states) {
        for (final s in states) {
          if (s.state == ChannelPowerState.on) {
            onKeys.add(_onKey(device.deviceId, s.channelIdx));
          }
        }
      });
    }
    return builder(context, onKeys);
  }
}

String _onKey(String deviceId, int channelIdx) => '$deviceId:$channelIdx';

class _OverviewHero extends StatelessWidget {
  const _OverviewHero({
    required this.dateLabel,
    required this.onlineDevices,
    required this.offlineDevices,
    required this.onCount,
    required this.totalSwitches,
  });

  final String dateLabel;
  final int onlineDevices;
  final int offlineDevices;
  final int onCount;
  final int totalSwitches;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final panelColors = context.panelColors;
    final onInk = colorScheme.onPrimary;
    final needsAttention = offlineDevices > 0;
    final activeLabel = totalSwitches == 0
        ? 'No switches yet'
        : '$onCount of $totalSwitches switches active';

    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(28),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [panelColors.accent, panelColors.accentStrong],
        ),
        boxShadow: [
          BoxShadow(
            color: colorScheme.primary.withValues(alpha: 0.28),
            blurRadius: 24,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.all(Spacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        dateLabel,
                        style: Theme.of(context).textTheme.labelMedium?.copyWith(
                          color: onInk.withValues(alpha: 0.72),
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        needsAttention
                            ? 'A little attention needed'
                            : 'Everything is in rhythm',
                        style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          color: colorScheme.onPrimary,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: Spacing.xs),
                      Text(
                        activeLabel,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: colorScheme.onPrimary.withValues(alpha: 0.78),
                        ),
                      ),
                    ],
                  ),
                ),
                DecoratedBox(
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: colorScheme.onPrimary.withValues(alpha: 0.18),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(Spacing.sm),
                    child: Icon(
                      needsAttention
                          ? Icons.notifications_active_rounded
                          : Icons.bolt_rounded,
                      color: colorScheme.onPrimary,
                      size: 22,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: Spacing.lg),
            Row(
              children: [
                Expanded(
                  child: _HeroMetric(
                    value: '$onlineDevices',
                    label: 'online',
                    color: colorScheme.onPrimary,
                  ),
                ),
                Expanded(
                  child: _HeroMetric(
                    value: '$offlineDevices',
                    label: 'offline',
                    color: needsAttention
                        ? colorScheme.secondary
                        : colorScheme.onPrimary,
                  ),
                ),
                Expanded(
                  child: _HeroMetric(
                    value: '$onCount',
                    label: 'active now',
                    color: colorScheme.onPrimary,
                  ),
                ),
              ],
            ),
            if (totalSwitches > 0) ...[
              const SizedBox(height: Spacing.md),
              Row(
                children: [
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(4),
                      child: TweenAnimationBuilder<double>(
                        duration: Motion.slow,
                        tween: Tween(begin: 0, end: onCount / totalSwitches),
                        builder: (context, value, _) => LinearProgressIndicator(
                          value: value,
                          minHeight: 6,
                          color: onInk,
                          backgroundColor: onInk.withValues(alpha: 0.22),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: Spacing.sm),
                  Text(
                    '$onCount/$totalSwitches on',
                    style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: onInk,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _HeroMetric extends StatelessWidget {
  const _HeroMetric({
    required this.value,
    required this.label,
    required this.color,
  });

  final String value;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          style: Theme.of(context).textTheme.headlineSmall?.copyWith(
            color: color,
            fontWeight: FontWeight.w800,
          ),
        ),
        Text(
          label,
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
            color: color.withValues(alpha: 0.72),
          ),
        ),
      ],
    );
  }
}

class _RoomCard extends StatelessWidget {
  const _RoomCard({
    required this.name,
    required this.total,
    required this.onCount,
    required this.onTap,
  });

  final String name;
  final int total;
  final int onCount;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final active = onCount > 0;
    return SizedBox(
      width: 140,
      child: Material(
        color: active
            ? colorScheme.primaryContainer
            : colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(20),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(Spacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Icon(
                  active ? Icons.meeting_room_rounded : Icons.meeting_room_outlined,
                  size: 22,
                  color: active
                      ? colorScheme.onPrimaryContainer
                      : colorScheme.onSurfaceVariant,
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                        color: active
                            ? colorScheme.onPrimaryContainer
                            : colorScheme.onSurface,
                      ),
                    ),
                    Text(
                      onCount == 0 ? 'All off' : '$onCount of $total on',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: active
                            ? colorScheme.onPrimaryContainer.withValues(alpha: 0.8)
                            : colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
