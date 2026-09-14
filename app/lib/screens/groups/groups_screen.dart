import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/local/known_device.dart';
import '../../models/local/switch_group.dart';
import '../../providers/service_providers.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../shared/empty_devices_view.dart';
import '../shared/empty_state_view.dart';
import '../shared/device_visualization.dart';

class GroupsScreen extends ConsumerWidget {
  const GroupsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(knownDevicesProvider);
    final groups = ref.watch(groupsProvider);

    if (devices.isEmpty) {
      return const Scaffold(body: EmptyDevicesView());
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
                for (final group in groups)
                  _GroupTile(group: group, devices: devices),
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

class _GroupTile extends ConsumerWidget {
  const _GroupTile({required this.group, required this.devices});

  final SwitchGroup group;
  final List<KnownDevice> devices;

  KnownDevice? _deviceFor(String deviceId) {
    for (final d in devices) {
      if (d.deviceId == deviceId) return d;
    }
    return null;
  }

  Future<void> _toggleAll(WidgetRef ref, bool on) async {
    HapticFeedback.mediumImpact();
    final desired = on ? ChannelPowerState.on : ChannelPowerState.off;
    final overrideNotifier = ref.read(channelOverrideProvider.notifier);
    final touchedDevices = <KnownDevice>{};

    // Fire every member's command in parallel (was a sequential await-in-a-
    // for-loop — N members paid N round-trips serially, which is what made
    // group toggling feel especially slow). Each member also gets the same
    // instant optimistic flip individual tiles get — see
    // channelOverrideProvider's doc comment.
    await Future.wait(
      group.members.map((member) async {
        final device = _deviceFor(member.deviceId);
        if (device == null) return;
        touchedDevices.add(device);
        overrideNotifier.set(device.deviceId, member.channelIdx, desired);
        final client = ref.read(activeDeviceApiClientProvider(device));
        try {
          await client.setChannelState(member.channelIdx, desired);
        } catch (_) {
          // Best-effort fan-out (spec §7) — one unreachable member shouldn't
          // block the rest.
        }
      }),
    );

    for (final device in touchedDevices) {
      ref.invalidate(channelStatesProvider(device));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
      if (channelsAsync.hasError) anyOffline = true;
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

    return Card(
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
                  : () => _toggleAll(ref, !allOn),
            ),
          ),
          title: Text(group.name),
          subtitle: Text('${group.members.length} switch(es) • $stateLabel'),
          trailing: PopupMenuButton<String>(
            icon: const Icon(Icons.more_horiz_rounded),
            onSelected: (action) {
              if (action == 'on') {
                _toggleAll(ref, true);
              } else if (action == 'off') {
                _toggleAll(ref, false);
              } else if (action == 'edit') {
                showModalBottomSheet<void>(
                  context: context,
                  isScrollControlled: true,
                  builder: (context) =>
                      _GroupEditorSheet(devices: devices, existing: group),
                );
              } else if (action == 'delete') {
                ref.read(groupsProvider.notifier).remove(group.id).catchError(
                  (Object e) {
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(content: Text('Failed to delete group: $e')),
                      );
                    }
                  },
                );
              }
            },
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'on', child: Text('Turn all on')),
              PopupMenuItem(value: 'off', child: Text('Turn all off')),
              PopupMenuDivider(),
              PopupMenuItem(value: 'edit', child: Text('Edit group')),
              PopupMenuItem(value: 'delete', child: Text('Delete group')),
            ],
          ),
        ),
      ),
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
    final members = _selectedMemberKeys.map((key) {
      final parts = key.split(':');
      return GroupMember(deviceId: parts[0], channelIdx: int.parse(parts[1]));
    }).toList();
    final name = _nameController.text.trim().isEmpty
        ? 'Unnamed group'
        : _nameController.text.trim();

    try {
      await ref
          .read(groupsProvider.notifier)
          .save(id: widget.existing?.id, name: name, members: members);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed to save group: $e')));
      }
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
            FilledButton(onPressed: _save, child: const Text('Save')),
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
