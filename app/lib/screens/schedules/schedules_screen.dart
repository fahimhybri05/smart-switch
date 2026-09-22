import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/device_config.dart';
import '../../models/device/schedule.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../shared/device_sync_gate.dart';
import '../shared/empty_state_view.dart';
import '../shared/error_view.dart';
import '../shared/friendly_error.dart';
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

    final deviceGate = buildDeviceEmptyOrLoadingState(ref, devices);
    if (deviceGate != null) {
      return Scaffold(body: deviceGate);
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

class _ScheduleList extends ConsumerStatefulWidget {
  const _ScheduleList({required this.device, required this.config});

  final KnownDevice device;
  final DeviceConfig config;

  @override
  ConsumerState<_ScheduleList> createState() => _ScheduleListState();
}

class _ScheduleListState extends ConsumerState<_ScheduleList> {
  // Gap 1 (optimistic enable/disable toggle): schedule.id -> the value shown
  // immediately on tap, ahead of the network round-trip, mirroring
  // DeviceTile._toggle's optimistic pattern (but scoped locally here rather
  // than via channelOverrideProvider, which is specific to device channel
  // state). Cleared once the in-flight request settles.
  final Map<String, bool> _optimisticEnabled = {};
  final Set<String> _pendingToggles = {};

  // Gap 2 (animated delete): schedule.id -> mid-removal-animation state.
  // `_fadingIds` drives an opacity fade-out while the item is still at full
  // size; once that fade completes we move the id into `_collapsedIds`,
  // which swaps the item's content for a zero-size placeholder so
  // AnimatedSize can smoothly collapse the space it occupied, instead of the
  // item just vanishing the instant the schedule disappears from `config`.
  final Set<String> _fadingIds = {};
  final Set<String> _collapsedIds = {};

  KnownDevice get device => widget.device;
  DeviceConfig get config => widget.config;

  Future<void> _toggleEnabled(Schedule schedule, bool enabled) async {
    setState(() {
      _optimisticEnabled[schedule.id] = enabled;
      _pendingToggles.add(schedule.id);
    });
    try {
      final client = ref.read(activeDeviceApiClientProvider(device));
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
          solarOffsetMin: schedule.solarOffsetMin,
        ),
      );
      ref.invalidate(deviceConfigProvider(device));
      if (mounted) {
        setState(() => _optimisticEnabled.remove(schedule.id));
      }
    } catch (e) {
      if (mounted) {
        setState(() => _optimisticEnabled.remove(schedule.id));
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyErrorMessage(e, 'Update'))),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _pendingToggles.remove(schedule.id));
      }
    }
  }

  Future<void> _confirmDelete(Schedule schedule) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete schedule?'),
        content: Text('Delete "${_summaryFor(schedule, config)}"?'),
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

    setState(() => _fadingIds.add(schedule.id));
    final client = ref.read(activeDeviceApiClientProvider(device));
    final deleteFuture = client.deleteSchedule(schedule.id);

    // Let the fade play out (item still full-size) before collapsing the
    // space it occupies, so the removal reads as fade-then-shrink rather
    // than an instant cut. The network call above runs concurrently so this
    // doesn't add latency beyond the animation itself.
    await Future.delayed(Motion.fast);
    if (mounted) {
      setState(() {
        _fadingIds.remove(schedule.id);
        _collapsedIds.add(schedule.id);
      });
    }

    try {
      await deleteFuture;
      ref.invalidate(deviceConfigProvider(device));
    } catch (e) {
      if (mounted) {
        setState(() => _collapsedIds.remove(schedule.id));
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyErrorMessage(e, 'Delete'))),
        );
      }
    }
  }

  IconData _iconFor(ScheduleType type) {
    switch (type) {
      case ScheduleType.countdown:
        return Icons.hourglass_bottom_outlined;
      case ScheduleType.once:
        return Icons.event_outlined;
      case ScheduleType.daily:
        return Icons.today_outlined;
      case ScheduleType.weekly:
        return Icons.date_range_outlined;
      case ScheduleType.sunrise:
        return Icons.wb_twilight_outlined;
      case ScheduleType.sunset:
        return Icons.nights_stay_outlined;
    }
  }

  @override
  Widget build(BuildContext context) {
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
          AnimatedSize(
            key: ValueKey(schedule.id),
            duration: Motion.medium,
            curve: Motion.standard,
            alignment: Alignment.topCenter,
            child: AnimatedOpacity(
              duration: Motion.fast,
              opacity: _fadingIds.contains(schedule.id) ? 0 : 1,
              child: _collapsedIds.contains(schedule.id)
                  ? const SizedBox(width: double.infinity)
                  : Card(
                      child: ListTile(
                        leading: Container(
                          width: 40,
                          height: 40,
                          decoration: BoxDecoration(
                            color: Theme.of(
                              context,
                            ).colorScheme.primaryContainer,
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Icon(
                            _iconFor(schedule.type),
                            color: Theme.of(
                              context,
                            ).colorScheme.onPrimaryContainer,
                            size: 20,
                          ),
                        ),
                        title: Text(_summaryFor(schedule, config)),
                        subtitle: Text(_scheduleDescription(schedule)),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Switch(
                              value:
                                  _optimisticEnabled[schedule.id] ??
                                  schedule.enabled,
                              onChanged: _pendingToggles.contains(schedule.id)
                                  ? null
                                  : (enabled) =>
                                        _toggleEnabled(schedule, enabled),
                            ),
                            const SizedBox(width: Spacing.xs),
                            IconButton(
                              icon: Icon(
                                Icons.delete_outline,
                                color: Theme.of(context).colorScheme.error,
                              ),
                              onPressed: () => _confirmDelete(schedule),
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
      case ScheduleType.sunrise:
        return 'Sunrise${_offsetSuffix(schedule.solarOffsetMin)}';
      case ScheduleType.sunset:
        return 'Sunset${_offsetSuffix(schedule.solarOffsetMin)}';
    }
  }

  String _offsetSuffix(int? offsetMin) {
    if (offsetMin == null || offsetMin == 0) return '';
    return offsetMin > 0 ? ' (+${offsetMin}m)' : ' (${offsetMin}m)';
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
  int _solarOffsetMin = 0;
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
    _solarOffsetMin = existing?.solarOffsetMin ?? 0;
  }

  String get _timeString =>
      '${_time.hour.toString().padLeft(2, '0')}:${_time.minute.toString().padLeft(2, '0')}';

  bool get _isWallClockType =>
      _type == ScheduleType.once ||
      _type == ScheduleType.daily ||
      _type == ScheduleType.weekly;

  bool get _isSolarType =>
      _type == ScheduleType.sunrise || _type == ScheduleType.sunset;

  Future<void> _save() async {
    setState(() => _saving = true);
    final schedule = Schedule(
      id: widget.existing?.id ?? '',
      channelIdx: _channelIdx,
      action: _action,
      type: _type,
      enabled: widget.existing?.enabled ?? true,
      time: _isWallClockType ? _timeString : null,
      days: _type == ScheduleType.weekly ? (_days.toList()..sort()) : null,
      durationS: _type == ScheduleType.countdown ? _durationS : null,
      solarOffsetMin: _isSolarType ? _solarOffsetMin : null,
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
                DropdownMenuItem(
                  value: ScheduleType.sunrise,
                  child: Text('Sunrise'),
                ),
                DropdownMenuItem(
                  value: ScheduleType.sunset,
                  child: Text('Sunset'),
                ),
              ],
              onChanged: (v) => setState(() => _type = v!),
            ),
            const SizedBox(height: Spacing.sm),
            if (_isSolarType && !widget.config.locationSet)
              Padding(
                padding: const EdgeInsets.only(bottom: Spacing.sm),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      Icons.warning_amber_rounded,
                      size: 18,
                      color: Theme.of(context).colorScheme.secondary,
                    ),
                    const SizedBox(width: Spacing.sm),
                    Expanded(
                      child: Text(
                        "This device has no location set — set it under "
                        "Settings before saving, or this schedule won't fire.",
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.secondary,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            if (_isWallClockType)
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
            if (_isSolarType)
              TextFormField(
                initialValue: _solarOffsetMin.toString(),
                decoration: const InputDecoration(
                  labelText: 'Offset (minutes)',
                  helperText: 'Negative = before, positive = after, e.g. '
                      '-30 for "30 min before sunset"',
                  helperMaxLines: 2,
                ),
                keyboardType: const TextInputType.numberWithOptions(
                  signed: true,
                ),
                onChanged: (v) =>
                    _solarOffsetMin = int.tryParse(v) ?? _solarOffsetMin,
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
