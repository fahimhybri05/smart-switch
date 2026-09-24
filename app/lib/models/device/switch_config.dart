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
    this.watts,
    this.maxOnSeconds,
    this.minOffSeconds,
    this.locked = false,
  });

  /// Backend-enforced limits (see the user-features contract).
  static const maxWatts = 100000;
  static const maxOnSecondsLimit = 604800; // 7 days
  static const minOffSecondsLimit = 86400; // 24 hours

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

  /// Rated power of the connected load, for kWh estimates in usage stats.
  /// Null = not set.
  final int? watts;

  /// Safety: the backend turns this switch OFF once it has been ON this
  /// long (`max_on_s`). Null = off.
  final int? maxOnSeconds;

  /// Safety: after turning OFF, remote commands can't turn it back ON until
  /// this long has passed (`min_off_s`). Null = off.
  final int? minOffSeconds;

  /// Blocks every remote command (app, schedules, automations, API,
  /// groups, scenes). The physical switch on the board still works.
  final bool locked;

  factory SwitchConfig.fromJson(Map<String, dynamic> json) => SwitchConfig(
    channelIdx: json['channel_idx'] as int,
    name: json['name'] as String,
    zone: json['zone'] as String,
    type: SwitchType.fromJson(json['type'] as String),
    defaultBootState: BootState.fromJson(json['default_boot_state'] as String),
    inputMode: InputMode.fromJson(json['input_mode'] as String? ?? 'DISABLED'),
    inchingMs: json['inching_ms'] as int? ?? 0,
    watts: (json['watts'] as num?)?.toInt(),
    maxOnSeconds: (json['max_on_s'] as num?)?.toInt(),
    minOffSeconds: (json['min_off_s'] as num?)?.toInt(),
    locked: json['locked'] as bool? ?? false,
  );

  /// Always sends `watts`/`max_on_s`/`min_off_s`/`locked`, with explicit
  /// nulls for unset values: the backend preserves OMITTED fields but
  /// clears ones sent as null, so a full round-trip of an edited config is
  /// what makes "blank = off" actually clear a previously-set value.
  Map<String, dynamic> toJson() => {
    'channel_idx': channelIdx,
    'name': name,
    'zone': zone,
    'type': type.toJson(),
    'default_boot_state': defaultBootState.toJson(),
    'input_mode': inputMode.toJson(),
    'inching_ms': inchingMs,
    'watts': watts,
    'max_on_s': maxOnSeconds,
    'min_off_s': minOffSeconds,
    'locked': locked,
  };

  /// Only covers the non-nullable fields — build a fresh [SwitchConfig] to
  /// clear [watts]/[maxOnSeconds]/[minOffSeconds].
  SwitchConfig copyWith({
    String? name,
    String? zone,
    InputMode? inputMode,
    int? inchingMs,
    bool? locked,
  }) => SwitchConfig(
    channelIdx: channelIdx,
    name: name ?? this.name,
    zone: zone ?? this.zone,
    type: type,
    defaultBootState: defaultBootState,
    inputMode: inputMode ?? this.inputMode,
    inchingMs: inchingMs ?? this.inchingMs,
    watts: watts,
    maxOnSeconds: maxOnSeconds,
    minOffSeconds: minOffSeconds,
    locked: locked ?? this.locked,
  );
}
