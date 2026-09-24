'use client';

import {
  Ban,
  CircleCheck,
  Eye,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Shield,
  ShieldOff,
  Trash2,
  Wand2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ConfirmDialog, useAdminAction } from '@/components/admin/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/lib/api';
import { useMe } from '@/lib/queries';
import type { AdminUser } from '@/lib/types';

type DialogKind = 'disable' | 'enable' | 'logout' | 'promote' | 'demote' | 'reset' | 'delete' | null;

function randomPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function ResetPasswordDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUser;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const run = useAdminAction();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const tooShort = password.length < 8;
  const tooLong = password.length > 128;

  const close = (o: boolean) => {
    if (busy) return;
    onOpenChange(o);
    if (!o) setTimeout(() => setPassword(''), 200);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Sets a new password for <strong className="text-foreground">{user.email}</strong> and signs them out of
            every session. Share it with them over a trusted channel; they can change it from their profile.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (tooShort || tooLong) return;
            setBusy(true);
            try {
              await run(() => adminApi.resetPassword(user.id, password), `Password reset for ${user.email}`);
              setBusy(false);
              close(false);
            } catch {
              setBusy(false);
            }
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="admin-new-password">New password</Label>
            <div className="flex gap-2">
              <Input
                id="admin-new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                className="font-mono"
                autoFocus
              />
              <Button type="button" variant="outline" onClick={() => setPassword(randomPassword())}>
                <Wand2 /> Generate
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              8–128 characters. Copy it before saving — it isn&apos;t shown again.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={tooShort || tooLong}>
              Reset password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Every admin action on one user, as a dropdown (`variant="menu"`, table
 * rows) or a row of buttons (`variant="buttons"`, the detail page). Self-
 * destructive actions are hidden for the signed-in admin; the backend
 * refuses them anyway.
 */
export function UserActions({
  user,
  variant = 'menu',
  onDeleted,
}: {
  user: AdminUser;
  variant?: 'menu' | 'buttons';
  onDeleted?: () => void;
}) {
  const { me } = useMe();
  const router = useRouter();
  const run = useAdminAction();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const isSelf = me?.id === user.id;
  const disabled = !!user.disabledAt;
  const open = (k: DialogKind) => () => setDialog(k);
  const setOpen = (k: DialogKind) => (o: boolean) => setDialog(o ? k : null);

  const dialogs = (
    <>
      <ConfirmDialog
        open={dialog === 'disable'}
        onOpenChange={setOpen('disable')}
        title={`Disable ${user.email}?`}
        description={
          <>
            <p>
              They are signed out everywhere and can&apos;t sign in again; their API keys and hook URLs stop
              working. Their households, devices and data are kept, and you can re-enable the account at any time.
            </p>
            <p className="text-xs">
              An access token already issued stays valid for up to 15 minutes on non-admin routes.
            </p>
          </>
        }
        confirmLabel="Disable account"
        onConfirm={() => run(() => adminApi.disableUser(user.id), `${user.email} disabled`)}
      />
      <ConfirmDialog
        open={dialog === 'enable'}
        onOpenChange={setOpen('enable')}
        title={`Re-enable ${user.email}?`}
        description="They can sign in again, and their existing API keys and hook URLs start working again."
        confirmLabel="Enable account"
        destructive={false}
        onConfirm={() => run(() => adminApi.enableUser(user.id), `${user.email} enabled`)}
      />
      <ConfirmDialog
        open={dialog === 'logout'}
        onOpenChange={setOpen('logout')}
        title={`Sign ${user.email} out everywhere?`}
        description="Every app and dashboard session is revoked and live connections are closed. They can sign in again with their password. API keys are not affected."
        confirmLabel="Force sign-out"
        onConfirm={() => run(() => adminApi.logoutUser(user.id), `${user.email} signed out everywhere`)}
      />
      <ConfirmDialog
        open={dialog === 'promote'}
        onOpenChange={setOpen('promote')}
        title={`Make ${user.email} an admin?`}
        description="Admins can manage every user, device and API key, and can promote or demote other admins. Every action is recorded in the audit log."
        confirmLabel="Make admin"
        destructive={false}
        onConfirm={() => run(() => adminApi.setAdmin(user.id, true), `${user.email} is now an admin`)}
      />
      <ConfirmDialog
        open={dialog === 'demote'}
        onOpenChange={setOpen('demote')}
        title={`Remove admin role from ${user.email}?`}
        description="They lose access to the admin console immediately. Their normal account is unaffected."
        confirmLabel="Remove admin"
        onConfirm={() => run(() => adminApi.setAdmin(user.id, false), `${user.email} is no longer an admin`)}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={setOpen('delete')}
        title={`Delete ${user.email}?`}
        typedConfirmation={user.email}
        description={
          <>
            <p>
              <strong className="text-foreground">This permanently deletes the account and cannot be undone.</strong>
            </p>
            <p>
              Households where they are the only member are deleted and their devices unclaimed; in shared
              households another member becomes owner. Their API keys and hook URLs are revoked.
            </p>
          </>
        }
        confirmLabel="Delete account"
        onConfirm={async () => {
          await run(() => adminApi.deleteUser(user.id), `${user.email} deleted`);
          if (onDeleted) onDeleted();
          else router.push('/admin/users');
        }}
      />
      <ResetPasswordDialog user={user} open={dialog === 'reset'} onOpenChange={setOpen('reset')} />
    </>
  );

  if (variant === 'buttons') {
    return (
      <>
        <div className="flex flex-wrap gap-2">
          {!isSelf &&
            (user.isAdmin ? (
              <Button variant="outline" size="sm" onClick={open('demote')}>
                <ShieldOff /> Remove admin
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={open('promote')}>
                <Shield /> Make admin
              </Button>
            ))}
          <Button variant="outline" size="sm" onClick={open('logout')}>
            <LogOut /> Force sign-out
          </Button>
          <Button variant="outline" size="sm" onClick={open('reset')}>
            <KeyRound /> Reset password
          </Button>
          {!isSelf &&
            (disabled ? (
              <Button variant="outline" size="sm" onClick={open('enable')}>
                <CircleCheck /> Enable
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={open('disable')}>
                <Ban /> Disable
              </Button>
            ))}
          {!isSelf && (
            <Button variant="destructive" size="sm" onClick={open('delete')}>
              <Trash2 /> Delete
            </Button>
          )}
        </div>
        {dialogs}
      </>
    );
  }

  return (
    <>
      {/* Non-modal: the menu opens dialogs, and a modal menu closing into a modal
          dialog can leave pointer-events stuck on <body> (Radix). */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${user.email}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="max-w-[220px] truncate">{user.email}</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link href={`/admin/users/${user.id}`}>
              <Eye /> View details
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {!isSelf &&
            (user.isAdmin ? (
              <DropdownMenuItem onSelect={open('demote')}>
                <ShieldOff /> Remove admin
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={open('promote')}>
                <Shield /> Make admin
              </DropdownMenuItem>
            ))}
          <DropdownMenuItem onSelect={open('logout')}>
            <LogOut /> Force sign-out
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={open('reset')}>
            <KeyRound /> Reset password…
          </DropdownMenuItem>
          {!isSelf && (
            <>
              <DropdownMenuSeparator />
              {disabled ? (
                <DropdownMenuItem onSelect={open('enable')}>
                  <CircleCheck /> Enable account
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={open('disable')}>
                  <Ban /> Disable account
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={open('delete')} className="text-destructive focus:text-destructive">
                <Trash2 /> Delete account…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialogs}
    </>
  );
}
