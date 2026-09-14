/// A single switch reference within a [SwitchGroup] — identifies a channel
/// on a specific device.
class GroupMember {
  const GroupMember({required this.deviceId, required this.channelIdx});

  final String deviceId;
  final int channelIdx;

  factory GroupMember.fromJson(Map<String, dynamic> json) => GroupMember(
    deviceId: json['device_id'] as String,
    channelIdx: json['channel_idx'] as int,
  );

  Map<String, dynamic> toJson() => {
    'device_id': deviceId,
    'channel_idx': channelIdx,
  };
}

/// A multi-switch (possibly cross-device) group (spec §7). Account-wide,
/// synced via the backend (`GroupsNotifier`/`BackendGroupsClient`) — every
/// phone logged into the same account sees the same groups. This model is
/// also the shape cached locally in Hive for offline viewing.
class SwitchGroup {
  const SwitchGroup({
    required this.id,
    required this.name,
    required this.members,
  });

  final String id;
  final String name;
  final List<GroupMember> members;

  factory SwitchGroup.fromJson(Map<String, dynamic> json) => SwitchGroup(
    id: json['id'] as String,
    name: json['name'] as String,
    members: (json['members'] as List<dynamic>)
        .map((e) => GroupMember.fromJson(e as Map<String, dynamic>))
        .toList(),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'members': members.map((m) => m.toJson()).toList(),
  };
}
