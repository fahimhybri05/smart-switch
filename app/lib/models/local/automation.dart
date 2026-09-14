import 'package:flutter/material.dart' show TimeOfDay;

import '../device/channel_state.dart';

/// What starts an [Automation] — either a schedule (spanning the whole
/// household, unlike a per-device schedule) or another device's channel
/// changing state. See backend/src/routes/automations.js.
sealed class AutomationTrigger {
  const AutomationTrigger();

  Map<String, dynamic> toJson();

  factory AutomationTrigger.fromJson(Map<String, dynamic> json) =>
      switch (json['type'] as String) {
        'schedule' => ScheduleTrigger(
          days: (json['days'] as List<dynamic>).cast<int>(),
          time: _parseTime(json['time'] as String),
        ),
        'state' => StateTrigger(
          deviceId: json['deviceId'] as String,
          channelIdx: json['channelIdx'] as int,
          state: ChannelPowerState.fromJson(json['state'] as String),
        ),
        final type => throw FormatException('unknown trigger type: $type'),
      };
}

TimeOfDay _parseTime(String hhmm) {
  final parts = hhmm.split(':');
  return TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1]));
}

String _formatTime(TimeOfDay time) =>
    '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';

/// Fires at [time] (household-local) on every day in [days] (1=Mon..7=Sun —
/// same convention as this app's existing per-device schedules).
class ScheduleTrigger extends AutomationTrigger {
  const ScheduleTrigger({required this.days, required this.time});

  final List<int> days;
  final TimeOfDay time;

  @override
  Map<String, dynamic> toJson() => {
    'type': 'schedule',
    'days': days,
    'time': _formatTime(time),
  };
}

/// Fires whenever [deviceId]'s [channelIdx] changes to [state].
class StateTrigger extends AutomationTrigger {
  const StateTrigger({
    required this.deviceId,
    required this.channelIdx,
    required this.state,
  });

  final String deviceId;
  final int channelIdx;
  final ChannelPowerState state;

  @override
  Map<String, dynamic> toJson() => {
    'type': 'state',
    'deviceId': deviceId,
    'channelIdx': channelIdx,
    'state': state.toJson(),
  };
}

/// One action an [Automation] performs — embedded directly (not a Scene
/// reference; Scenes are still Hive-only/unsynced, see docs/plan.md).
class AutomationAction {
  const AutomationAction({
    required this.deviceId,
    required this.channelIdx,
    required this.state,
  });

  final String deviceId;
  final int channelIdx;
  final ChannelPowerState state;

  factory AutomationAction.fromJson(Map<String, dynamic> json) =>
      AutomationAction(
        deviceId: json['deviceId'] as String,
        channelIdx: json['channelIdx'] as int,
        state: ChannelPowerState.fromJson(json['state'] as String),
      );

  Map<String, dynamic> toJson() => {
    'deviceId': deviceId,
    'channelIdx': channelIdx,
    'state': state.toJson(),
  };
}

/// A household-wide automation rule (spec: "advanced automations require
/// event and condition APIs") — runs server-side, evaluated by the backend
/// regardless of whether any phone is open. Only a household owner may
/// create/edit/delete one (spec decision, see docs/plan.md); any member
/// can view the list.
class Automation {
  const Automation({
    required this.id,
    required this.householdId,
    required this.name,
    required this.enabled,
    required this.trigger,
    required this.actions,
    required this.lastFiredAt,
  });

  final int id;
  final int householdId;
  final String name;
  final bool enabled;
  final AutomationTrigger trigger;
  final List<AutomationAction> actions;
  final DateTime? lastFiredAt;

  factory Automation.fromJson(Map<String, dynamic> json) => Automation(
    id: (json['id'] as num).toInt(),
    householdId: (json['householdId'] as num).toInt(),
    name: json['name'] as String,
    enabled: json['enabled'] as bool,
    trigger: AutomationTrigger.fromJson(json['trigger'] as Map<String, dynamic>),
    actions: (json['actions'] as List<dynamic>)
        .map((e) => AutomationAction.fromJson(e as Map<String, dynamic>))
        .toList(),
    lastFiredAt: json['lastFiredAt'] == null
        ? null
        : DateTime.parse(json['lastFiredAt'] as String),
  );
}
