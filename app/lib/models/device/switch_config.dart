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

class SwitchConfig {
  const SwitchConfig({
    required this.channelIdx,
    required this.name,
    required this.zone,
    required this.type,
    required this.defaultBootState,
  });

  final int channelIdx;
  final String name;
  final String zone;
  final SwitchType type;
  final BootState defaultBootState;

  factory SwitchConfig.fromJson(Map<String, dynamic> json) => SwitchConfig(
    channelIdx: json['channel_idx'] as int,
    name: json['name'] as String,
    zone: json['zone'] as String,
    type: SwitchType.fromJson(json['type'] as String),
    defaultBootState: BootState.fromJson(json['default_boot_state'] as String),
  );

  Map<String, dynamic> toJson() => {
    'channel_idx': channelIdx,
    'name': name,
    'zone': zone,
    'type': type.toJson(),
    'default_boot_state': defaultBootState.toJson(),
  };
}
