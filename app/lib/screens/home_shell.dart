import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import 'groups/groups_screen.dart';
import 'home/home_dashboard_screen.dart';
import 'schedules/schedules_screen.dart';
import 'switches/switches_screen.dart';
import '../theme/motion.dart';
import 'zones/zones_screen.dart';

typedef _NavEntry = ({IconData icon, IconData selectedIcon, String label});

const _navEntries = <_NavEntry>[
  (icon: Icons.home_outlined, selectedIcon: Icons.home, label: 'Home'),
  (
    icon: Icons.home_work_outlined,
    selectedIcon: Icons.home_work,
    label: 'Rooms',
  ),
  (
    icon: Icons.toggle_on_outlined,
    selectedIcon: Icons.toggle_on,
    label: 'Switches',
  ),
  (
    icon: Icons.schedule_outlined,
    selectedIcon: Icons.schedule,
    label: 'Schedules',
  ),
  (
    icon: Icons.group_work_outlined,
    selectedIcon: Icons.group_work,
    label: 'Groups',
  ),
];

/// The M3 "expanded" breakpoint — above this a side [NavigationRail] reads
/// better than a bottom [NavigationBar] (desktop/tablet-landscape browser
/// windows during dev, mainly).
const _wideBreakpoint = 840.0;

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;
  double _tabOpacity = 1;

  void _goToTab(int i) {
    if (i == _index) {
      return;
    }
    setState(() {
      _index = i;
      _tabOpacity = 0;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        setState(() => _tabOpacity = 1);
      }
    });
  }

  Widget _selectedIcon(IconData icon) {
    return Icon(icon).animate().scaleXY(
      begin: 0.7,
      end: 1,
      duration: Motion.fast,
      curve: Curves.easeOutBack,
    );
  }

  @override
  Widget build(BuildContext context) {
    final tabs = [
      HomeDashboardScreen(onNavigateToTab: _goToTab),
      const ZonesScreen(),
      const SwitchesScreen(),
      const SchedulesScreen(),
      const GroupsScreen(),
    ];

    // IndexedStack (and its stable, keyless children) must never be rebuilt
    // from scratch — that's what keeps each tab's autoDispose polling
    // providers (e.g. channelStatesProvider) alive across tab switches. The
    // fade is driven purely by AnimatedOpacity's implicit value change, not
    // by any key change up the tree.
    final body = AnimatedOpacity(
      opacity: _tabOpacity,
      duration: Motion.fast,
      curve: Motion.standard,
      child: IndexedStack(index: _index, children: tabs),
    );

    final isWide = MediaQuery.sizeOf(context).width >= _wideBreakpoint;

    if (isWide) {
      return Scaffold(
        body: Row(
          children: [
            NavigationRail(
              selectedIndex: _index,
              onDestinationSelected: _goToTab,
              labelType: NavigationRailLabelType.all,
              groupAlignment: -0.45,
              destinations: [
                for (final entry in _navEntries)
                  NavigationRailDestination(
                    icon: Icon(entry.icon),
                    selectedIcon: _selectedIcon(entry.selectedIcon),
                    label: Text(entry.label),
                  ),
              ],
            ),
            const VerticalDivider(width: 1),
            Expanded(child: body),
          ],
        ),
      );
    }

    return Scaffold(
      body: body,
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: _goToTab,
        labelBehavior: MediaQuery.sizeOf(context).width < 380
            ? NavigationDestinationLabelBehavior.onlyShowSelected
            : NavigationDestinationLabelBehavior.alwaysShow,
        destinations: [
          for (final entry in _navEntries)
            NavigationDestination(
              icon: Icon(entry.icon),
              selectedIcon: _selectedIcon(entry.selectedIcon),
              label: entry.label,
            ),
        ],
      ),
    );
  }
}
