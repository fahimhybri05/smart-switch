import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/known_device.dart';
import '../../models/local/pinned_switch.dart';
import '../../providers/service_providers.dart';
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
        // The home-screen widget runs outside the Flutter app's own
        // process/provider tree and only ever does a direct local HTTP
        // call — it can't go through the cloud relay the way in-app
        // screens now can (see activeDeviceApiClientProvider). A device
        // synced in from the backend with no locally-discovered IP yet
        // simply can't be pinned until it's been reached on this LAN at
        // least once.
        final lastKnownIp = device.lastKnownIp;
        if (lastKnownIp == null) continue;

        final config = await ref
            .read(deviceApiClientProvider('http://$lastKnownIp'))
            .getConfig();
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
            'Pick up to $maxPinnedSwitches switches to show on the home-screen widget.',
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
    if (mounted) {
      Navigator.of(context).pop();
    }
  }
}
