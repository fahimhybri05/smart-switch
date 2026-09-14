/// A single member row within a [Household] — see
/// backend/src/routes/households.js's `GET /households`.
class HouseholdMember {
  const HouseholdMember({
    required this.userId,
    required this.email,
    required this.role,
  });

  final int userId;
  final String email;

  /// `'owner'` or `'member'` — see docs/plan.md's households section.
  final String role;

  factory HouseholdMember.fromJson(Map<String, dynamic> json) =>
      HouseholdMember(
        userId: json['userId'] as int,
        email: json['email'] as String,
        role: json['role'] as String,
      );
}

/// A household the logged-in user belongs to, either as its `owner` (their
/// personal home, auto-created at signup) or as an invited `member`. Devices
/// and groups are shared by every member. Backend-only — no offline Hive
/// cache (see [HouseholdsNotifier]'s doc comment for why).
class Household {
  const Household({
    required this.id,
    required this.name,
    required this.timezone,
    required this.role,
    required this.members,
  });

  final int id;
  final String name;
  final String timezone;
  final String role;
  final List<HouseholdMember> members;

  bool get isOwner => role == 'owner';

  factory Household.fromJson(Map<String, dynamic> json) => Household(
    id: (json['id'] as num).toInt(),
    name: json['name'] as String,
    timezone: json['timezone'] as String,
    role: json['role'] as String,
    members: (json['members'] as List<dynamic>)
        .map((e) => HouseholdMember.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

/// A pending invite the logged-in user has received (not yet accepted or
/// declined) — see `GET /households/invites`.
class HouseholdInvite {
  const HouseholdInvite({
    required this.id,
    required this.householdId,
    required this.householdName,
    required this.invitedByEmail,
  });

  final int id;
  final int householdId;
  final String householdName;
  final String invitedByEmail;

  factory HouseholdInvite.fromJson(Map<String, dynamic> json) =>
      HouseholdInvite(
        id: (json['id'] as num).toInt(),
        householdId: (json['householdId'] as num).toInt(),
        householdName: json['householdName'] as String,
        invitedByEmail: json['invitedByEmail'] as String,
      );
}
