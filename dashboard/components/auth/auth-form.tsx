'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authApi, errorMessage } from '@/lib/api';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

const signupSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    password: z.string().min(8, 'At least 8 characters').max(128, 'At most 128 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: "Passwords don't match" });

type SignupValues = z.infer<typeof signupSchema>;

/** Only same-site relative paths are allowed as post-login targets (no open redirects). */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (raw.startsWith('/login') || raw.startsWith('/signup') || raw.startsWith('/api')) return '/';
  return raw;
}

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const isSignup = mode === 'signup';

  const form = useForm<SignupValues>({
    // Login ignores the confirm field.
    resolver: zodResolver(isSignup ? signupSchema : loginSchema.extend({ confirm: z.string().optional() })) as never,
    defaultValues: { email: '', password: '', confirm: '' },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ email, password }) => {
    setFormError(null);
    try {
      if (isSignup) await authApi.signup(email, password);
      else await authApi.login(email, password);
      qc.clear();
      router.replace(safeNext(params.get('next')));
      router.refresh();
    } catch (err) {
      setFormError(errorMessage(err));
    }
  });

  const nextParam = params.get('next');
  const switchHref = `${isSignup ? '/login' : '/signup'}${nextParam ? `?next=${encodeURIComponent(nextParam)}` : ''}`;

  return (
    <Card className="border-border/70 bg-card/90 backdrop-blur">
      <CardHeader className="pb-4">
        <CardTitle className="text-2xl">{isSignup ? 'Create your account' : 'Welcome back'}</CardTitle>
        <CardDescription>
          {isSignup
            ? 'Use the same account in the Smart Control app and on the web.'
            : 'Sign in with your Smart Control account.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              aria-invalid={!!errors.email}
              {...form.register('email')}
            />
            {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              aria-invalid={!!errors.password}
              {...form.register('password')}
            />
            {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
          </div>
          {isSignup && (
            <div className="grid gap-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!errors.confirm}
                {...form.register('confirm')}
              />
              {errors.confirm && <p className="text-xs text-destructive">{errors.confirm.message}</p>}
            </div>
          )}

          {formError && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {formError}
            </p>
          )}

          <Button type="submit" size="lg" loading={isSubmitting} className="mt-1 w-full">
            {isSignup ? 'Create account' : 'Sign in'}
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            {isSignup ? 'Already have an account?' : 'New to Smart Control?'}{' '}
            <Link href={switchHref} className="font-semibold text-brand-ink hover:underline">
              {isSignup ? 'Sign in' : 'Create an account'}
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
