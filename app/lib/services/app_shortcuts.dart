import 'package:flutter/foundation.dart';
import 'package:quick_actions/quick_actions.dart';

import 'widget_service.dart';

/// Long-press-the-app-icon shortcuts: one per pinned switch (first
/// [maxAppShortcuts]). Tapping one opens the app and toggles that switch —
/// see app.dart for the handler.
const maxAppShortcuts = 4;
const _togglePrefix = 'toggle:';

const _quickActions = QuickActions();

bool get _supported =>
    !kIsWeb &&
    (defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS);

/// Same name-keyword mapping as the Android widget's WidgetRender.iconFor,
/// so shortcuts show the drawables the widgets already ship.
String _iconFor(String name) {
  final n = name.toLowerCase();
  if (n.contains('led') || n.contains('strip')) return 'ic_widget_strip';
  if (n.contains('fish') || n.contains('tank') || n.contains('aquarium')) {
    return 'ic_widget_aquarium';
  }
  if (n.contains('pump') || n.contains('water')) return 'ic_widget_pump';
  if (n.contains('motor')) return 'ic_widget_motor';
  if (n.contains('fan')) return 'ic_widget_fan';
  if (n.contains('tv') || n.contains('television')) return 'ic_widget_tv';
  if (n.contains('router') || n.contains('wifi')) return 'ic_widget_router';
  if (n.contains('plug')) return 'ic_widget_plug';
  if (n.contains('socket') || n.contains('outlet')) return 'ic_widget_socket';
  if (n.contains('light') || n.contains('lamp') || n.contains('bulb')) {
    return 'ic_widget_light';
  }
  return 'ic_widget_power';
}

/// Parsed shortcut type → (deviceId, channelIdx), or null for anything else.
({String deviceId, int channelIdx})? parseShortcut(String type) {
  if (!type.startsWith(_togglePrefix)) return null;
  final rest = type.substring(_togglePrefix.length);
  final split = rest.lastIndexOf(':');
  if (split <= 0) return null;
  final channel = int.tryParse(rest.substring(split + 1));
  if (channel == null) return null;
  return (deviceId: rest.substring(0, split), channelIdx: channel);
}

/// Registers [onToggle] for shortcut taps (including the one that cold-
/// started the app) and publishes the current pinned switches.
Future<void> initAppShortcuts(
  void Function(String deviceId, int channelIdx) onToggle,
) async {
  if (!_supported) return;
  try {
    await _quickActions.initialize((type) {
      final target = parseShortcut(type);
      if (target != null) onToggle(target.deviceId, target.channelIdx);
    });
    await refreshAppShortcuts();
  } catch (e) {
    debugPrint('app shortcuts unavailable: $e');
  }
}

/// Re-publishes shortcuts from the pinned switches — call after they change.
Future<void> refreshAppShortcuts() async {
  if (!_supported) return;
  try {
    final pinned = await getPinnedSwitches();
    await _quickActions.setShortcutItems([
      for (final p in pinned.take(maxAppShortcuts))
        ShortcutItem(
          type: '$_togglePrefix${p.deviceId}:${p.channelIdx}',
          localizedTitle: p.switchName,
          localizedSubtitle: 'Turn on or off',
          icon: defaultTargetPlatform == TargetPlatform.android
              ? _iconFor(p.switchName)
              : null,
        ),
    ]);
  } catch (e) {
    debugPrint('app shortcuts refresh failed: $e');
  }
}
