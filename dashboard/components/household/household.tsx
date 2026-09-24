'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Crown, DoorOpen, Home, Inbox, Mail, Pencil, Send, UserMinus, Users, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { ConfirmAction, EmptyState, ErrorState, HouseholdSelect, PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage, householdsApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { timeAgo } from '@/lib/format';
import { useHouseholds, useMe, useSelectedHousehold } from '@/lib/queries';
import type { Household } from '@/lib/types';

/* ---------------------------- Incoming invites --------------------------- */

function IncomingInvites() {
  const qc = useQueryClient();
  const invites = useQuery({ queryKey: qk.incomingInvites, queryFn: householdsApi.incomingInvites });
  const respond = useMutation({
    mutationFn: ({ id, accept }: { id: number; accept: boolean }) =>
      accept ? householdsApi.acceptInvite(id) : householdsApi.declineInvite(id),
    onSuccess: async (_, { accept }) => {
      toast.success(accept ? 'You joined the household' : 'Invite declined');
      await qc.invalidateQueries({ queryKey: qk.incomingInvites });
      if (accept) {
        await Promise.all([
          qc.invalidateQueries({ queryKey: qk.households }),
          qc.invalidateQueries({ queryKey: qk.devices }),
          qc.invalidateQueries({ queryKey: qk.session }),
        ]);
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (!invites.data?.length) return null;
  return (
    <Card className="border-primary/40 shadow-glow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Inbox className="h-5 w-5 text-brand-ink" /> Invitations for you
        </CardTitle>
        <CardDescription>Accept to see and control that household&apos;s devices.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-xl border">
          {invites.data.map((inv) => {
            const busy = respond.isPending && respond.variables?.id === inv.id;
            return (
              <li key={inv.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{inv.householdName}</div>
                  <div className="truncate text-xs text-muted-foreground">Invited by {inv.invitedByEmail}</div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => respond.mutate({ id: inv.id, accept: false })}
                  >
                    <X /> Decline
                  </Button>
                  <Button size="sm" loading={busy} onClick={() => respond.mutate({ id: inv.id, accept: true })}>
                    <Check /> Accept
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ------------------------------ Rename form ------------------------------ */

const nameSchema = z.object({ name: z.string().trim().min(1, 'Enter a name').max(64, 'At most 64 characters') });

function RenameHousehold({ household, onDone }: { household: Household; onDone: () => void }) {
  const qc = useQueryClient();
  const form = useForm<z.infer<typeof nameSchema>>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: household.name },
  });
  const onSubmit = form.handleSubmit(async ({ name }) => {
    try {
      await householdsApi.rename(household.id, name);
      await qc.invalidateQueries({ queryKey: qk.households });
      toast.success('Household renamed');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  });
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row" noValidate>
      <Input autoFocus aria-label="Household name" {...form.register('name')} className="sm:max-w-xs" />
      <div className="flex gap-2">
        <Button type="submit" size="default" loading={form.formState.isSubmitting}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------ Invite form ------------------------------ */

const inviteSchema = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address') });

function InviteForm({ householdId }: { householdId: number }) {
  const qc = useQueryClient();
  const form = useForm<z.infer<typeof inviteSchema>>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '' },
  });
  const onSubmit = form.handleSubmit(async ({ email }) => {
    try {
      await householdsApi.invite(householdId, email);
      toast.success(`Invite sent to ${email}`);
      form.reset();
      await qc.invalidateQueries({ queryKey: qk.outgoingInvites(householdId) });
    } catch (err) {
      form.setError('email', { message: errorMessage(err) });
    }
  });
  return (
    <form onSubmit={onSubmit} className="grid gap-2" noValidate>
      <Label htmlFor="inviteEmail">Invite by email</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="inviteEmail"
          type="email"
          placeholder="name@example.com"
          aria-invalid={!!form.formState.errors.email}
          {...form.register('email')}
        />
        <Button type="submit" loading={form.formState.isSubmitting} className="shrink-0">
          <Send /> Send invite
        </Button>
      </div>
      {form.formState.errors.email ? (
        <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
      ) : (
        <p className="text-xs text-muted-foreground">They need a Smart Control account with that email.</p>
      )}
    </form>
  );
}

/* ---------------------------- Outgoing invites --------------------------- */

function OutgoingInvites({ household }: { household: Household }) {
  const qc = useQueryClient();
  const isOwner = household.role === 'owner';
  const invites = useQuery({
    queryKey: qk.outgoingInvites(household.id),
    queryFn: () => householdsApi.outgoingInvites(household.id),
  });

  if (invites.isLoading) return <Skeleton className="h-14 rounded-xl" />;
  if (invites.isError) {
    return <p className="text-sm text-muted-foreground">Pending invites unavailable: {errorMessage(invites.error)}</p>;
  }
  if (!invites.data?.length) return <p className="text-sm text-muted-foreground">No pending invites.</p>;

  return (
    <ul className="divide-y rounded-xl border">
      {invites.data.map((inv) => (
        <li key={inv.id} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{inv.email || 'Unknown user'}</div>
              <div className="text-xs text-muted-foreground">
                Sent {timeAgo(inv.createdAt)}
                {inv.invitedByEmail ? ` by ${inv.invitedByEmail}` : ''}
              </div>
            </div>
          </div>
          {isOwner && (
            <ConfirmAction
              title="Cancel this invite?"
              description={`${inv.email || 'This person'} won't be able to join with this invite anymore.`}
              confirmLabel="Cancel invite"
              onConfirm={async () => {
                await householdsApi.cancelInvite(household.id, inv.id);
                toast.success('Invite cancelled');
                await qc.invalidateQueries({ queryKey: qk.outgoingInvites(household.id) });
              }}
              trigger={
                <Button size="sm" variant="ghost">
                  <X /> Cancel
                </Button>
              }
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------- Page --------------------------------- */

export function HouseholdPage() {
  const qc = useQueryClient();
  const households = useHouseholds();
  const { me } = useMe();
  const { selected, select } = useSelectedHousehold(households.data);
  const [renaming, setRenaming] = useState(false);

  const isOwner = selected?.role === 'owner';
  const owners = selected?.members.filter((m) => m.role === 'owner') ?? [];
  const soleOwner = isOwner && owners.length <= 1;

  const refreshAll = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.households }),
      qc.invalidateQueries({ queryKey: qk.devices }),
      qc.invalidateQueries({ queryKey: qk.session }),
    ]);

  return (
    <>
      <PageHeader
        title="Household"
        description="Who can see and control your devices."
        actions={
          <HouseholdSelect
            households={households.data ?? []}
            value={selected?.id}
            onChange={(id) => {
              setRenaming(false);
              select(id);
            }}
          />
        }
      />

      <div className="grid gap-6">
        <IncomingInvites />

        {households.isLoading ? (
          <Skeleton className="h-64 rounded-xl" />
        ) : households.isError ? (
          <ErrorState error={households.error} onRetry={() => households.refetch()} />
        ) : !selected ? (
          <EmptyState icon={Home} title="You're not in a household">
            Accept an invitation above, or sign up again to get your own household.
          </EmptyState>
        ) : (
          <>
            <Card>
              <CardHeader className="gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/15 text-brand-ink">
                    <Home className="h-5 w-5" />
                  </span>
                  {renaming ? (
                    <div className="min-w-0 flex-1">
                      <RenameHousehold household={selected} onDone={() => setRenaming(false)} />
                    </div>
                  ) : (
                    <div className="min-w-0 flex-1">
                      <CardTitle className="truncate text-xl">{selected.name}</CardTitle>
                      <CardDescription>
                        {selected.members.length} member{selected.members.length === 1 ? '' : 's'} · you are{' '}
                        {isOwner ? 'an owner' : 'a member'}
                        {selected.timezone ? ` · ${selected.timezone}` : ''}
                      </CardDescription>
                    </div>
                  )}
                  {isOwner && !renaming && (
                    <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
                      <Pencil /> Rename
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="grid gap-6">
                <div>
                  <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                    <Users className="h-4 w-4" /> Members
                  </h3>
                  <ul className="divide-y rounded-xl border">
                    {selected.members.map((m) => {
                      const isMe = me?.id === m.userId;
                      return (
                        <li key={m.userId} className="flex items-center justify-between gap-3 px-4 py-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-bold">
                              {m.email.charAt(0).toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">
                                {m.email}
                                {isMe && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {m.role === 'owner' ? (
                              <Badge>
                                <Crown className="h-3 w-3" /> Owner
                              </Badge>
                            ) : (
                              <Badge variant="secondary">Member</Badge>
                            )}
                            {isOwner && !isMe && (
                              <ConfirmAction
                                title={`Remove ${m.email}?`}
                                description="They immediately lose access to this household's devices."
                                confirmLabel="Remove"
                                onConfirm={async () => {
                                  await householdsApi.removeMember(selected.id, m.userId);
                                  toast.success(`${m.email} removed`);
                                  await qc.invalidateQueries({ queryKey: qk.households });
                                }}
                                trigger={
                                  <Button size="icon-sm" variant="ghost" aria-label={`Remove ${m.email}`}>
                                    <UserMinus />
                                  </Button>
                                }
                              />
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {isOwner && <InviteForm householdId={selected.id} />}

                <div>
                  <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                    <Mail className="h-4 w-4" /> Pending invites
                  </h3>
                  <OutgoingInvites household={selected} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DoorOpen className="h-5 w-5 text-muted-foreground" /> Leave household
                </CardTitle>
                <CardDescription>
                  {soleOwner
                    ? "You're the only owner. Make sure another owner exists before leaving, or delete your account from the Profile page."
                    : "You'll lose access to this household's devices until someone invites you again."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ConfirmAction
                  title={`Leave ${selected.name}?`}
                  description="You'll lose access to its devices, schedules and activity."
                  confirmLabel="Leave household"
                  onConfirm={async () => {
                    if (!me?.id) throw new Error('Your profile has not loaded yet — try again in a moment.');
                    await householdsApi.removeMember(selected.id, me.id);
                    toast.success(`You left ${selected.name}`);
                    await refreshAll();
                  }}
                  trigger={
                    <Button variant="outline" disabled={soleOwner || !me}>
                      <DoorOpen /> Leave household
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
