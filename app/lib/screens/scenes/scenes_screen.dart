import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/local/household.dart';
import '../../models/local/known_device.dart';
import '../../models/local/scene.dart';
import '../../providers/service_providers.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../shared/empty_state_view.dart';
import '../shared/friendly_error.dart';
import 'scene_runner.dart';

/// List + manage household scenes (see the user-features contract). Same
/// shape as the Groups tab: a card per scene, a bottom-sheet editor, and a
/// delete confirmation. Running is also available from the Home row.
class ScenesScreen extends ConsumerStatefulWidget {
  const ScenesScreen({super.key});

  @override
  ConsumerState<ScenesScreen> createState() => _ScenesScreenState();
}

class _ScenesScreenState extends ConsumerState<ScenesScreen> {
  final Set<int> _running = {};

  Future<void> _run(Scene scene) async {
    if (_running.contains(scene.id)) return;
    setState(() => _running.add(scene.id));
    try {
      await runSceneWithFeedback(context, ref, scene);
    } finally {
      if (mounted) setState(() => _running.remove(scene.id));
    }
  }

  Future<void> _confirmDelete(Scene scene) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete scene?'),
        content: Text('Delete "${scene.name}"?'),
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
    if (confirmed != true || !mounted) return;
    try {
      await ref.read(scenesProvider.notifier).remove(scene.id);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(friendlyErrorMessage(e, 'Delete'))),
        );
      }
    }
  }

  void _openEditor(Scene? existing) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => SceneEditorSheet(existing: existing),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scenes = ref.watch(scenesProvider);
    final loggedIn = ref.watch(authProvider) != null;

    return Scaffold(
      appBar: AppBar(title: const Text('Scenes')),
      body: !loggedIn
          ? const EmptyStateView(
              icon: Icons.auto_awesome_outlined,
              title: 'Log in to use scenes',
            )
          : RefreshIndicator(
              onRefresh: () => ref.read(scenesProvider.notifier).refresh(),
              child: scenes.isEmpty
                  ? ListView(
                      children: const [
                        SizedBox(height: 120),
                        EmptyStateView(
                          icon: Icons.auto_awesome_outlined,
                          title: 'No scenes yet',
                          subtitle:
                              'A scene sets several switches at once — '
                              'e.g. "Night" turns everything off.',
                        ),
                      ],
                    )
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(
                        0,
                        Spacing.sm,
                        0,
                        96,
                      ),
                      children: [
                        for (var i = 0; i < scenes.length; i++)
                          _SceneCard(
                                key: ValueKey(scenes[i].id),
                                scene: scenes[i],
                                running: _running.contains(scenes[i].id),
                                onRun: () => _run(scenes[i]),
                                onEdit: () => _openEditor(scenes[i]),
                                onDelete: () => _confirmDelete(scenes[i]),
                              )
                              .animate(delay: Motion.fast * i)
                              .fadeIn(
                                duration: Motion.medium,
                                curve: Motion.standard,
                              )
                              .slideY(
                                begin: 0.08,
                                end: 0,
                                duration: Motion.medium,
                                curve: Motion.standard,
                              ),
                      ],
                    ),
            ),
      floatingActionButton: loggedIn
          ? FloatingActionButton.extended(
              heroTag: null,
              onPressed: () => _openEditor(null),
              icon: const Icon(Icons.add),
              label: const Text('New scene'),
            )
          : null,
    );
  }
}

class _SceneCard extends StatelessWidget {
  const _SceneCard({
    super.key,
    required this.scene,
    required this.running,
    required this.onRun,
    required this.onEdit,
    required this.onDelete,
  });

  final Scene scene;
  final bool running;
  final VoidCallback onRun;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final onCount = scene.actions
        .where((a) => a.state == ChannelPowerState.on)
        .length;
    final offCount = scene.actions.length - onCount;
    final summary = [
      if (onCount > 0) '$onCount on',
      if (offCount > 0) '$offCount off',
    ].join(' • ');
    return Card(
      child: ListTile(
        onTap: onEdit,
        leading: CircleAvatar(
          backgroundColor: colorScheme.primaryContainer,
          foregroundColor: colorScheme.onPrimaryContainer,
          child: Icon(sceneIconData(scene.icon)),
        ),
        title: Text(
          scene.name,
          style: Theme.of(
            context,
          ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
        ),
        subtitle: Text(summary.isEmpty ? 'No actions' : summary),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            running
                ? const Padding(
                    padding: EdgeInsets.all(12),
                    child: SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : IconButton(
                    icon: const Icon(Icons.play_arrow_rounded),
                    tooltip: 'Run',
                    onPressed: onRun,
                  ),
            PopupMenuButton<String>(
              icon: const Icon(Icons.more_horiz_rounded),
              onSelected: (v) => v == 'edit' ? onEdit() : onDelete(),
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'edit', child: Text('Edit scene')),
                PopupMenuItem(value: 'delete', child: Text('Delete scene')),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Create/edit sheet: name, icon, household (only when there's a choice),
/// and per-switch ON/OFF actions picked across every known device.
class SceneEditorSheet extends ConsumerStatefulWidget {
  const SceneEditorSheet({super.key, required this.existing});

  final Scene? existing;

  @override
  ConsumerState<SceneEditorSheet> createState() => _SceneEditorSheetState();
}

class _SceneEditorSheetState extends ConsumerState<SceneEditorSheet> {
  late final _nameController = TextEditingController(
    text: widget.existing?.name ?? '',
  );
  late String? _icon = widget.existing?.icon;
  int? _householdId;

  /// "deviceId:channelIdx" → desired state; insertion-ordered.
  final Map<String, ChannelPowerState> _actions = {};
  bool _saving = false;

  /// Shown inline above Save — a snackbar would land behind this sheet.
  String? _error;

  @override
  void initState() {
    super.initState();
    _householdId = widget.existing?.householdId;
    for (final a in widget.existing?.actions ?? const <SceneAction>[]) {
      _actions['${a.deviceId}:${a.channelIdx}'] = a.state;
    }
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving) return;
    final name = _nameController.text.trim();
    String? problem;
    if (name.isEmpty) {
      problem = 'Give the scene a name.';
    } else if (name.length > Scene.maxNameLength) {
      problem = 'Keep the name under ${Scene.maxNameLength} characters.';
    } else if (_actions.isEmpty) {
      problem = 'Pick at least one switch.';
    } else if (_actions.length > Scene.maxActions) {
      problem = 'A scene can have at most ${Scene.maxActions} switches.';
    }
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    final actions = _actions.entries.map((e) {
      final sep = e.key.lastIndexOf(':');
      return SceneAction(
        deviceId: e.key.substring(0, sep),
        channelIdx: int.parse(e.key.substring(sep + 1)),
        state: e.value,
      );
    }).toList();

    // Matches what the dropdown shows by default; with a single household
    // it's omitted and the backend picks it.
    final households = ref.read(householdsProvider);
    final householdId =
        _householdId ??
        (widget.existing == null && households.length > 1
            ? households.first.id
            : null);

    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref
          .read(scenesProvider.notifier)
          .save(
            id: widget.existing?.id,
            householdId: householdId,
            name: name,
            icon: _icon,
            actions: actions,
          );
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        setState(() => _error = friendlyErrorMessage(e, 'Saving the scene'));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final devices = ref.watch(knownDevicesProvider);
    final households = ref.watch(householdsProvider);
    final knownIds = {for (final d in devices) d.deviceId};
    final otherDeviceActions = _actions.keys
        .where((k) => !knownIds.contains(k.substring(0, k.lastIndexOf(':'))))
        .length;
    final textTheme = Theme.of(context).textTheme;

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
              widget.existing == null ? 'New scene' : 'Edit scene',
              style: textTheme.titleLarge,
            ),
            const SizedBox(height: Spacing.md),
            TextField(
              controller: _nameController,
              maxLength: Scene.maxNameLength,
              decoration: const InputDecoration(
                labelText: 'Scene name',
                counterText: '',
              ),
            ),
            const SizedBox(height: Spacing.md),
            Text('Icon', style: textTheme.labelLarge),
            const SizedBox(height: Spacing.xs),
            Wrap(
              spacing: Spacing.xs,
              runSpacing: Spacing.xs,
              children: [
                for (final icon in SceneIcons.all)
                  ChoiceChip(
                    avatar: Icon(sceneIconData(icon), size: 18),
                    label: Text(sceneIconLabel(icon)),
                    showCheckmark: false,
                    selected: _icon == icon,
                    onSelected: (selected) =>
                        setState(() => _icon = selected ? icon : null),
                  ),
              ],
            ),
            if (widget.existing == null && households.length > 1) ...[
              const SizedBox(height: Spacing.md),
              DropdownButtonFormField<int>(
                initialValue: _householdId ?? households.first.id,
                decoration: const InputDecoration(labelText: 'Household'),
                items: [
                  for (final Household h in households)
                    DropdownMenuItem(value: h.id, child: Text(h.name)),
                ],
                onChanged: (id) => setState(() => _householdId = id),
              ),
            ],
            const SizedBox(height: Spacing.md),
            Text(
              'Switches (${_actions.length})',
              style: textTheme.labelLarge,
            ),
            if (otherDeviceActions > 0)
              Padding(
                padding: const EdgeInsets.only(top: Spacing.xs),
                child: Text(
                  '$otherDeviceActions action(s) on devices not on this '
                  'phone are kept as-is.',
                  style: textTheme.bodySmall,
                ),
              ),
            for (final device in devices)
              _DeviceActionPicker(
                device: device,
                actions: _actions,
                onChanged: () => setState(() {}),
              ),
            const SizedBox(height: Spacing.lg),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: Spacing.sm),
                child: Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
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

class _DeviceActionPicker extends ConsumerWidget {
  const _DeviceActionPicker({
    required this.device,
    required this.actions,
    required this.onChanged,
  });

  final KnownDevice device;
  final Map<String, ChannelPowerState> actions;
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
            _ActionRow(
              label: sw.name,
              locked: sw.locked,
              actionKey: '${device.deviceId}:${sw.channelIdx}',
              actions: actions,
              onChanged: onChanged,
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

class _ActionRow extends StatelessWidget {
  const _ActionRow({
    required this.label,
    required this.locked,
    required this.actionKey,
    required this.actions,
    required this.onChanged,
  });

  final String label;
  final bool locked;
  final String actionKey;
  final Map<String, ChannelPowerState> actions;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final state = actions[actionKey];
    final included = state != null;
    return Row(
      children: [
        Checkbox(
          value: included,
          onChanged: (checked) {
            if (checked ?? false) {
              actions[actionKey] = ChannelPowerState.on;
            } else {
              actions.remove(actionKey);
            }
            onChanged();
          },
        ),
        Expanded(
          child: Row(
            children: [
              Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
              if (locked) ...[
                const SizedBox(width: Spacing.xs),
                Icon(
                  Icons.lock_rounded,
                  size: 14,
                  color: Theme.of(context).colorScheme.tertiary,
                  semanticLabel: 'Locked',
                ),
              ],
            ],
          ),
        ),
        SegmentedButton<ChannelPowerState>(
          showSelectedIcon: false,
          style: const ButtonStyle(visualDensity: VisualDensity.compact),
          segments: const [
            ButtonSegment(value: ChannelPowerState.on, label: Text('ON')),
            ButtonSegment(value: ChannelPowerState.off, label: Text('OFF')),
          ],
          selected: {state ?? ChannelPowerState.on},
          onSelectionChanged: included
              ? (s) {
                  actions[actionKey] = s.first;
                  onChanged();
                }
              : null,
        ),
      ],
    );
  }
}
