'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Callout, ConfirmAction, CopyField, EmptyState, ErrorState } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage, integrationsApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { formatDate, timeAgo } from '@/lib/format';
import type { CreatedApiKey } from '@/lib/types';

export const MAX_KEYS = 25;

export function useApiKeys() {
  return useQuery({ queryKey: qk.apiKeys, queryFn: integrationsApi.keys });
}

/** "I've stored it" acknowledgement shared by the key and hook reveal dialogs. */
export function Acknowledge({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <span>{children}</span>
    </label>
  );
}

const nameSchema = z.object({ name: z.string().trim().min(1, 'Give the key a name').max(64, 'At most 64 characters') });

function CreateKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [ack, setAck] = useState(false);
  const form = useForm<z.infer<typeof nameSchema>>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: '' },
  });

  const mutation = useMutation({
    mutationFn: (name: string) => integrationsApi.createKey(name),
    onSuccess: (key) => {
      setCreated(key);
      void qc.invalidateQueries({ queryKey: qk.apiKeys });
    },
    onError: (err) => form.setError('name', { message: errorMessage(err) }),
  });

  const close = () => {
    onOpenChange(false);
    // Drop the secret from memory as soon as the dialog closes.
    setTimeout(() => {
      setCreated(null);
      setAck(false);
      form.reset();
    }, 200);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) onOpenChange(true);
        else if (!created || ack) close();
      }}
    >
      <DialogContent
        hideClose={!!created && !ack}
        onInteractOutside={(e) => created && e.preventDefault()}
        onEscapeKeyDown={(e) => created && !ack && e.preventDefault()}
      >
        {!created ? (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                Keys act as you: they can read and control every switch in your households.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={form.handleSubmit((v) => mutation.mutate(v.name))}
              className="grid gap-4"
              noValidate
            >
              <div className="grid gap-2">
                <Label htmlFor="keyName">Name</Label>
                <Input id="keyName" placeholder="e.g. Home Assistant" autoFocus {...form.register('name')} />
                {form.formState.errors.name && (
                  <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" loading={mutation.isPending}>
                  Create key
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Copy your new key</DialogTitle>
              <DialogDescription>
                “{created.name}” — this is the only time the full key is shown. Store it in a password
                manager or your integration&apos;s secret store.
              </DialogDescription>
            </DialogHeader>
            <CopyField value={created.secret} label="Copy API key" />
            <Callout tone="warning" icon={ShieldAlert}>
              Anyone with this key can control your switches. Never commit it to code or paste it in chats.
            </Callout>
            <Acknowledge checked={ack} onChange={setAck}>
              I&apos;ve copied and safely stored this key.
            </Acknowledge>
            <DialogFooter>
              <Button onClick={close} disabled={!ack}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ApiKeysPanel() {
  const qc = useQueryClient();
  const keys = useApiKeys();
  const [open, setOpen] = useState(false);
  const atCap = (keys.data?.length ?? 0) >= MAX_KEYS;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-brand-ink" /> API keys
          </CardTitle>
          <CardDescription>
            Use a key as <code className="font-mono text-xs">Authorization: Bearer sk_…</code> against the REST
            API. Up to {MAX_KEYS} keys.
          </CardDescription>
        </div>
        <Button onClick={() => setOpen(true)} disabled={atCap}>
          <Plus /> New key
        </Button>
      </CardHeader>
      <CardContent>
        {keys.isLoading ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
        ) : !keys.data?.length ? (
          <EmptyState icon={KeyRound} title="No API keys yet">
            Create a key to control your switches from Home Assistant, scripts or another dashboard.
          </EmptyState>
        ) : (
          <ul className="divide-y rounded-xl border">
            {keys.data.map((k) => (
              <li key={k.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{k.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{k.prefix}…</code>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Created {formatDate(k.createdAt)} · last used {timeAgo(k.lastUsedAt)} · {k.hookCount} hook
                    URL{k.hookCount === 1 ? '' : 's'}
                  </div>
                </div>
                <ConfirmAction
                  title={`Revoke “${k.name}”?`}
                  description={
                    <>
                      Anything using this key stops working immediately.
                      {k.hookCount > 0 && (
                        <>
                          {' '}
                          <strong className="text-foreground">
                            {k.hookCount} hook URL{k.hookCount === 1 ? '' : 's'} tied to it will stop working too.
                          </strong>
                        </>
                      )}
                    </>
                  }
                  confirmLabel="Revoke key"
                  onConfirm={async () => {
                    await integrationsApi.revokeKey(k.id);
                    toast.success('Key revoked');
                    await Promise.all([
                      qc.invalidateQueries({ queryKey: qk.apiKeys }),
                      qc.invalidateQueries({ queryKey: qk.hooks }),
                    ]);
                  }}
                  trigger={
                    <Button variant="outline" size="sm" className="w-fit">
                      <Trash2 /> Revoke
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CreateKeyDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}
