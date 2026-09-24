'use client';

import { AlertTriangle, Check, Copy, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants, type ButtonProps } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/api';
import type { Household } from '@/lib/types';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'squircle flex flex-col items-center gap-3 border border-dashed px-6 py-12 text-center',
        className,
      )}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-brand-ink">
        <Icon className="h-6 w-6" />
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="squircle flex flex-col items-center gap-3 border border-destructive/30 bg-destructive/5 px-6 py-10 text-center">
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="text-sm">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Callout({
  tone = 'info',
  icon: Icon,
  children,
  className,
}: {
  tone?: 'info' | 'warning' | 'danger';
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  const I = Icon ?? AlertTriangle;
  return (
    <div
      className={cn(
        'flex gap-3 rounded-xl border px-4 py-3 text-sm',
        tone === 'info' && 'border-primary/30 bg-primary/5',
        tone === 'warning' && 'border-warning/40 bg-warning/10',
        tone === 'danger' && 'border-destructive/40 bg-destructive/10',
        className,
      )}
    >
      <I
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          tone === 'info' && 'text-brand-ink',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-destructive',
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

async function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for non-secure contexts.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

export function CopyButton({
  value,
  label = 'Copy',
  size = 'sm',
  variant = 'outline',
  className,
  iconOnly,
}: {
  value: string;
  label?: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      size={iconOnly ? 'icon-sm' : size}
      className={className}
      aria-label={iconOnly ? label : undefined}
      onClick={async () => {
        try {
          await writeClipboard(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          toast.error('Could not copy to clipboard');
        }
      }}
    >
      {copied ? <Check className="text-brand-ink" /> : <Copy />}
      {!iconOnly && (copied ? 'Copied' : label)}
    </Button>
  );
}

/** A monospace value with a copy button — used for secrets and URLs. */
export function CopyField({ value, label }: { value: string; label?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/50 p-1.5 pl-3">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-[13px]">{value}</code>
      <CopyButton value={value} label={label ?? 'Copy'} iconOnly />
    </div>
  );
}

export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <pre className="code-block pr-12">
        <code>{code}</code>
      </pre>
      <CopyButton value={code} iconOnly variant="ghost" className="absolute right-2 top-2" label="Copy code" />
    </div>
  );
}

export function HouseholdSelect({
  households,
  value,
  onChange,
  className,
}: {
  households: Household[];
  value: number | undefined;
  onChange: (id: number) => void;
  className?: string;
}) {
  if (households.length <= 1) return null;
  return (
    <Select value={value ? String(value) : undefined} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className={cn('w-full sm:w-64', className)} aria-label="Household">
        <SelectValue placeholder="Select household" />
      </SelectTrigger>
      <SelectContent>
        {households.map((h) => (
          <SelectItem key={h.id} value={String(h.id)}>
            {h.name}
            {h.role === 'owner' ? '' : ' (member)'}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Button that asks for confirmation in an AlertDialog before running `onConfirm`. */
export function ConfirmAction({
  trigger,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = true,
  onConfirm,
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            className={cn(destructive && buttonVariants({ variant: 'destructive' }))}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await onConfirm();
                setOpen(false);
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
