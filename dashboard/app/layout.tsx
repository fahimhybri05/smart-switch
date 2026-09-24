import '@fontsource-variable/archivo';
import './globals.css';

import type { Metadata, Viewport } from 'next';

import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: { default: 'Smart Control', template: '%s · Smart Control' },
  description: 'Manage your Smart Control switches, household and integrations from the web.',
  applicationName: 'Smart Control',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#101827' },
    { media: '(prefers-color-scheme: light)', color: '#f4f6fa' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
