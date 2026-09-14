import 'package:flutter/material.dart';

import '../../models/device/switch_config.dart';
import '../../theme/spacing.dart';

/// Shows a rename/zone dialog for a switch. Returns (name, zone) on save,
/// null on cancel. Caller is responsible for calling upsertSwitch.
Future<(String, String)?> showEditSwitchDialog(
  BuildContext context,
  SwitchConfig config,
) {
  return showDialog<(String, String)>(
    context: context,
    builder: (context) => _EditSwitchDialog(switchConfig: config),
  );
}

class _EditSwitchDialog extends StatefulWidget {
  const _EditSwitchDialog({required this.switchConfig});

  final SwitchConfig switchConfig;

  @override
  State<_EditSwitchDialog> createState() => _EditSwitchDialogState();
}

class _EditSwitchDialogState extends State<_EditSwitchDialog> {
  late final TextEditingController _nameController = TextEditingController(
    text: widget.switchConfig.name,
  );
  late final TextEditingController _zoneController = TextEditingController(
    text: widget.switchConfig.zone,
  );

  @override
  void dispose() {
    _nameController.dispose();
    _zoneController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Edit switch'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _nameController,
            autofocus: true,
            decoration: const InputDecoration(labelText: 'Name'),
          ),
          const SizedBox(height: Spacing.sm),
          TextField(
            controller: _zoneController,
            decoration: const InputDecoration(labelText: 'Zone (optional)'),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(
            context,
          ).pop((_nameController.text.trim(), _zoneController.text.trim())),
          child: const Text('Save'),
        ),
      ],
    );
  }
}
