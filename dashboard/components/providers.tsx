'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';

import { ApiError } from '@/lib/api';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: true,
        retry: (failureCount, err) => {
          // Don't hammer the backend on client errors (401/403/404/429…).
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={(resolvedTheme as 'light' | 'dark' | undefined) ?? 'system'}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{ className: 'rounded-xl' }}
    />
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        {children}
        <ThemedToaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
