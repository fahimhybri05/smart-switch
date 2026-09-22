import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/local/known_device.dart';
import '../../models/local/switch_group.dart';
import '../../providers/service_providers.dart';
import '../../theme/app_theme.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../shared/device_sync_gate.dart';
import '../shared/empty_state_view.dart';
import '../shared/device_visualization.dart';

class GroupsScreen extends ConsumerWidget {
  const GroupsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(knownDevicesProvider);
    final groups = ref.watch(groupsProvider);

    final deviceGate = buildDeviceEmptyOrLoadingState(ref, devices);
    if (deviceGate != null) {
      return Scaffold(body: deviceGate);
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Groups')),
      body: groups.isEmpty
          ? const EmptyStateView(
              icon: Icons.group_work_outlined,
              title: 'No groups yet',
              subtitle: 'Tap "New group" to create one.',
            )
          : ListView(
              padding: const EdgeInsets.symmetric(vertical: Spacing.sm),
              children: [
                for (var i = 0; i < groups.length; i++)
                  _GroupTile(
                    // Keyed by group id (not list position) so deleting one
                    // group doesn't make Flutter reuse another tile's State
                    // for the shifted position — that would attach the
                    // exit-animation flag below to the wrong group.
                    key: ValueKey(groups[i].id),
                    group: groups[i],
                    devices: devices,
                    index: i,
                  ),
              ],
            ),
      floatingActionButton:
          FloatingActionButton.extended(
            heroTag:
                null, // avoid Hero-tag collision with other tabs' FABs — see home_shell.dart's IndexedStack
            onPressed: () => showModalBottomSheet<void>(
              context: context,
              isScrollControlled: true,
              builder: (context) =>
                  _GroupEditorSheet(devices: devices, existing: null),
            ),
            icon: const Icon(Icons.add),
            label: const Text('New group'),
          ).animate().scaleXY(
            begin: 0,
            end: 1,
            duration: Motion.medium,
            curve: Curves.easeOutBack,
          ),
    );
  }
}

class _GroupTile extends ConsumerStatefulWidget {
  const _GroupTile({
    super.key,
    required this.group,
    required this.devices,
    required this.index,
  });

  final SwitchGroup group;
  final List<KnownDevice> devices;

  /// Position in the list — only used to stagger the entrance animation
  /// below, same as switches_screen.dart/zones_screen.dart.
  final int index;

  @override
  ConsumerState<_GroupTile> createState() => _GroupTileState();
}

class _GroupTileState extends ConsumerState<_GroupTile> {
  // Set once delete is confirmed; drives the fade+collapse below. The
  // actual removal from groupsProvider is deferred until that animation
  // finishes (see _confirmDelete) — removing it immediately would yank
  // this whole widget out of the tree with nothing left to animate.
  bool _removing = false;

  SwitchGroup get group => widget.group;
  List<KnownDevice> get devices => widget.devices;
  int get index => widget.index;

  KnownDevice? _deviceFor(String deviceId) {
    for (final d in devices) {
      if (d.deviceId == deviceId) return d;
    }
    return null;
  }

  Future<void> _toggleAll(BuildContext context, WidgetRef ref, bool on) async {
    HapticFeedback.mediumImpact();
    final desired = on ? ChannelPowerState.on : ChannelPowerState.off;
    final overrideNotifier = ref.read(channelOverrideProvider.notifier);
    final touchedDevices = <KnownDevice>{};
    var failureCount = 0;

    // Fire every member's command in parallel (was a sequential await-in-a-
    // for-loop — N members paid N round-trips serially, which is what made
    // group toggling feel especially slow). Each member also gets the same
    // instant optimistic flip individual tiles get — see
    // channelOverrideProvider's doc comment. One unreachable member still
    // shouldn't block the rest (spec §7, best-effort fan-out) — but unlike
    // before, failures are now collected instead of silently swallowed, so
    // the user learns something didn't apply instead of assuming success.
    await Future.wait(
      group.members.map((member) async {
        final device = _deviceFor(member.deviceId);
        if (device == null) {
          failureCount++;
          return;
        }
        touchedDevices.add(device);
        overrideNotifier.set(device.deviceId, member.channelIdx, desired);
        final client = ref.read(activeDeviceApiClientProvider(device));
        try {
          await client.setChannelState(member.channelIdx, desired);
        } catch (_) {
          failureCount++;
        }
      }),
    );

    for (final device in touchedDevices) {
      ref.invalidate(channelStatesProvider(device));
    }

    if (failureCount > 0 && context.mounted) {
      final total = group.members.length;
      final succeeded = total - failureCount;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '$succeeded of $total switches updated — $failureCount failed',
          ),
        ),
      );
    }
  }

  Future<void> _confirmDelete(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete group?'),
        content: Text('Delete "${group.name}"?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
              foregroundColor: Theme.of(context).colorScheme.onError,
            ),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    // Play the fade+collapse below before touching the provider — deleting
    // first would remove this tile from the list immediately, leaving
    // nothing on screen to animate.
    setState(() => _removing = true);
    await Future.delayed(Motion.medium);
    if (!mounted) return;
    try {
      await ref.read(groupsProvider.notifier).remove(group.id);
    } catch (e) {
      if (mounted) {
        setState(() => _removing = false);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Failed to delete group. Please try again.'),
            ),
          );
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    var allOn = group.members.isNotEmpty;
    var anyOn = false;
    var anyLoading = false;
    var anyOffline = false;
    var anyPending = false;

    for (final member in group.members) {
      final device = _deviceFor(member.deviceId);
      if (device == null) {
        allOn = false;
        anyOffline = true;
        continue;
      }
      final override = ref.watch(channelOverrideProvider)[
        (device.deviceId, member.channelIdx)
      ];
      if (override != null) {
        anyPending = true;
        if (override == ChannelPowerState.on) anyOn = true;
        allOn = override == ChannelPowerState.on && allOn;
        continue;
      }
      final channelsAsync = ref.watch(channelStatesProvider(device));
      if (channelsAsync.isLoading) anyLoading = true;
      // See switch_tile.dart/device_tile.dart's identical comment —
      // channelsAsync.hasError almost never fires (channelStatesProvider
      // swallows poll failures into a successful empty list so its retry
      // loop can keep going); deviceUnreachableProvider is the real signal.
      if (channelsAsync.hasError || ref.watch(deviceUnreachableProvider(device))) {
        anyOffline = true;
      }
      final state = channelsAsync.asData?.value.firstWhere(
        (item) => item.channelIdx == member.channelIdx,
        orElse: () => const ChannelState(
          channelIdx: -1,
          state: ChannelPowerState.off,
        ),
      );
      final isOn = state?.state == ChannelPowerState.on;
      anyOn = anyOn || isOn;
      allOn = allOn && isOn;
    }
    final visualState = anyPending
        ? DeviceVisualState.pending
        : anyOffline && !anyOn
        ? DeviceVisualState.offline
        : anyLoading
        ? DeviceVisualState.connecting
        : anyOn
        ? DeviceVisualState.on
        : DeviceVisualState.off;
    final stateLabel = anyOffline
        ? 'Some devices offline'
        : anyPending
        ? 'Updating group'
        : anyLoading
        ? 'Connecting'
        : allOn
        ? 'All on'
        : anyOn
        ? 'Partially on'
        : 'All off';

    final panelColors = context.panelColors;
    final colorScheme = Theme.of(context).colorScheme;
    final stateColor = anyOffline
        ? colorScheme.error
        : allOn
        ? panelColors.live
        : anyOn
        ? panelColors.warn
        : colorScheme.onSurfaceVariant;

    final card = Card(
      child: Padding(
        padding: const EdgeInsetsDirectional.only(start: Spacing.sm),
        child: ListTile(
          leading: SizedBox(
            width: 84,
            child: DeviceVisualization(
              kind: DeviceVisualKind.fromName(group.name) ==
                      DeviceVisualKind.appliance
                  ? DeviceVisualKind.switchDevice
                  : DeviceVisualKind.fromName(group.name),
              gangCount: group.members.length.clamp(1, 4),
              height: 72,
              state: visualState,
              onTap: group.members.isEmpty
                  ? null
                  : () => _toggleAll(context, ref, !allOn),
            ),
          ),
          title: Text(
            group.name,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
          ),
          subtitle: Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    color: stateColor,
                    shape: BoxShape.circle,
                    boxShadow: allOn
                        ? [
                            BoxShadow(
                              color: panelColors.liveGlow,
                              blurRadius: 4,
                              spreadRadius: 0.5,
                            ),
                          ]
                        : null,
                  ),
                ),
                const SizedBox(width: Spacing.xs),
                Flexible(
                  child: Text(
                    '${group.members.length} switch(es) • $stateLabel',
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: stateColor),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
          trailing: PopupMenuButton<String>(
            icon: const Icon(Icons.more_horiz_rounded),
            onSelected: (action) {
              if (action == 'on') {
                _toggleAll(context, ref, true);
              } else if (action == 'off') {
                _toggleAll(context, ref, false);
              } else if (action == 'edit') {
                showModalBottomSheet<void>(
                  context: context,
                  isScrollControlled: true,
                  builder: (context) =>
                      _GroupEditorSheet(devices: devices, existing: group),
                );
              } else if (action == 'delete') {
                _confirmDelete(context, ref);
              }
            },
            itemBuilder: (menuContext) {
              final menuScheme = Theme.of(menuContext).colorScheme;
              return [
                PopupMenuItem(
                  value: 'on',
                  child: _MenuRow(
                    icon: Icons.flash_on_rounded,
                    label: 'Turn all on',
                    color: menuScheme.primary,
                  ),
                ),
                PopupMenuItem(
                  value: 'off',
                  child: _MenuRow(
                    icon: Icons.power_settings_new_rounded,
                    label: 'Turn all off',
                    color: menuScheme.onSurfaceVariant,
                  ),
                ),
                const PopupMenuDivider(),
                PopupMenuItem(
                  value: 'edit',
                  child: _MenuRow(
                    icon: Icons.edit_outlined,
                    label: 'Edit group',
                    color: menuScheme.onSurfaceVariant,
                  ),
                ),
                PopupMenuItem(
                  value: 'delete',
                  child: _MenuRow(
                    icon: Icons.delete_outline_rounded,
                    label: 'Delete group',
                    color: menuScheme.error,
                  ),
                ),
              ];
            },
          ),
        ),
      ),
    );

    // Entrance: staggered fade+slide-up per tile (matches
    // switches_screen.dart/zones_screen.dart). Exit: AnimatedSize collapses
    // the vacated space once _removing forces the child's height to 0,
    // while AnimatedOpacity fades the card out over the same span — see
    // _confirmDelete, which holds the actual removal open until this plays.
    return AnimatedSize(
      duration: Motion.medium,
      curve: Motion.standard,
      alignment: Alignment.topCenter,
      child: SizedBox(
        height: _removing ? 0 : null,
        child: AnimatedOpacity(
          opacity: _removing ? 0 : 1,
          duration: Motion.medium,
          curve: Motion.standard,
          child:
              card
                  .animate(delay: Motion.fast * index)
                  .fadeIn(duration: Motion.medium, curve: Motion.standard)
                  .slideY(
                    begin: 0.08,
                    end: 0,
                    duration: Motion.medium,
                    curve: Motion.standard,
                  ),
        ),
      ),
    );
  }
}

/// Icon + label row for a [PopupMenuItem] — the default text-only menu items
/// felt like a leftover Material default; a leading icon (colored to match
/// the action's intent — primary accent for on, dim ink for off/edit, danger
/// red for delete) reads as more deliberate.
class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.icon, required this.label, required this.color});

  final IconData icon;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 19, color: color),
        const SizedBox(width: Spacing.sm),
        Text(label, style: TextStyle(color: color)),
      ],
    );
  }
}

class _GroupEditorSheet extends ConsumerStatefulWidget {
  const _GroupEditorSheet({required this.devices, required this.existing});

  final List<KnownDevice> devices;
  final SwitchGroup? existing;

  @override
  ConsumerState<_GroupEditorSheet> createState() => _GroupEditorSheetState();
}

class _GroupEditorSheetState extends ConsumerState<_GroupEditorSheet> {
  late final TextEditingController _nameController;
  final Set<String> _selectedMemberKeys = {}; // "deviceId:channelIdx"
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController(text: widget.existing?.name ?? '');
    if (widget.existing != null) {
      for (final m in widget.existing!.members) {
        _selectedMemberKeys.add('${m.deviceId}:${m.channelIdx}');
      }
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving) return;
    final members = _selectedMemberKeys.map((key) {
      final parts = key.split(':');
      return GroupMember(deviceId: parts[0], channelIdx: int.parse(parts[1]));
    }).toList();
    final name = _nameController.text.trim().isEmpty
        ? 'Unnamed group'
        : _nameController.text.trim();

    setState(() => _saving = true);
    try {
      await ref
          .read(groupsProvider.notifier)
          .save(id: widget.existing?.id, name: name, members: members);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Failed to save group. Please try again.'),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: Spacing.md,
        right: Spacing.md,
        top: Spacing.sm,
        bottom: MediaQuery.of(context).viewInsets.bottom + Spacing.md,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 32,
                height: 4,
                margin: const EdgeInsets.only(bottom: Spacing.md),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.outlineVariant,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            Text(
              widget.existing == null ? 'New group' : 'Edit group',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: Spacing.md),
            TextField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: 'Group name'),
            ),
            const SizedBox(height: Spacing.md),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: Text(
                'Switches',
                style: Theme.of(context).textTheme.labelLarge,
              ),
            ),
            for (final device in widget.devices)
              _DeviceSwitchPicker(
                device: device,
                selectedKeys: _selectedMemberKeys,
                onChanged: () => setState(() {}),
              ),
            const SizedBox(height: Spacing.lg),
            FilledButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Save'),
            ),
          ],
        ),
      ),
    );
  }
}

class _DeviceSwitchPicker extends ConsumerWidget {
  const _DeviceSwitchPicker({
    required this.device,
    required this.selectedKeys,
    required this.onChanged,
  });

  final KnownDevice device;
  final Set<String> selectedKeys;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final configAsync = ref.watch(deviceConfigProvider(device));
    return configAsync.when(
      data: (config) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: Spacing.sm),
            child: Text(
              device.friendlyName,
              style: Theme.of(context).textTheme.labelLarge,
            ),
          ),
          for (final sw in config.switches)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              dense: true,
              title: Text(sw.name),
              value: selectedKeys.contains(
                '${device.deviceId}:${sw.channelIdx}',
              ),
              onChanged: (checked) {
                final key = '${device.deviceId}:${sw.channelIdx}';
                if (checked ?? false) {
                  selectedKeys.add(key);
                } else {
                  selectedKeys.remove(key);
                }
                onChanged();
              },
            ),
        ],
      ),
      loading: () => const Padding(
        padding: EdgeInsets.all(Spacing.sm),
        child: LinearProgressIndicator(),
      ),
      error: (e, _) => Padding(
        padding: const EdgeInsets.all(Spacing.sm),
        child: Text('${device.friendlyName}: unreachable'),
      ),
    );
  }
}
