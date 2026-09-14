import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/local/automation.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../theme/spacing.dart';
import '../shared/empty_devices_view.dart';
import '../shared/empty_state_view.dart';

const _dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

String _describeTrigger(Automation automation, List<KnownDevice> devices) {
  final trigger = automation.trigger;
  if (trigger is ScheduleTrigger) {
    final days = trigger.days.toSet();
    final dayLabel = days.length == 7
        ? 'Every day'
        : days.map((d) => _dayLabels[d - 1]).join(', ');
    final t = trigger.time;
    final hh = t.hour.toString().padLeft(2, '0');
    final mm = t.minute.toString().padLeft(2, '0');
    return '$dayLabel at $hh:$mm';
  }
  final state = trigger as StateTrigger;
  final deviceName = devices
      .where((d) => d.deviceId == state.deviceId)
      .map((d) => d.friendlyName)
      .firstOrNull;
  return 'When ${deviceName ?? state.deviceId} ch${state.channelIdx} turns ${state.state.toJson()}';
}

/// Household-wide automation rules (spec: "advanced automations require
/// event and condition APIs") — evaluated server-side, so they keep
/// running even with every phone closed. Only a household owner may
/// create/edit/delete (see docs/plan.md); any member sees a read-only
/// list.
class AutomationsScreen extends ConsumerWidget {
  const AutomationsScreen({super.key});

  Future<void> _delete(
    BuildContext context,
    WidgetRef ref,
    Automation automation,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete automation?'),
        content: Text('Delete "${automation.name}"?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ref.read(automationsProvider.notifier).remove(automation.id);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  Future<void> _toggleEnabled(WidgetRef ref, Automation automation) async {
    await ref
        .read(automationsProvider.notifier)
        .save(
          id: automation.id,
          householdId: automation.householdId,
          name: automation.name,
          enabled: !automation.enabled,
          trigger: automation.trigger,
          actions: automation.actions,
        );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(knownDevicesProvider);
    final automations = ref.watch(automationsProvider);
    final households = ref.watch(householdsProvider);
    final isOwnerSomewhere = households.any((h) => h.isOwner);

    if (devices.isEmpty) {
      return const Scaffold(body: EmptyDevicesView());
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Automations')),
      body: RefreshIndicator(
        onRefresh: () => ref.read(automationsProvider.notifier).refresh(),
        child: automations.isEmpty
            ? const EmptyStateView(
                icon: Icons.bolt_outlined,
                title: 'No automations yet',
                subtitle: 'Create a rule that runs on its own, even with the app closed.',
              )
            : ListView(
                padding: const EdgeInsets.all(Spacing.md),
                children: [
                  for (final automation in automations)
                    Card(
                      child: ListTile(
                        leading: Icon(
                          automation.trigger is ScheduleTrigger
                              ? Icons.schedule_outlined
                              : Icons.bolt_outlined,
                        ),
                        title: Text(automation.name),
                        subtitle: Text(_describeTrigger(automation, devices)),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Switch(
                              value: automation.enabled,
                              onChanged: isOwnerSomewhere
                                  ? (_) => _toggleEnabled(ref, automation)
                                  : null,
                            ),
                            if (isOwnerSomewhere)
                              PopupMenuButton<String>(
                                onSelected: (value) {
                                  if (value == 'edit') {
                                    showModalBottomSheet<void>(
                                      context: context,
                                      isScrollControlled: true,
                                      builder: (_) => _AutomationEditor(
                                        devices: devices,
                                        existing: automation,
                                      ),
                                    );
                                  } else if (value == 'delete') {
                                    _delete(context, ref, automation);
                                  }
                                },
                                itemBuilder: (_) => const [
                                  PopupMenuItem(value: 'edit', child: Text('Edit')),
                                  PopupMenuItem(value: 'delete', child: Text('Delete')),
                                ],
                              ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
      ),
      floatingActionButton: isOwnerSomewhere
          ? FloatingActionButton.extended(
              onPressed: () => showModalBottomSheet<void>(
                context: context,
                isScrollControlled: true,
                builder: (_) => _AutomationEditor(devices: devices),
              ),
              icon: const Icon(Icons.add_rounded),
              label: const Text('New automation'),
            )
          : null,
    );
  }
}

class _AutomationEditor extends ConsumerStatefulWidget {
  const _AutomationEditor({required this.devices, this.existing});

  final List<KnownDevice> devices;
  final Automation? existing;

  @override
  ConsumerState<_AutomationEditor> createState() => _AutomationEditorState();
}

class _AutomationEditorState extends ConsumerState<_AutomationEditor> {
  late final _nameController = TextEditingController(
    text: widget.existing?.name ?? '',
  );
  bool _isSchedule = true;
  Set<int> _days = {1, 2, 3, 4, 5, 6, 7};
  TimeOfDay _time = TimeOfDay.now();
  String? _triggerDeviceId;
  int? _triggerChannelIdx;
  ChannelPowerState _triggerState = ChannelPowerState.on;
  final Set<String> _selectedActions = {};
  ChannelPowerState _actionState = ChannelPowerState.on;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    if (existing != null) {
      final trigger = existing.trigger;
      if (trigger is ScheduleTrigger) {
        _isSchedule = true;
        _days = trigger.days.toSet();
        _time = trigger.time;
      } else if (trigger is StateTrigger) {
        _isSchedule = false;
        _triggerDeviceId = trigger.deviceId;
        _triggerChannelIdx = trigger.channelIdx;
        _triggerState = trigger.state;
      }
      for (final action in existing.actions) {
        _selectedActions.add('${action.deviceId}:${action.channelIdx}');
      }
      if (existing.actions.isNotEmpty) {
        _actionState = existing.actions.first.state;
      }
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _nameController.text.trim();
    if (name.isEmpty || _selectedActions.isEmpty) return;
    if (!_isSchedule && (_triggerDeviceId == null || _triggerChannelIdx == null)) {
      return;
    }

    final trigger = _isSchedule
        ? ScheduleTrigger(days: _days.toList()..sort(), time: _time)
        : StateTrigger(
            deviceId: _triggerDeviceId!,
            channelIdx: _triggerChannelIdx!,
            state: _triggerState,
          );
    final actions = _selectedActions.map((key) {
      final parts = key.split(':');
      return AutomationAction(
        deviceId: parts[0],
        channelIdx: int.parse(parts[1]),
        state: _actionState,
      );
    }).toList();

    setState(() => _saving = true);
    try {
      await ref
          .read(automationsProvider.notifier)
          .save(
            id: widget.existing?.id,
            householdId: widget.existing?.householdId,
            name: name,
            enabled: widget.existing?.enabled ?? true,
            trigger: trigger,
            actions: actions,
          );
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
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
        bottom: MediaQuery.viewInsetsOf(context).bottom + Spacing.md,
      ),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 32,
                height: 4,
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.outlineVariant,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
            ),
            const SizedBox(height: Spacing.md),
            Text(
              widget.existing == null ? 'New automation' : 'Edit automation',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: Spacing.md),
            TextField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: 'Name'),
            ),
            const SizedBox(height: Spacing.md),
            Text('Trigger', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: Spacing.sm),
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: true, label: Text('Schedule')),
                ButtonSegment(value: false, label: Text('Device state')),
              ],
              selected: {_isSchedule},
              onSelectionChanged: (v) => setState(() => _isSchedule = v.first),
            ),
            const SizedBox(height: Spacing.sm),
            if (_isSchedule) ...[
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Time'),
                trailing: TextButton(
                  onPressed: () async {
                    final picked = await showTimePicker(
                      context: context,
                      initialTime: _time,
                    );
                    if (picked != null) setState(() => _time = picked);
                  },
                  child: Text(
                    '${_time.hour.toString().padLeft(2, '0')}:${_time.minute.toString().padLeft(2, '0')}',
                  ),
                ),
              ),
              Wrap(
                spacing: Spacing.sm,
                children: [
                  for (final (i, label) in _dayLabels.indexed)
                    FilterChip(
                      label: Text(label),
                      selected: _days.contains(i + 1),
                      onSelected: (sel) => setState(() {
                        _days = Set.of(_days);
                        if (sel) {
                          _days.add(i + 1);
                        } else {
                          _days.remove(i + 1);
                        }
                      }),
                    ),
                ],
              ),
            ] else ...[
              _TriggerDevicePicker(
                devices: widget.devices,
                selectedDeviceId: _triggerDeviceId,
                selectedChannelIdx: _triggerChannelIdx,
                onSelected: (deviceId, channelIdx) => setState(() {
                  _triggerDeviceId = deviceId;
                  _triggerChannelIdx = channelIdx;
                }),
              ),
              const SizedBox(height: Spacing.sm),
              SegmentedButton<ChannelPowerState>(
                segments: const [
                  ButtonSegment(
                    value: ChannelPowerState.on,
                    label: Text('Turns on'),
                  ),
                  ButtonSegment(
                    value: ChannelPowerState.off,
                    label: Text('Turns off'),
                  ),
                ],
                selected: {_triggerState},
                onSelectionChanged: (v) => setState(() => _triggerState = v.first),
              ),
            ],
            const SizedBox(height: Spacing.md),
            Text('Then', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: Spacing.sm),
            SegmentedButton<ChannelPowerState>(
              segments: const [
                ButtonSegment(value: ChannelPowerState.on, label: Text('Turn on')),
                ButtonSegment(value: ChannelPowerState.off, label: Text('Turn off')),
              ],
              selected: {_actionState},
              onSelectionChanged: (v) => setState(() => _actionState = v.first),
            ),
            const SizedBox(height: Spacing.sm),
            for (final device in widget.devices)
              _ActionDeviceChoices(
                device: device,
                selected: _selectedActions,
                onChanged: () => setState(() {}),
              ),
            const SizedBox(height: Spacing.md),
            FilledButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Save automation'),
            ),
          ],
        ),
      ),
    );
  }
}

/// Picks exactly one device + channel for a [StateTrigger].
class _TriggerDevicePicker extends ConsumerWidget {
  const _TriggerDevicePicker({
    required this.devices,
    required this.selectedDeviceId,
    required this.selectedChannelIdx,
    required this.onSelected,
  });

  final List<KnownDevice> devices;
  final String? selectedDeviceId;
  final int? selectedChannelIdx;
  final void Function(String deviceId, int channelIdx) onSelected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final device in devices)
          Builder(
            builder: (context) {
              final config = ref.watch(deviceConfigProvider(device));
              return config.when(
                data: (value) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      device.friendlyName,
                      style: Theme.of(context).textTheme.labelLarge,
                    ),
                    for (final sw in value.switches)
                      RadioListTile<String>(
                        contentPadding: EdgeInsets.zero,
                        title: Text(sw.name),
                        value: '${device.deviceId}:${sw.channelIdx}',
                        // ignore: deprecated_member_use
                        groupValue: selectedDeviceId == null
                            ? null
                            : '$selectedDeviceId:$selectedChannelIdx',
                        // ignore: deprecated_member_use
                        onChanged: (_) => onSelected(device.deviceId, sw.channelIdx),
                      ),
                  ],
                ),
                loading: () => const LinearProgressIndicator(),
                error: (_, _) => Text('${device.friendlyName} unavailable'),
              );
            },
          ),
      ],
    );
  }
}

class _ActionDeviceChoices extends ConsumerWidget {
  const _ActionDeviceChoices({
    required this.device,
    required this.selected,
    required this.onChanged,
  });

  final KnownDevice device;
  final Set<String> selected;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final config = ref.watch(deviceConfigProvider(device));
    return config.when(
      data: (value) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            device.friendlyName,
            style: Theme.of(context).textTheme.labelLarge,
          ),
          for (final sw in value.switches)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(sw.name),
              value: selected.contains('${device.deviceId}:${sw.channelIdx}'),
              onChanged: (checked) {
                final key = '${device.deviceId}:${sw.channelIdx}';
                if (checked ?? false) {
                  selected.add(key);
                } else {
                  selected.remove(key);
                }
                onChanged();
              },
            ),
        ],
      ),
      loading: () => const LinearProgressIndicator(),
      error: (_, _) => Text('${device.friendlyName} unavailable'),
    );
  }
}
