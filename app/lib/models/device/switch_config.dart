enum SwitchType {
  onOff,
  dimmer; // reserved, spec §2 — relay modules are ON/OFF only today

  String toJson() => switch (this) {
    SwitchType.onOff => 'ON_OFF',
    SwitchType.dimmer => 'DIMMER',
  };

  static SwitchType fromJson(String value) => switch (value) {
    'DIMMER' => SwitchType.dimmer,
    _ => SwitchType.onOff,
  };
}

enum BootState {
  off,
  on,
  last;

  String toJson() => switch (this) {
    BootState.off => 'OFF',
    BootState.on => 'ON',
    BootState.last => 'LAST',
  };

  static BootState fromJson(String value) => switch (value) {
    'ON' => BootState.on,
    'LAST' => BootState.last,
    _ => BootState.off,
  };
}

/// Physical wall-switch/button wired to this channel's input GPIO (firmware
/// `physical_input` component — no effect unless the board also has a real
/// GPIO assigned to this channel, which is a compile-time firmware setting,
/// not something this field alone can turn on).
enum InputMode {
  /// No physical input read for this channel (default).
  disabled,

  /// A maintained wall switch — the relay directly mirrors the input's
  /// engaged/not-engaged position.
  toggle,

  /// A momentary push-button — each press flips the relay's current state.
  edge;

  String toJson() => switch (this) {
    InputMode.disabled => 'DISABLED',
    InputMode.toggle => 'TOGGLE',
    InputMode.edge => 'EDGE',
  };

  static InputMode fromJson(String value) => switch (value) {
    'TOGGLE' => InputMode.toggle,
    'EDGE' => InputMode.edge,
    _ => InputMode.disabled,
  };
}

class SwitchConfig {
  const SwitchConfig({
    required this.channelIdx,
    required this.name,
    required this.zone,
    required this.type,
    required this.defaultBootState,
    this.inputMode = InputMode.disabled,
    this.inchingMs = 0,
  });

  final int channelIdx;
  final String name;
  final String zone;
  final SwitchType type;
  final BootState defaultBootState;

  /// See [InputMode].
  final InputMode inputMode;

  /// 0 = disabled. Otherwise, milliseconds after being turned ON before the
  /// device auto-reverses this channel back OFF (garage-door/doorbell-style
  /// momentary/"inching" mode) — applies regardless of what triggered the
  /// ON (app, schedule, physical input).
  final int inchingMs;

  factory SwitchConfig.fromJson(Map<String, dynamic> json) => SwitchConfig(
    channelIdx: json['channel_idx'] as int,
    name: json['name'] as String,
    zone: json['zone'] as String,
    type: SwitchType.fromJson(json['type'] as String),
    defaultBootState: BootState.fromJson(json['default_boot_state'] as String),
    inputMode: InputMode.fromJson(json['input_mode'] as String? ?? 'DISABLED'),
    inchingMs: json['inching_ms'] as int? ?? 0,
  );

  Map<String, dynamic> toJson() => {
    'channel_idx': channelIdx,
    'name': name,
    'zone': zone,
    'type': type.toJson(),
    'default_boot_state': defaultBootState.toJson(),
    'input_mode': inputMode.toJson(),
    'inching_ms': inchingMs,
  };
}
