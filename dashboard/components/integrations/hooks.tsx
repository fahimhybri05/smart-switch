'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Callout, CodeBlock, ConfirmAction, CopyField, EmptyState, ErrorState } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage, integrationsApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { formatDate, timeAgo } from '@/lib/format';
import { useDevices, useSwitchViews } from '@/lib/queries';
import type { CreatedHook, SwitchView } from '@/lib/types';

import { Acknowledge, useApiKeys } from './api-keys';

export const MAX_HOOKS_PER_KEY = 50;

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'switch'
  );
}

function withTextFormat(url: string) {
  try {
    const u = new URL(url);
    u.searchParams.set('format', 'text');
    return u.toString();
  } catch {
    return `${url}?format=text`;
  }
}

export function PrefetchWarning() {
  return (
    <Callout tone="warning" icon={ShieldAlert}>
      <p className="font-semibold">Treat hook URLs like passwords.</p>
      <p className="text-muted-foreground">
        Anyone with a link can use it — no key needed. Chat apps, email scanners and link-preview bots
        open links automatically, and a plain GET on an <code className="font-mono">on</code>/
        <code className="font-mono">off</code>/<code className="font-mono">toggle</code> URL actuates the
        switch. Don&apos;t paste action URLs into chats or documents; prefer POST from automations. If a
        URL leaks, revoke the hook and create a new one.
      </p>
    </Callout>
  );
}

function HookExamples({ created, switchName }: { created: CreatedHook; switchName: string }) {
  const s = slug(switchName);
  const ha = `# configuration.yaml
rest_command:
  ${s}_on:
    url: "${created.urls.on}"
    method: post
  ${s}_off:
    url: "${created.urls.off}"
    method: post
  ${s}_toggle:
    url: "${created.urls.toggle}"
    method: post

sensor:
  - platform: rest
    name: "${switchName} state"
    resource: "${withTextFormat(created.urls.status)}"
    scan_interval: 30`;

  const ifttt = `Service: Webhooks → "Make a web request"
URL:          ${created.urls.toggle}
Method:       POST
Content Type: text/plain
Body:         (leave empty)`;

  const curl = `curl -X POST "${created.urls.on}"
curl "${withTextFormat(created.urls.status)}"   # → on | off | unknown`;

  return (
    <div className="grid gap-3">
      <div>
        <h4 className="mb-1.5 text-sm font-semibold">Home Assistant</h4>
        <CodeBlock code={ha} />
      </div>
      <div>
        <h4 className="mb-1.5 text-sm font-semibold">IFTTT</h4>
        <CodeBlock code={ifttt} />
      </div>
      <div>
        <h4 className="mb-1.5 text-sm font-semibold">curl</h4>
        <CodeBlock code={curl} />
      </div>
    </div>
  );
}

function CreateHookDialog({
  open,
  onOpenChange,
  switches,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  switches: SwitchView[];
}) {
  const qc = useQueryClient();
  const keys = useApiKeys();
  const [apiKeyId, setApiKeyId] = useState<string>('');
  const [switchIdValue, setSwitchIdValue] = useState<string>('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedHook | null>(null);
  const [ack, setAck] = useState(false);

  const byDevice = useMemo(() => {
    const map = new Map<string, { deviceName: string; items: SwitchView[] }>();
    for (const s of switches) {
      const entry = map.get(s.deviceId) ?? { deviceName: s.deviceName, items: [] };
      entry.items.push(s);
      map.set(s.deviceId, entry);
    }
    return [...map.values()];
  }, [switches]);

  const selectedSwitch = switches.find((s) => s.id === switchIdValue);

  const mutation = useMutation({
    mutationFn: () =>
      integrationsApi.createHook(Number(apiKeyId), switchIdValue, name.trim() || undefined),
    onSuccess: (hook) => {
      setCreated(hook);
      void qc.invalidateQueries({ queryKey: qk.hooks });
      void qc.invalidateQueries({ queryKey: qk.apiKeys });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const close = () => {
    onOpenChange(false);
    setTimeout(() => {
      setCreated(null);
      setAck(false);
      setName('');
      setSwitchIdValue('');
      setError(null);
    }, 200);
  };

  // Preselect the key when there's only one.
  useEffect(() => {
    if (!apiKeyId && keys.data?.length === 1) setApiKeyId(String(keys.data[0].id));
  }, [apiKeyId, keys.data]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) onOpenChange(true);
        else if (!created || ack) close();
      }}
    >
      <DialogContent
        className="max-w-2xl"
        hideClose={!!created && !ack}
        onInteractOutside={(e) => created && e.preventDefault()}
        onEscapeKeyDown={(e) => created && !ack && e.preventDefault()}
      >
        {!created ? (
          <>
            <DialogHeader>
              <DialogTitle>Create hook URLs</DialogTitle>
              <DialogDescription>
                Secret links that turn one switch on, off, toggle it or read its state — no headers needed.
                Revoking the API key they belong to disables them too.
              </DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                if (!apiKeyId) return setError('Choose an API key.');
                if (!switchIdValue) return setError('Choose a switch.');
                mutation.mutate();
              }}
            >
              <div className="grid gap-2">
                <Label>API key</Label>
                <Select value={apiKeyId} onValueChange={setApiKeyId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a key" />
                  </SelectTrigger>
                  <SelectContent>
                    {(keys.data ?? []).map((k) => (
                      <SelectItem key={k.id} value={String(k.id)}>
                        {k.name} ({k.prefix}…)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Switch</Label>
                <Select value={switchIdValue} onValueChange={setSwitchIdValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a switch" />
                  </SelectTrigger>
                  <SelectContent>
                    {byDevice.map((g) => (
                      <SelectGroup key={g.deviceName + g.items[0]?.deviceId}>
                        <SelectLabel>{g.deviceName}</SelectLabel>
                        {g.items.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                            {s.zone ? ` · ${s.zone}` : ''}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="hookName">Label (optional)</Label>
                <Input
                  id="hookName"
                  value={name}
                  maxLength={64}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Porch light for IFTTT"
                />
              </div>
              {error && (
                <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" loading={mutation.isPending}>
                  Create URLs
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Copy your hook URLs</DialogTitle>
              <DialogDescription>
                {selectedSwitch ? `${selectedSwitch.deviceName} · ${selectedSwitch.name}` : created.switchId} —
                shown only once. To get new URLs later, revoke this hook and create another.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              {(['on', 'off', 'toggle', 'status'] as const).map((action) => (
                <div key={action} className="grid gap-1.5">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">{action}</Label>
                  <CopyField value={created.urls[action]} label={`Copy ${action} URL`} />
                </div>
              ))}
            </div>
            <PrefetchWarning />
            <HookExamples created={created} switchName={selectedSwitch?.name ?? 'Switch'} />
            <Acknowledge checked={ack} onChange={setAck}>
              I&apos;ve copied these URLs and stored them somewhere safe.
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

export function HooksPanel() {
  const qc = useQueryClient();
  const keys = useApiKeys();
  const hooks = useQuery({ queryKey: qk.hooks, queryFn: integrationsApi.hooks });
  const devices = useDevices();
  const { byDevice } = useSwitchViews(devices.data);
  const switches = useMemo(() => [...byDevice.values()].flat(), [byDevice]);
  const switchById = useMemo(() => new Map(switches.map((s) => [s.id, s])), [switches]);
  const [open, setOpen] = useState(false);

  const noKeys = keys.isSuccess && keys.data.length === 0;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-brand-ink" /> Hook URLs
          </CardTitle>
          <CardDescription>
            Per-switch secret links for tools that can only call a URL (IFTTT, Shortcuts, bookmarks). Up to{' '}
            {MAX_HOOKS_PER_KEY} per key.
          </CardDescription>
        </div>
        <Button onClick={() => setOpen(true)} disabled={noKeys || switches.length === 0}>
          <Plus /> New hook
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        {noKeys ? (
          <EmptyState icon={Link2} title="Create an API key first">
            Hook URLs belong to an API key, so revoking the key disables all of its hooks at once.
          </EmptyState>
        ) : hooks.isLoading ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : hooks.isError ? (
          <ErrorState error={hooks.error} onRetry={() => hooks.refetch()} />
        ) : !hooks.data?.length ? (
          <EmptyState icon={Link2} title="No hook URLs yet">
            Create one to control a single switch with a plain link.
          </EmptyState>
        ) : (
          <ul className="divide-y rounded-xl border">
            {hooks.data.map((h) => {
              const sw = switchById.get(h.switchId);
              const switchLabel = sw ? `${sw.deviceName} · ${sw.name}` : h.switchId;
              return (
                <li key={h.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-semibold">{h.name || switchLabel}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{h.tokenPrefix}…</code>
                      {h.apiKeyName && <Badge variant="secondary">{h.apiKeyName}</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {h.name ? `${switchLabel} · ` : ''}created {formatDate(h.createdAt)} · last used{' '}
                      {timeAgo(h.lastUsedAt)}
                    </div>
                  </div>
                  <ConfirmAction
                    title="Revoke this hook?"
                    description="All four URLs (on, off, toggle, status) stop working immediately."
                    confirmLabel="Revoke hook"
                    onConfirm={async () => {
                      await integrationsApi.revokeHook(h.id);
                      toast.success('Hook revoked');
                      await Promise.all([
                        qc.invalidateQueries({ queryKey: qk.hooks }),
                        qc.invalidateQueries({ queryKey: qk.apiKeys }),
                      ]);
                    }}
                    trigger={
                      <Button variant="outline" size="sm" className="w-fit">
                        <Trash2 /> Revoke
                      </Button>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
        <PrefetchWarning />
      </CardContent>
      <CreateHookDialog open={open} onOpenChange={setOpen} switches={switches} />
    </Card>
  );
}
