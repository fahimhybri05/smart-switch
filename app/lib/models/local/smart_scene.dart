class SmartScene {
  const SmartScene({
    required this.id,
    required this.name,
    required this.icon,
    required this.members,
  });

  final String id;
  final String name;
  final String icon;
  final List<SceneMember> members;

  factory SmartScene.fromJson(Map<String, dynamic> json) => SmartScene(
    id: json['id'] as String,
    name: json['name'] as String,
    icon: json['icon'] as String? ?? 'auto_awesome',
    members: (json['members'] as List<dynamic>)
        .map((item) => SceneMember.fromJson(item as Map<String, dynamic>))
        .toList(),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'icon': icon,
    'members': members.map((member) => member.toJson()).toList(),
  };
}

class SceneMember {
  const SceneMember({
    required this.deviceId,
    required this.channelIdx,
    required this.state,
  });

  final String deviceId;
  final int channelIdx;
  final String state;

  factory SceneMember.fromJson(Map<String, dynamic> json) => SceneMember(
    deviceId: json['device_id'] as String,
    channelIdx: json['channel_idx'] as int,
    state: json['state'] as String,
  );

  Map<String, dynamic> toJson() => {
    'device_id': deviceId,
    'channel_idx': channelIdx,
    'state': state,
  };
}
