import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/channel_state.dart';
import '../../models/local/known_device.dart';
import '../../models/local/smart_scene.dart';
import '../../providers/service_providers.dart';
import '../../theme/spacing.dart';
import '../shared/device_sync_gate.dart';
import '../shared/empty_state_view.dart';

class ScenesScreen extends ConsumerWidget {
  const ScenesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(knownDevicesProvider);
    final scenes = ref.watch(scenesProvider);
    final deviceGate = buildDeviceEmptyOrLoadingState(ref, devices);
    if (deviceGate != null) {
      return Scaffold(body: deviceGate);
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Scenes')),
      body: scenes.isEmpty
          ? const EmptyStateView(
              icon: Icons.auto_awesome_outlined,
              title: 'No scenes yet',
              subtitle: 'Create a one-tap routine for your home.',
            )
          : ListView(
              padding: const EdgeInsets.symmetric(vertical: Spacing.sm),
              children: [
                for (final scene in scenes)
                  _SceneCard(scene: scene, devices: devices),
              ],
            ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          builder: (_) => _SceneEditor(devices: devices),
        ),
        icon: const Icon(Icons.add_rounded),
        label: const Text('New scene'),
      ),
    );
  }
}

class _SceneCard extends ConsumerWidget {
  const _SceneCard({required this.scene, required this.devices});

  final SmartScene scene;
  final List<KnownDevice> devices;

  Future<void> _run(BuildContext context, WidgetRef ref) async {
    HapticFeedback.mediumImpact();
    await Future.wait(
      scene.members.map((member) async {
        final device = devices.where(
          (item) => item.deviceId == member.deviceId,
        );
        if (device.isEmpty) return;
        final known = device.first;
        final desired = member.state == 'ON'
            ? ChannelPowerState.on
            : ChannelPowerState.off;
        ref
            .read(channelOverrideProvider.notifier)
            .set(known.deviceId, member.channelIdx, desired);
        try {
          await ref
              .read(activeDeviceApiClientProvider(known))
              .setChannelState(member.channelIdx, desired);
        } catch (_) {}
      }),
    );
    for (final member in scene.members) {
      final device = devices.where((item) => item.deviceId == member.deviceId);
      if (device.isNotEmpty) {
        ref.invalidate(channelStatesProvider(device.first));
      }
    }
    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('${scene.name} activated')));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colorScheme = Theme.of(context).colorScheme;
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(24),
        onTap: () => _run(context, ref),
        child: Padding(
          padding: const EdgeInsets.all(Spacing.md),
          child: Row(
            children: [
              Container(
                width: 52,
                height: 52,
                decoration: BoxDecoration(
                  color: colorScheme.secondaryContainer,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Icon(
                  Icons.auto_awesome_rounded,
                  color: colorScheme.onSecondaryContainer,
                ),
              ),
              const SizedBox(width: Spacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      scene.name,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      '${scene.members.length} actions',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              FilledButton(
                onPressed: () => _run(context, ref),
                child: const Text('Run'),
              ),
              PopupMenuButton<String>(
                onSelected: (value) {
                  if (value == 'delete') {
                    ref.read(scenesProvider.notifier).remove(scene.id);
                  }
                },
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'delete', child: Text('Delete scene')),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SceneEditor extends ConsumerStatefulWidget {
  const _SceneEditor({required this.devices});

  final List<KnownDevice> devices;

  @override
  ConsumerState<_SceneEditor> createState() => _SceneEditorState();
}

class _SceneEditorState extends ConsumerState<_SceneEditor> {
  final _nameController = TextEditingController();
  final _selected = <String>{};
  bool _turnOn = true;

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _nameController.text.trim();
    if (name.isEmpty || _selected.isEmpty) return;
    final members = _selected.map((key) {
      final parts = key.split(':');
      return SceneMember(
        deviceId: parts[0],
        channelIdx: int.parse(parts[1]),
        state: _turnOn ? 'ON' : 'OFF',
      );
    }).toList();
    await ref
        .read(scenesProvider.notifier)
        .upsert(
          SmartScene(
            id: DateTime.now().microsecondsSinceEpoch.toString(),
            name: name,
            icon: 'auto_awesome',
            members: members,
          ),
        );
    if (mounted) Navigator.of(context).pop();
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
            Text('New scene', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: Spacing.md),
            TextField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: 'Scene name'),
            ),
            const SizedBox(height: Spacing.sm),
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: true, label: Text('Turn on')),
                ButtonSegment(value: false, label: Text('Turn off')),
              ],
              selected: {_turnOn},
              onSelectionChanged: (value) =>
                  setState(() => _turnOn = value.first),
            ),
            const SizedBox(height: Spacing.sm),
            for (final device in widget.devices)
              _DeviceChoices(
                device: device,
                selected: _selected,
                onChanged: () => setState(() {}),
              ),
            const SizedBox(height: Spacing.md),
            FilledButton(onPressed: _save, child: const Text('Save scene')),
          ],
        ),
      ),
    );
  }
}

class _DeviceChoices extends ConsumerWidget {
  const _DeviceChoices({
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
