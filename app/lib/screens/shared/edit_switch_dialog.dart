import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/switch_config.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../theme/spacing.dart';
import 'friendly_error.dart';

/// Shows the switch settings dialog (name, zone, inching, power, safety
/// limits, lock). Returns the full edited [SwitchConfig] on save (every
/// field the dialog doesn't edit — channelIdx/type/defaultBootState/the
/// hidden input mode — carried over unchanged), or null on cancel.
Future<SwitchConfig?> showEditSwitchDialog(
  BuildContext context,
  SwitchConfig config,
) {
  return showDialog<SwitchConfig>(
    context: context,
    builder: (context) => _EditSwitchDialog(switchConfig: config),
  );
}

/// The whole edit flow shared by every switch tile: open the dialog, save
/// via `POST /api/switches` (the existing upsertSwitch path — the backend
/// persists watts/safety/lock from the same body), refresh the config.
Future<void> editSwitchSettings(
  BuildContext context,
  WidgetRef ref,
  KnownDevice device,
  SwitchConfig switchConfig,
) async {
  final edited = await showEditSwitchDialog(context, switchConfig);
  if (edited == null) return;
  final client = ref.read(activeDeviceApiClientProvider(device));
  try {
    await client.upsertSwitch(edited);
    ref.invalidate(deviceConfigProvider(device));
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(friendlyErrorMessage(e, 'Save'))),
      );
    }
  }
}

/// Shown instead of sending a command when a locked switch is tapped.
void showSwitchLockedSnackBar(BuildContext context) {
  HapticFeedback.heavyImpact();
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(const SnackBar(content: Text('This switch is locked')));
}

class _EditSwitchDialog extends StatefulWidget {
  const _EditSwitchDialog({required this.switchConfig});

  final SwitchConfig switchConfig;

  @override
  State<_EditSwitchDialog> createState() => _EditSwitchDialogState();
}

class _EditSwitchDialogState extends State<_EditSwitchDialog> {
  final _formKey = GlobalKey<FormState>();
  late final SwitchConfig _initial = widget.switchConfig;
  late final _nameController = TextEditingController(text: _initial.name);
  late final _zoneController = TextEditingController(text: _initial.zone);
  late final _inchingController = TextEditingController(
    text: _initial.inchingMs == 0 ? '' : (_initial.inchingMs / 1000).toString(),
  );
  late final _wattsController = TextEditingController(
    text: _initial.watts?.toString() ?? '',
  );
  late final _maxOn = _HoursMinutesControllers(_initial.maxOnSeconds);
  late final _minOff = _HoursMinutesControllers(_initial.minOffSeconds);
  late InputMode _inputMode = _initial.inputMode;
  late bool _locked = _initial.locked;
  bool _saving = false;

  @override
  void dispose() {
    _nameController.dispose();
    _zoneController.dispose();
    _inchingController.dispose();
    _wattsController.dispose();
    _maxOn.dispose();
    _minOff.dispose();
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
    final wattsText = _wattsController.text.trim();
    Navigator.of(context).pop(
      SwitchConfig(
        channelIdx: _initial.channelIdx,
        name: _nameController.text.trim(),
        zone: _zoneController.text.trim(),
        type: _initial.type,
        defaultBootState: _initial.defaultBootState,
        inputMode: _inputMode,
        inchingMs: inchingMs,
        watts: wattsText.isEmpty ? null : int.parse(wattsText),
        maxOnSeconds: _maxOn.seconds,
        minOffSeconds: _minOff.seconds,
        locked: _locked,
      ),
    );
  }

  String? _validateWatts(String? value) {
    final text = value?.trim() ?? '';
    if (text.isEmpty) return null;
    final watts = int.tryParse(text);
    if (watts == null || watts < 0 || watts > SwitchConfig.maxWatts) {
      return 'Enter 0 to ${SwitchConfig.maxWatts}';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final colorScheme = Theme.of(context).colorScheme;
    return AlertDialog(
      title: const Text('Switch settings'),
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
                decoration: const InputDecoration(labelText: 'Zone (optional)'),
              ),
              if (_showWallSwitchInput) ...[
                const SizedBox(height: Spacing.md),
                DropdownButtonFormField<InputMode>(
                  initialValue: _inputMode,
                  decoration: const InputDecoration(
                    labelText: 'Physical wall-switch input',
                    helperText:
                        'Only has effect if this channel has a wired '
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
              ],
              const SizedBox(height: Spacing.sm),
              TextField(
                controller: _inchingController,
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                decoration: const InputDecoration(
                  labelText: 'Inching / momentary duration (seconds)',
                  helperText:
                      'Leave blank to disable — auto-reverses this '
                      'switch back OFF this many seconds after it turns ON, '
                      'from any trigger (garage door, doorbell, etc.)',
                  helperMaxLines: 3,
                ),
              ),
              const SizedBox(height: Spacing.sm),
              TextFormField(
                controller: _wattsController,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                validator: _validateWatts,
                decoration: const InputDecoration(
                  labelText: 'Power (watts)',
                  suffixText: 'W',
                  helperText: 'Optional — used to estimate energy (kWh)',
                ),
              ),
              const SizedBox(height: Spacing.lg),
              Row(
                children: [
                  Icon(
                    Icons.shield_outlined,
                    size: 18,
                    color: colorScheme.primary,
                  ),
                  const SizedBox(width: Spacing.xs),
                  Text(
                    'Safety',
                    style: textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: Spacing.sm),
              _HoursMinutesField(
                label: 'Max run time',
                helper: 'Turns it off automatically after this long ON. '
                    'Leave blank for no limit.',
                controllers: _maxOn,
                maxSeconds: SwitchConfig.maxOnSecondsLimit,
              ),
              const SizedBox(height: Spacing.md),
              _HoursMinutesField(
                label: 'Min off time',
                helper: 'After turning off, it can\'t be turned on again '
                    'remotely until this much time has passed. Leave blank '
                    'for none.',
                controllers: _minOff,
                maxSeconds: SwitchConfig.minOffSecondsLimit,
              ),
              const SizedBox(height: Spacing.sm),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _locked,
                onChanged: (v) => setState(() => _locked = v),
                secondary: Icon(
                  _locked ? Icons.lock_rounded : Icons.lock_open_rounded,
                ),
                title: const Text('Lock switch'),
                subtitle: const Text(
                  'Blocks app, schedules, automations, API and groups; '
                  'physical switch still works',
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

/// Hours + minutes text controllers for one optional duration.
class _HoursMinutesControllers {
  factory _HoursMinutesControllers(int? seconds) {
    if (seconds == null || seconds <= 0) {
      return _HoursMinutesControllers._(null, '', '');
    }
    var h = seconds ~/ 3600;
    var m = ((seconds % 3600) / 60).ceil();
    if (m == 60) {
      h++;
      m = 0;
    }
    return _HoursMinutesControllers._(
      seconds,
      h > 0 ? '$h' : '',
      m > 0 ? '$m' : '',
    );
  }

  _HoursMinutesControllers._(this._initialSeconds, String h, String m)
    : _initialHours = h,
      _initialMinutes = m,
      hours = TextEditingController(text: h),
      minutes = TextEditingController(text: m);

  /// Kept so a value set elsewhere with sub-minute precision (e.g. the web
  /// dashboard) isn't rounded just because some other field was edited.
  final int? _initialSeconds;
  final String _initialHours;
  final String _initialMinutes;
  final TextEditingController hours;
  final TextEditingController minutes;

  /// Null when blank or zero ("off").
  int? get seconds {
    final hText = hours.text.trim();
    final mText = minutes.text.trim();
    if (hText == _initialHours && mText == _initialMinutes) {
      return _initialSeconds;
    }
    final total =
        (int.tryParse(hText) ?? 0) * 3600 + (int.tryParse(mText) ?? 0) * 60;
    return total <= 0 ? null : total;
  }

  void dispose() {
    hours.dispose();
    minutes.dispose();
  }
}

class _HoursMinutesField extends StatelessWidget {
  const _HoursMinutesField({
    required this.label,
    required this.helper,
    required this.controllers,
    required this.maxSeconds,
  });

  final String label;
  final String helper;
  final _HoursMinutesControllers controllers;
  final int maxSeconds;

  String? _validate(String? _) {
    final seconds = controllers.seconds;
    if (seconds != null && seconds > maxSeconds) {
      return 'Max ${maxSeconds ~/ 3600} h';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: textTheme.labelLarge),
        const SizedBox(height: Spacing.xs),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: TextFormField(
                controller: controllers.hours,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                validator: _validate,
                decoration: const InputDecoration(
                  hintText: 'Off',
                  suffixText: 'h',
                  isDense: true,
                ),
              ),
            ),
            const SizedBox(width: Spacing.sm),
            Expanded(
              child: TextFormField(
                controller: controllers.minutes,
                keyboardType: TextInputType.number,
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(4),
                ],
                decoration: const InputDecoration(
                  hintText: 'Off',
                  suffixText: 'min',
                  isDense: true,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: Spacing.xs),
        Text(
          helper,
          style: textTheme.bodySmall?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

// Wall-switch input is hidden for now; the stored mode is kept as-is on save.
const _showWallSwitchInput = false;
