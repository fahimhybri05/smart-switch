'use client';

import { Slot } from '@radix-ui/react-slot';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
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
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, errorMessage } from '@/lib/api';
import { qk } from '@/lib/cache';
import { useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';

/* --------------------------------- Guard --------------------------------- */

export function Forbidden() {
  return (
    <div className="squircle mx-auto flex max-w-lg flex-col items-center gap-3 border px-6 py-14 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
        <ShieldAlert className="h-6 w-6" />
      </span>
      <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">403</p>
      <h1 className="text-xl font-extrabold">Admins only</h1>
      <p className="text-sm text-muted-foreground">
        Your account doesn&apos;t have access to the admin console.
      </p>
      <Link href="/" className="text-sm font-semibold text-brand-ink hover:underline">
        Back to your switches
      </Link>
    </div>
  );
}

/**
 * Client-side gate for /admin/*: hides the console from non-admins. Purely
 * cosmetic — every /admin API call is enforced by the backend, and a 403
 * from it (e.g. demoted mid-session) also lands here via AdminError.
 */
export function AdminGuard({ children }: { children: ReactNode }) {
  const { me, isLoading } = useMe();
  if (isLoading) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-64 rounded-xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }
  if (!me?.isAdmin) return <Forbidden />;
  return <>{children}</>;
}

/** ErrorState variant that shows the 403 page when the backend says "admin only". */
export function isForbidden(err: unknown) {
  return err instanceof ApiError && err.status === 403 && err.code === 'admin only';
}

/* ------------------------------ Small pieces ----------------------------- */

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={cn('relative w-full sm:w-72', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-9"
      />
    </div>
  );
}

export function OnlineDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-2.5 w-2.5 shrink-0 rounded-full',
        online ? 'bg-primary shadow-[0_0_0_3px_hsl(var(--brand)/0.2)]' : 'bg-muted-foreground/40',
        className,
      )}
      aria-hidden
    />
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && page === 0) {
    return <p className="px-1 text-xs text-muted-foreground">{total} total</p>;
  }
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <p className="text-xs text-muted-foreground">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onChange(page - 1)}
          disabled={page <= 0}
          aria-label="Previous page"
        >
          <ChevronLeft />
        </Button>
        <span className="min-w-16 text-center text-xs font-semibold tabular-nums">
          {page + 1} / {pages}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onChange(page + 1)}
          disabled={page + 1 >= pages}
          aria-label="Next page"
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

/** Steps back a page when the current one empties (e.g. its last row was deleted). */
export function useClampPage(itemCount: number | undefined, page: number, setPage: (p: number) => void) {
  useEffect(() => {
    if (itemCount === 0 && page > 0) setPage(page - 1);
  }, [itemCount, page, setPage]);
}

/** Scrollable table shell with the dashboard's card look. */
export function TableCard({ children }: { children: ReactNode }) {
  return (
    <div className="squircle overflow-hidden border bg-card shadow-soft">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm [&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_th]:py-2.5">
          {children}
        </table>
      </div>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'border-b bg-muted/40 text-left text-[11px] font-bold uppercase tracking-wider text-muted-foreground',
        className,
      )}
    >
      {children}
    </th>
  );
}

/* -------------------------------- Mutations ------------------------------ */

/**
 * Runs an admin action with a success toast (errors toast too, then
 * rethrow so dialogs stay open) and refetches everything under /admin.
 */
export function useAdminAction() {
  const qc = useQueryClient();
  return async function run<T>(fn: () => Promise<T>, success: string): Promise<T> {
    try {
      const result = await fn();
      toast.success(success);
      await qc.invalidateQueries({ queryKey: qk.admin });
      return result;
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    }
  };
}

/**
 * Controlled confirm dialog. With `typedConfirmation`, the confirm button
 * stays disabled until that exact text is typed (destructive, irreversible
 * actions). Errors are toasted by the action itself; the dialog stays open.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = true,
  typedConfirmation,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  typedConfirmation?: string;
  onConfirm: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);
  const blocked = typedConfirmation !== undefined && typed.trim() !== typedConfirmation;

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {typedConfirmation !== undefined && (
          <div className="grid gap-2">
            <Label htmlFor="typed-confirmation" className="text-sm font-normal text-muted-foreground">
              Type <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{typedConfirmation}</code>{' '}
              to confirm
            </Label>
            <Input
              id="typed-confirmation"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || blocked}
            className={cn(destructive && buttonVariants({ variant: 'destructive' }))}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch {
                // already toasted by useAdminAction
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

/** ConfirmDialog opened by its own trigger element. */
export function ConfirmButton({
  trigger,
  ...props
}: Omit<ComponentProps<typeof ConfirmDialog>, 'open' | 'onOpenChange'> & { trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Slot onClick={() => setOpen(true)}>{trigger}</Slot>
      <ConfirmDialog open={open} onOpenChange={setOpen} {...props} />
    </>
  );
}
