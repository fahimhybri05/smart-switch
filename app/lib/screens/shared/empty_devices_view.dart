import 'package:flutter/material.dart';

import 'empty_state_view.dart';

/// Shown on Zones/Switches/Schedules/Groups whenever no device has been
/// claimed yet — points at the provisioning wizard (the home shell's FAB).
class EmptyDevicesView extends StatelessWidget {
  const EmptyDevicesView({super.key});

  @override
  Widget build(BuildContext context) {
    return const EmptyStateView(
      icon: Icons.devices_other,
      title: 'No devices yet',
      subtitle: 'Tap "Add device" to add or provision a Smart Switch device.',
    );
  }
}
