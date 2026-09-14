enum ChannelPowerState {
  on,
  off;

  String toJson() => this == ChannelPowerState.on ? 'ON' : 'OFF';

  static ChannelPowerState fromJson(String value) =>
      value == 'ON' ? ChannelPowerState.on : ChannelPowerState.off;
}

/// One entry of the GET /api/channels short-poll response (spec §3, §6).
class ChannelState {
  const ChannelState({required this.channelIdx, required this.state});

  final int channelIdx;
  final ChannelPowerState state;

  factory ChannelState.fromJson(Map<String, dynamic> json) => ChannelState(
    channelIdx: json['channel_idx'] as int,
    state: ChannelPowerState.fromJson(json['state'] as String),
  );

  Map<String, dynamic> toJson() => {
    'channel_idx': channelIdx,
    'state': state.toJson(),
  };
}
