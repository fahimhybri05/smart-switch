import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/device_config.dart';
import '../../models/local/known_device.dart';
import '../../models/local/pinned_switch.dart';
import '../../providers/service_providers.dart';
import '../../services/battery_exemption.dart';
import '../../services/widget_service.dart';

Future<void> showPinnedSwitchesDialog(BuildContext context) {
  return showDialog<void>(
    context: context,
    builder: (context) => const _PinnedSwitchesDialog(),
  );
}

class _SwitchOption {
  const _SwitchOption({required this.deviceName, required this.pinned});

  final String deviceName;
  final PinnedSwitch pinned;
}

class _PinnedSwitchesDialog extends ConsumerStatefulWidget {
  const _PinnedSwitchesDialog();

  @override
  ConsumerState<_PinnedSwitchesDialog> createState() =>
      _PinnedSwitchesDialogState();
}

class _PinnedSwitchesDialogState extends ConsumerState<_PinnedSwitchesDialog> {
  bool _loading = true;
  String? _error;
  List<_SwitchOption> _options = [];
  final Set<String> _selectedKeys = {};

  String _keyOf(PinnedSwitch p) => '${p.deviceId}:${p.channelIdx}';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final devices = ref.read(knownDevicesProvider);
      final options = <_SwitchOption>[];
      for (final KnownDevice device in devices) {
        // Cloud-only devices (no LAN IP yet) are pinnable too: the widget's
        // tap/refresh go through viaLocalOrCloud, which falls back to the
        // backend relay when there's no IP.
        final lastKnownIp = device.lastKnownIp;
        final DeviceConfig config;
        try {
          config = await ref
              .read(activeDeviceApiClientProvider(device))
              .getConfig();
        } catch (_) {
          continue; // one unreachable device shouldn't hide the others
        }
        for (final sw in config.switches) {
          options.add(
            _SwitchOption(
              deviceName: device.friendlyName,
              pinned: PinnedSwitch(
                deviceId: device.deviceId,
                lastKnownIp: lastKnownIp,
                channelIdx: sw.channelIdx,
                switchName: sw.name,
              ),
            ),
          );
        }
      }
      final existing = await getPinnedSwitches();
      if (mounted) {
        setState(() {
          _options = options;
          _selectedKeys.addAll(existing.map(_keyOf));
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = '$e';
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Home screen widget'),
      content: SizedBox(width: double.maxFinite, child: _buildContent()),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _loading ? null : _save,
          child: const Text('Save'),
        ),
      ],
    );
  }

  Widget _buildContent() {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_error != null) {
      return Text('Failed to load switches: $_error');
    }
    if (_options.isEmpty) {
      return const Text('No switches found on any known device.');
    }
    return ListView(
      shrinkWrap: true,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Text(
            'Pick up to $maxPinnedSwitches switches. The grid widget shows the first 4; single-switch widgets can use any of them.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
        for (final option in _options)
          CheckboxListTile(
            value: _selectedKeys.contains(_keyOf(option.pinned)),
            title: Text(option.pinned.switchName),
            subtitle: Text(option.deviceName),
            onChanged: (checked) => setState(() {
              final key = _keyOf(option.pinned);
              if (checked ?? false) {
                if (_selectedKeys.length < maxPinnedSwitches) {
                  _selectedKeys.add(key);
                }
              } else {
                _selectedKeys.remove(key);
              }
            }),
          ),
      ],
    );
  }

  Future<void> _save() async {
    final selected = _options
        .where((o) => _selectedKeys.contains(_keyOf(o.pinned)))
        .map((o) => o.pinned)
        .toList();
    await setPinnedSwitches(selected);
    if (!mounted) return;
    Navigator.of(context).pop();
    // Without the exemption, Android blocks the widget's network while the
    // app is in the background, so taps would silently do nothing.
    if (selected.isNotEmpty && !await isBatteryExempt()) {
      await requestBatteryExemption();
    }
  }
}
