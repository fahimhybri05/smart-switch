import 'package:flutter/material.dart';

import '../../models/device/switch_config.dart';
import '../../theme/spacing.dart';

typedef EditSwitchResult = (
  String name,
  String zone,
  InputMode inputMode,
  int inchingMs,
);

/// Shows a switch editor dialog (name, zone, physical-input mode, inching
/// duration). Returns the edited values on save, null on cancel. Caller is
/// responsible for calling upsertSwitch with a full [SwitchConfig] built
/// from these plus the switch's other unchanged fields (channelIdx/type/
/// defaultBootState) — this dialog doesn't know about those.
Future<EditSwitchResult?> showEditSwitchDialog(
  BuildContext context,
  SwitchConfig config,
) {
  return showDialog<EditSwitchResult>(
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
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _nameController = TextEditingController(
    text: widget.switchConfig.name,
  );
  late final TextEditingController _zoneController = TextEditingController(
    text: widget.switchConfig.zone,
  );
  late final TextEditingController _inchingController = TextEditingController(
    text: widget.switchConfig.inchingMs == 0
        ? ''
        : (widget.switchConfig.inchingMs / 1000).toString(),
  );
  late InputMode _inputMode = widget.switchConfig.inputMode;
  bool _saving = false;

  @override
  void dispose() {
    _nameController.dispose();
    _zoneController.dispose();
    _inchingController.dispose();
    super.dispose();
  }

  void _save() {
    // Guards against a rapid double-tap firing Navigator.pop twice — this
    // dialog just returns values to the caller (no async work happens in
    // here), but a second pop would close whatever route is now on top
    // instead of this dialog, which is worth guarding against regardless.
    if (_saving) return;
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    final seconds = double.tryParse(_inchingController.text.trim());
    final inchingMs = (seconds == null || seconds <= 0)
        ? 0
        : (seconds * 1000).round().clamp(0, 600000);
    Navigator.of(context).pop((
      _nameController.text.trim(),
      _zoneController.text.trim(),
      _inputMode,
      inchingMs,
    ));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Edit switch'),
      content: SingleChildScrollView(
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextFormField(
                controller: _nameController,
                autofocus: true,
                decoration: const InputDecoration(labelText: 'Name'),
                validator: (value) => (value == null || value.trim().isEmpty)
                    ? 'Name is required'
                    : null,
              ),
              const SizedBox(height: Spacing.sm),
              TextField(
                controller: _zoneController,
                decoration: const InputDecoration(
                  labelText: 'Zone (optional)',
                ),
              ),
              const SizedBox(height: Spacing.md),
              DropdownButtonFormField<InputMode>(
                initialValue: _inputMode,
                decoration: const InputDecoration(
                  labelText: 'Physical wall-switch input',
                  helperText: 'Only has effect if this channel has a wired '
                      'input GPIO on the device',
                  helperMaxLines: 2,
                ),
                items: const [
                  DropdownMenuItem(
                    value: InputMode.disabled,
                    child: Text('Disabled'),
                  ),
                  DropdownMenuItem(
                    value: InputMode.toggle,
                    child: Text('Toggle (maintained wall switch)'),
                  ),
                  DropdownMenuItem(
                    value: InputMode.edge,
                    child: Text('Push-button (each press flips it)'),
                  ),
                ],
                onChanged: (v) => setState(() => _inputMode = v!),
              ),
              const SizedBox(height: Spacing.sm),
              TextField(
                controller: _inchingController,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: const InputDecoration(
                  labelText: 'Inching / momentary duration (seconds)',
                  helperText: 'Leave blank to disable — auto-reverses this '
                      'switch back OFF this many seconds after it turns ON, '
                      'from any trigger (garage door, doorbell, etc.)',
                  helperMaxLines: 3,
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _save, child: const Text('Save')),
      ],
    );
  }
}
