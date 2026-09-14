import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/device_config.dart';
import '../../models/device/schedule.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../shared/empty_devices_view.dart';
import '../shared/empty_state_view.dart';
import '../shared/error_view.dart';
import '../shared/skeleton_loader.dart';

class SchedulesScreen extends ConsumerStatefulWidget {
  const SchedulesScreen({super.key});

  @override
  ConsumerState<SchedulesScreen> createState() => _SchedulesScreenState();
}

class _SchedulesScreenState extends ConsumerState<SchedulesScreen> {
  KnownDevice? _selected;

  @override
  Widget build(BuildContext context) {
    final devices = ref.watch(knownDevicesProvider);

    if (devices.isEmpty) {
      return const Scaffold(body: EmptyDevicesView());
    }

    if (_selected == null ||
        !devices.any((d) => d.deviceId == _selected!.deviceId)) {
      _selected = devices.first;
    }
    final selected = _selected!;

    final configAsync = ref.watch(deviceConfigProvider(selected));

    return Scaffold(
      appBar: AppBar(title: const Text('Schedules')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(Spacing.md),
            child: DropdownButtonFormField<String>(
              initialValue: selected.deviceId,
              decoration: const InputDecoration(labelText: 'Device'),
              items: [
                for (final d in devices)
                  DropdownMenuItem(
                    value: d.deviceId,
                    child: Text(d.friendlyName),
                  ),
              ],
              onChanged: (id) => setState(
                () => _selected = devices.firstWhere((d) => d.deviceId == id),
              ),
            ),
          ),
          Expanded(
            child: configAsync.when(
              data: (config) => _ScheduleList(device: selected, config: config),
              loading: () => const SkeletonListPlaceholder(),
              error: (e, _) => ErrorView(
                message: 'Failed to load device: $e',
                onRetry: () => ref.invalidate(deviceConfigProvider(selected)),
              ),
            ),
          ),
        ],
      ),
      floatingActionButton: configAsync.maybeWhen(
        data: (config) =>
            FloatingActionButton.extended(
              heroTag:
                  null, // avoid Hero-tag collision with other tabs' FABs — see home_shell.dart's IndexedStack
              onPressed: config.switches.isEmpty
                  ? null
                  : () => _openEditor(
                      context,
                      device: selected,
                      config: config,
                      existing: null,
                    ),
              icon: const Icon(Icons.add),
              label: const Text('New schedule'),
            ).animate().scaleXY(
              begin: 0,
              end: 1,
              duration: Motion.medium,
              curve: Curves.easeOutBack,
            ),
        orElse: () => null,
      ),
    );
  }

  void _openEditor(
    BuildContext context, {
    required KnownDevice device,
    required DeviceConfig config,
    required Schedule? existing,
  }) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => _ScheduleEditorSheet(
        device: device,
        config: config,
        existing: existing,
      ),
    );
  }
}

class _ScheduleList extends ConsumerWidget {
  const _ScheduleList({required this.device, required this.config});

  final KnownDevice device;
  final DeviceConfig config;

  IconData _iconFor(ScheduleType type) {
    switch (type) {
      case ScheduleType.countdown:
        return Icons.timer_outlined;
      case ScheduleType.once:
        return Icons.event_outlined;
      case ScheduleType.daily:
      case ScheduleType.weekly:
        return Icons.schedule_outlined;
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (config.schedules.isEmpty) {
      return const EmptyStateView(
        icon: Icons.schedule_outlined,
        title: 'No schedules yet',
        subtitle: 'Tap "New schedule" to add one.',
      );
    }

    return ListView(
      padding: const EdgeInsets.symmetric(vertical: Spacing.sm),
      children: [
        for (final schedule in config.schedules)
          Card(
            child: ListTile(
              leading: CircleAvatar(
                backgroundColor: Theme.of(
                  context,
                ).colorScheme.secondaryContainer,
                child: Icon(
                  _iconFor(schedule.type),
                  color: Theme.of(context).colorScheme.onSecondaryContainer,
                ),
              ),
              title: Text(_summaryFor(schedule, config)),
              subtitle: Text(_scheduleDescription(schedule)),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Switch(
                    value: schedule.enabled,
                    onChanged: (enabled) async {
                      final client = ref.read(
                        activeDeviceApiClientProvider(device),
                      );
                      await client.upsertSchedule(
                        Schedule(
                          id: schedule.id,
                          channelIdx: schedule.channelIdx,
                          action: schedule.action,
                          type: schedule.type,
                          enabled: enabled,
                          time: schedule.time,
                          days: schedule.days,
                          durationS: schedule.durationS,
                        ),
                      );
                      ref.invalidate(deviceConfigProvider(device));
                    },
                  ),
                  IconButton(
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () async {
                      final client = ref.read(
                        activeDeviceApiClientProvider(device),
                      );
                      await client.deleteSchedule(schedule.id);
                      ref.invalidate(deviceConfigProvider(device));
                    },
                  ),
                ],
              ),
              onTap: () => showModalBottomSheet<void>(
                context: context,
                isScrollControlled: true,
                builder: (context) => _ScheduleEditorSheet(
                  device: device,
                  config: config,
                  existing: schedule,
                ),
              ),
            ),
          ),
      ],
    );
  }

  String _summaryFor(Schedule schedule, DeviceConfig config) {
    final sw = config.switches.where(
      (s) => s.channelIdx == schedule.channelIdx,
    );
    final name = sw.isEmpty ? 'Channel ${schedule.channelIdx}' : sw.first.name;
    return '$name → ${schedule.action == ScheduleAction.on ? 'ON' : 'OFF'}';
  }

  String _scheduleDescription(Schedule schedule) {
    switch (schedule.type) {
      case ScheduleType.once:
        return 'Once at ${schedule.time}';
      case ScheduleType.daily:
        return 'Daily at ${schedule.time}';
      case ScheduleType.weekly:
        const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        final days = (schedule.days ?? []).map((d) => names[d - 1]).join(', ');
        return 'Weekly at ${schedule.time} ($days)';
      case ScheduleType.countdown:
        return 'Countdown: ${schedule.durationS}s';
    }
  }
}

class _ScheduleEditorSheet extends ConsumerStatefulWidget {
  const _ScheduleEditorSheet({
    required this.device,
    required this.config,
    required this.existing,
  });

  final KnownDevice device;
  final DeviceConfig config;
  final Schedule? existing;

  @override
  ConsumerState<_ScheduleEditorSheet> createState() =>
      _ScheduleEditorSheetState();
}

class _ScheduleEditorSheetState extends ConsumerState<_ScheduleEditorSheet> {
  late int _channelIdx;
  late ScheduleAction _action;
  late ScheduleType _type;
  TimeOfDay _time = const TimeOfDay(hour: 18, minute: 0);
  Set<int> _days = {1, 2, 3, 4, 5, 6, 7};
  int _durationS = 300;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    _channelIdx =
        existing?.channelIdx ??
        (widget.config.switches.isNotEmpty
            ? widget.config.switches.first.channelIdx
            : 0);
    _action = existing?.action ?? ScheduleAction.on;
    _type = existing?.type ?? ScheduleType.daily;
    if (existing?.time != null) {
      final parts = existing!.time!.split(':');
      _time = TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1]));
    }
    if (existing?.days != null) {
      _days = existing!.days!.toSet();
    }
    _durationS = existing?.durationS ?? 300;
  }

  String get _timeString =>
      '${_time.hour.toString().padLeft(2, '0')}:${_time.minute.toString().padLeft(2, '0')}';

  bool get _isClockType => _type != ScheduleType.countdown;

  Future<void> _save() async {
    setState(() => _saving = true);
    final schedule = Schedule(
      id: widget.existing?.id ?? '',
      channelIdx: _channelIdx,
      action: _action,
      type: _type,
      enabled: widget.existing?.enabled ?? true,
      time: _isClockType ? _timeString : null,
      days: _type == ScheduleType.weekly ? (_days.toList()..sort()) : null,
      durationS: _type == ScheduleType.countdown ? _durationS : null,
    );

    try {
      final client = ref.read(activeDeviceApiClientProvider(widget.device));
      await client.upsertSchedule(schedule);
      ref.invalidate(deviceConfigProvider(widget.device));
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      setState(() => _saving = false);
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed to save: $e')));
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
              widget.existing == null ? 'New schedule' : 'Edit schedule',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: Spacing.md),
            DropdownButtonFormField<int>(
              initialValue: _channelIdx,
              decoration: const InputDecoration(labelText: 'Switch'),
              items: [
                for (final sw in widget.config.switches)
                  DropdownMenuItem(value: sw.channelIdx, child: Text(sw.name)),
              ],
              onChanged: (v) => setState(() => _channelIdx = v!),
            ),
            const SizedBox(height: Spacing.sm),
            DropdownButtonFormField<ScheduleAction>(
              initialValue: _action,
              decoration: const InputDecoration(labelText: 'Action'),
              items: const [
                DropdownMenuItem(
                  value: ScheduleAction.on,
                  child: Text('Turn ON'),
                ),
                DropdownMenuItem(
                  value: ScheduleAction.off,
                  child: Text('Turn OFF'),
                ),
              ],
              onChanged: (v) => setState(() => _action = v!),
            ),
            const SizedBox(height: Spacing.sm),
            DropdownButtonFormField<ScheduleType>(
              initialValue: _type,
              decoration: const InputDecoration(labelText: 'Type'),
              items: const [
                DropdownMenuItem(value: ScheduleType.once, child: Text('Once')),
                DropdownMenuItem(
                  value: ScheduleType.daily,
                  child: Text('Daily'),
                ),
                DropdownMenuItem(
                  value: ScheduleType.weekly,
                  child: Text('Weekly'),
                ),
                DropdownMenuItem(
                  value: ScheduleType.countdown,
                  child: Text('Countdown timer'),
                ),
              ],
              onChanged: (v) => setState(() => _type = v!),
            ),
            const SizedBox(height: Spacing.sm),
            if (_isClockType)
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
                  child: Text(_timeString),
                ),
              ),
            if (_type == ScheduleType.weekly)
              Wrap(
                spacing: Spacing.sm,
                children: [
                  for (final (i, label) in const [
                    'Mon',
                    'Tue',
                    'Wed',
                    'Thu',
                    'Fri',
                    'Sat',
                    'Sun',
                  ].indexed)
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
            if (_type == ScheduleType.countdown)
              TextFormField(
                initialValue: _durationS.toString(),
                decoration: const InputDecoration(
                  labelText: 'Duration (seconds)',
                ),
                keyboardType: TextInputType.number,
                onChanged: (v) => _durationS = int.tryParse(v) ?? _durationS,
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
