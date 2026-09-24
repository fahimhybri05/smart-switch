import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import 'groups/groups_screen.dart';
import 'home/home_dashboard_screen.dart';
import 'schedules/schedules_screen.dart';
import 'settings/settings_screen.dart';
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
  (
    icon: Icons.settings_outlined,
    selectedIcon: Icons.settings,
    label: 'Settings',
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

class _HomeShellState extends State<HomeShell>
    with SingleTickerProviderStateMixin {
  int _index = 0;

  // Drives the tab-change "fade through": the incoming tab fades in while
  // rising a few pixels and settling from a hair under full size.
  late final AnimationController _tabController = AnimationController(
    vsync: this,
    duration: Motion.medium,
    value: 1,
  );
  late final Animation<double> _tabCurve = CurvedAnimation(
    parent: _tabController,
    curve: Motion.enter,
  );
  late final Animation<Offset> _tabSlide = Tween(
    begin: const Offset(0, 0.015),
    end: Offset.zero,
  ).animate(_tabCurve);
  late final Animation<double> _tabScale = Tween(
    begin: 0.985,
    end: 1.0,
  ).animate(_tabCurve);

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  void _goToTab(int i) {
    if (i == _index) {
      return;
    }
    setState(() => _index = i);
    _tabController.forward(from: 0);
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
      const SettingsScreen(),
    ];

    // IndexedStack (and its stable, keyless children) must never be rebuilt
    // from scratch — that's what keeps each tab's autoDispose polling
    // providers (e.g. channelStatesProvider) alive across tab switches. The
    // transition is driven purely by the controller wrapping it, not by any
    // key change up the tree.
    final body = FadeTransition(
      opacity: _tabCurve,
      child: SlideTransition(
        position: _tabSlide,
        child: ScaleTransition(
          scale: _tabScale,
          child: IndexedStack(index: _index, children: tabs),
        ),
      ),
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
        labelBehavior: MediaQuery.sizeOf(context).width < 440
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
