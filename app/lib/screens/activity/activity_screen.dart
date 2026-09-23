import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/activity_entry.dart';
import '../../models/local/household.dart';
import '../../providers/service_providers.dart';
import '../../services/backend/backend_activity_client.dart';
import '../../theme/app_theme.dart';
import '../../theme/spacing.dart';
import '../shared/error_view.dart';

/// A simple paginated feed of every confirmed switch on/off event for a
/// household (spec: "activity history requires persistent event storage").
/// Pure online feature, no Hive cache — a history feed logged out or
/// offline is meaningless, so this screen shows that honestly rather than
/// faking cached data. See docs/plan.md.
class ActivityScreen extends ConsumerStatefulWidget {
  const ActivityScreen({super.key});

  @override
  ConsumerState<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends ConsumerState<ActivityScreen> {
  final List<ActivityEntry> _entries = [];
  int? _cursor;
  bool _loading = false;
  bool _hasMore = true;
  String? _error;
  Household? _household;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_household == null) {
      final households = ref.read(householdsProvider);
      if (households.isNotEmpty) {
        _household = households.first;
        _loadMore();
      }
    }
  }

  Future<void> _loadMore() async {
    final household = _household;
    if (household == null || _loading || !_hasMore) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final backendUrl = ref.read(backendUrlProvider);
      if (backendUrl == null) {
        throw StateError('Set a backend server in Settings first.');
      }
      final accessToken = await ensureFreshAccessToken(ref);
      final page = await BackendActivityClient(
        baseUrl: backendUrl,
        accessToken: accessToken,
      ).list(householdId: household.id, cursor: _cursor);
      setState(() {
        _entries.addAll(page.entries);
        _cursor = page.nextCursor;
        _hasMore = page.nextCursor != null;
      });
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      setState(() => _loading = false);
    }
  }

  Future<void> _refresh() async {
    setState(() {
      _entries.clear();
      _cursor = null;
      _hasMore = true;
    });
    await _loadMore();
  }

  IconData _sourceIcon(String source) => switch (source) {
    'automation' => Icons.bolt_outlined,
    'widget' => Icons.widgets_outlined,
    'group' => Icons.workspaces_outlined,
    'scene' => Icons.auto_awesome_outlined,
    'device' => Icons.schedule_outlined,
    'voice' => Icons.mic_none_outlined,
    _ => Icons.touch_app_outlined,
  };

  String _sourceLabel(ActivityEntry entry) => switch (entry.source) {
    'automation' => 'Automation',
    'widget' => 'Home screen widget',
    'group' => 'Group',
    'scene' => 'Scene',
    'device' => 'Device schedule',
    'voice' => 'Google Assistant',
    _ => entry.actorEmail ?? 'App',
  };

  @override
  Widget build(BuildContext context) {
    final households = ref.watch(householdsProvider);
    if ((ref.watch(authProvider)) == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Activity')),
        body: const Center(child: Text('Log in to see activity history.')),
      );
    }
    if (households.isEmpty) {
      return Scaffold(
        appBar: AppBar(title: const Text('Activity')),
        body: const Center(child: Text('No households yet.')),
      );
    }
    _household ??= households.first;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Activity'),
        actions: households.length > 1
            ? [
                DropdownButton<Household>(
                  value: _household,
                  underline: const SizedBox.shrink(),
                  onChanged: (h) {
                    setState(() => _household = h);
                    _refresh();
                  },
                  items: [
                    for (final h in households)
                      DropdownMenuItem(value: h, child: Text(h.name)),
                  ],
                ),
                const SizedBox(width: Spacing.md),
              ]
            : null,
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: _entries.isEmpty && _loading
            ? const Center(child: CircularProgressIndicator())
            : _entries.isEmpty && _error != null
            ? ErrorView(
                message: 'Could not load activity history: $_error',
                onRetry: _refresh,
              )
            : _entries.isEmpty
            ? const Center(child: Text('No activity yet.'))
            : NotificationListener<ScrollNotification>(
                onNotification: (notification) {
                  if (notification.metrics.pixels >
                      notification.metrics.maxScrollExtent - 200) {
                    _loadMore();
                  }
                  return false;
                },
                child: ListView.separated(
                  padding: const EdgeInsets.all(Spacing.md),
                  itemCount: _entries.length + (_hasMore ? 1 : 0),
                  separatorBuilder: (_, _) =>
                      const SizedBox(height: Spacing.xs),
                  itemBuilder: (context, index) {
                    if (index >= _entries.length) {
                      return const Padding(
                        padding: EdgeInsets.all(Spacing.md),
                        child: Center(child: CircularProgressIndicator()),
                      );
                    }
                    final entry = _entries[index];
                    final isOn = entry.state.toLowerCase() == 'on';
                    final colorScheme = Theme.of(context).colorScheme;
                    final live = context.panelColors.live;
                    final accent = isOn ? live : colorScheme.onSurfaceVariant;
                    return Card(
                      child: ListTile(
                        leading: Container(
                          width: 36,
                          height: 36,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: isOn
                                ? live.withValues(alpha: 0.14)
                                : colorScheme.surfaceContainerHigh,
                            shape: BoxShape.circle,
                          ),
                          child: Icon(
                            _sourceIcon(entry.source),
                            size: 17,
                            color: accent,
                          ),
                        ),
                        title: RichText(
                          text: TextSpan(
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(color: colorScheme.onSurface),
                            children: [
                              TextSpan(
                                text:
                                    '${entry.deviceFriendlyName} · ch${entry.channelIdx} turned ',
                              ),
                              TextSpan(
                                text: entry.state.toUpperCase(),
                                style: TextStyle(
                                  color: accent,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                            ],
                          ),
                        ),
                        subtitle: Text(
                          '${_sourceLabel(entry)} · ${entry.createdAt.toLocal()}',
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(color: colorScheme.onSurfaceVariant),
                        ),
                      ),
                    );
                  },
                ),
              ),
      ),
    );
  }
}
