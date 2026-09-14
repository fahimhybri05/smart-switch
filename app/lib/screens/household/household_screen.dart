import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/household.dart';
import '../../providers/service_providers.dart';
import '../../theme/spacing.dart';

/// Lists every household the logged-in user belongs to — their own
/// "owner" household (auto-created at signup) plus any they've accepted an
/// invite into. Owners can rename, invite, and remove members; members get
/// a read-only view of who else can see/control their shared devices. See
/// docs/plan.md's households section.
class HouseholdScreen extends ConsumerWidget {
  const HouseholdScreen({super.key});

  Future<void> _invite(
    BuildContext context,
    WidgetRef ref,
    Household household,
  ) async {
    final controller = TextEditingController();
    final email = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Invite to household'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.emailAddress,
          decoration: const InputDecoration(
            labelText: 'Email',
            hintText: 'They must already have a Smart Switch account',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(controller.text.trim()),
            child: const Text('Invite'),
          ),
        ],
      ),
    );
    if (email == null || email.isEmpty || !context.mounted) return;
    try {
      await ref
          .read(householdsProvider.notifier)
          .invite(household.id, email);
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Invited $email')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  Future<void> _rename(
    BuildContext context,
    WidgetRef ref,
    Household household,
  ) async {
    final controller = TextEditingController(text: household.name);
    final name = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename household'),
        content: TextField(controller: controller, autofocus: true),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(controller.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    await ref.read(householdsProvider.notifier).rename(household.id, name);
  }

  Future<void> _removeMember(
    BuildContext context,
    WidgetRef ref,
    Household household,
    HouseholdMember member,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove member?'),
        content: Text(
          '${member.email} will lose access to every device in "${household.name}".',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ref
          .read(householdsProvider.notifier)
          .removeMember(household.id, member.userId);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final households = ref.watch(householdsProvider);
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Household')),
      body: RefreshIndicator(
        onRefresh: () => ref.read(householdsProvider.notifier).refresh(),
        child: households.isEmpty
            ? ListView(
                children: const [
                  Padding(
                    padding: EdgeInsets.all(Spacing.lg),
                    child: Text('No households yet.'),
                  ),
                ],
              )
            : ListView(
                padding: const EdgeInsets.all(Spacing.md),
                children: [
                  for (final household in households)
                    Card(
                      margin: const EdgeInsets.only(bottom: Spacing.md),
                      child: Padding(
                        padding: const EdgeInsets.all(Spacing.md),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: InkWell(
                                    onTap: household.isOwner
                                        ? () => _rename(context, ref, household)
                                        : null,
                                    child: Text(
                                      household.name,
                                      style: Theme.of(
                                        context,
                                      ).textTheme.titleMedium,
                                    ),
                                  ),
                                ),
                                if (household.isOwner)
                                  IconButton(
                                    icon: const Icon(Icons.person_add_outlined),
                                    tooltip: 'Invite',
                                    onPressed: () =>
                                        _invite(context, ref, household),
                                  ),
                              ],
                            ),
                            Text(
                              household.isOwner ? 'You own this household' : 'Member',
                              style: Theme.of(context).textTheme.bodySmall
                                  ?.copyWith(color: colorScheme.outline),
                            ),
                            const SizedBox(height: Spacing.sm),
                            for (final member in household.members)
                              ListTile(
                                contentPadding: EdgeInsets.zero,
                                leading: CircleAvatar(
                                  backgroundColor: colorScheme.primaryContainer,
                                  child: Text(
                                    member.email.isNotEmpty
                                        ? member.email[0].toUpperCase()
                                        : '?',
                                    style: TextStyle(
                                      color: colorScheme.onPrimaryContainer,
                                    ),
                                  ),
                                ),
                                title: Text(member.email),
                                subtitle: Text(member.role),
                                trailing: household.isOwner
                                    ? IconButton(
                                        icon: const Icon(
                                          Icons.person_remove_outlined,
                                        ),
                                        onPressed: () => _removeMember(
                                          context,
                                          ref,
                                          household,
                                          member,
                                        ),
                                      )
                                    : null,
                              ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
      ),
    );
  }
}
