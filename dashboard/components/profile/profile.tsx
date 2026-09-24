'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Mail, ShieldAlert, Trash2, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Callout, PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { authApi, errorMessage, profileApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { formatDate } from '@/lib/format';
import { useMe } from '@/lib/queries';

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}

/* ------------------------------ Change email ----------------------------- */

const emailSchema = z.object({
  newEmail: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your current password'),
});

function ChangeEmailCard({ currentEmail }: { currentEmail: string | undefined }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof emailSchema>>({
    resolver: zodResolver(emailSchema),
    defaultValues: { newEmail: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ newEmail, password }) => {
    setError(null);
    if (newEmail === currentEmail) {
      setError('That is already your email address.');
      return;
    }
    try {
      await profileApi.changeEmail(newEmail, password);
      toast.success('Email updated');
      form.reset();
      await qc.invalidateQueries({ queryKey: qk.session });
      await qc.invalidateQueries({ queryKey: qk.households });
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-brand-ink" /> Change email
        </CardTitle>
        <CardDescription>You&apos;ll use the new address to sign in on the web and in the app.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="newEmail">New email</Label>
            <Input id="newEmail" type="email" autoComplete="email" {...form.register('newEmail')} />
            <FieldError message={errors.newEmail?.message} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="emailPassword">Current password</Label>
            <Input
              id="emailPassword"
              type="password"
              autoComplete="current-password"
              {...form.register('password')}
            />
            <FieldError message={errors.password?.message} />
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" loading={isSubmitting}>
              Update email
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ----------------------------- Change password --------------------------- */

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(8, 'At least 8 characters').max(128, 'At most 128 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: "Passwords don't match" })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a different password',
  });

function ChangePasswordCard() {
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ currentPassword, newPassword }) => {
    setError(null);
    try {
      await authApi.changePassword(currentPassword, newPassword);
      toast.success('Password changed. Other devices have been signed out.');
      form.reset();
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-brand-ink" /> Change password
        </CardTitle>
        <CardDescription>
          Signs you out everywhere else (phones, other browsers). This browser stays signed in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="currentPassword">Current password</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              {...form.register('currentPassword')}
            />
            <FieldError message={errors.currentPassword?.message} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="newPassword">New password</Label>
              <Input id="newPassword" type="password" autoComplete="new-password" {...form.register('newPassword')} />
              <FieldError message={errors.newPassword?.message} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirmPassword">Confirm new password</Label>
              <Input id="confirmPassword" type="password" autoComplete="new-password" {...form.register('confirm')} />
              <FieldError message={errors.confirm?.message} />
            </div>
          </div>
          <Callout tone="info" icon={KeyRound}>
            API keys and hook URLs keep working after a password change. Revoke them on the API &amp;
            Integrations page if you think they were exposed.
          </Callout>
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" loading={isSubmitting}>
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------ Delete account --------------------------- */

const deleteSchema = z.object({
  password: z.string().min(1, 'Enter your password'),
  confirmText: z.string().refine((v): boolean => v === 'DELETE', { message: 'Type DELETE to confirm' }),
});

function DeleteAccountCard() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useForm<z.infer<typeof deleteSchema>>({
    resolver: zodResolver(deleteSchema),
    defaultValues: { password: '', confirmText: '' },
  });
  const { errors, isSubmitting } = form.formState;
  const typed = form.watch('confirmText');

  const onSubmit = form.handleSubmit(async ({ password }) => {
    setError(null);
    try {
      await authApi.deleteAccount(password);
      qc.clear();
      toast.success('Your account has been deleted.');
      router.replace('/login');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <ShieldAlert className="h-5 w-5" /> Delete account
        </CardTitle>
        <CardDescription>Permanently deletes your account. This cannot be undone.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Households you share with others are handed to the longest-standing member.</li>
          <li>
            Households where you&apos;re the only member are deleted; their devices are unclaimed and their
            schedules disabled.
          </li>
          <li>Your API keys and hook URLs stop working immediately.</li>
        </ul>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            if (isSubmitting) return;
            setOpen(o);
            if (!o) {
              form.reset();
              setError(null);
            }
          }}
        >
          <DialogTrigger asChild>
            <Button variant="destructive" className="w-fit">
              <Trash2 /> Delete my account
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete your account?</DialogTitle>
              <DialogDescription>Enter your password and type DELETE to confirm.</DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="grid gap-4" noValidate>
              <div className="grid gap-2">
                <Label htmlFor="deletePassword">Password</Label>
                <Input
                  id="deletePassword"
                  type="password"
                  autoComplete="current-password"
                  {...form.register('password')}
                />
                <FieldError message={errors.password?.message} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirmText">
                  Type <span className="font-mono font-bold">DELETE</span>
                </Label>
                <Input id="confirmText" autoComplete="off" {...form.register('confirmText')} />
                <FieldError message={errors.confirmText?.message} />
              </div>
              {error && (
                <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button type="submit" variant="destructive" loading={isSubmitting} disabled={typed !== 'DELETE'}>
                  Delete account
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------- Page --------------------------------- */

export function Profile() {
  const { me, isLoading } = useMe();
  return (
    <>
      <PageHeader title="Profile" description="Your account, sign-in details and security." />
      <div className="grid gap-6">
        <Card>
          <CardContent className="flex items-center gap-4 pt-5 sm:pt-6">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-brand-ink">
              <UserRound className="h-7 w-7" />
            </span>
            {isLoading ? (
              <div className="grid gap-2">
                <Skeleton className="h-5 w-56" />
                <Skeleton className="h-4 w-32" />
              </div>
            ) : (
              <div className="min-w-0">
                <div className="truncate text-lg font-bold">{me?.email ?? 'Signed in'}</div>
                <div className="text-sm text-muted-foreground">
                  {me?.createdAt ? `Member since ${formatDate(me.createdAt)}` : 'Smart Control account'}
                  {me?.households.length
                    ? ` · ${me.households.length} household${me.households.length === 1 ? '' : 's'}`
                    : ''}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <ChangeEmailCard currentEmail={me?.email} />
          <ChangePasswordCard />
        </div>
        <DeleteAccountCard />
      </div>
    </>
  );
}
