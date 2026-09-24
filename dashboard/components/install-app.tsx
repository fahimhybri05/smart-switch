'use client';

import { CheckCircle2, Download, MonitorDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { detectInstallPlatform, promptInstall, useInstallState, type InstallPlatform } from '@/lib/install';

async function install() {
  if (await promptInstall()) toast.success('Smart Control installed — find it in your apps.');
}

/** Top-bar button; only rendered while the browser allows installing. */
export function InstallButton() {
  const { canPrompt, installed } = useInstallState();
  if (!canPrompt || installed) return null;
  return (
    <Button variant="outline" size="sm" onClick={install} className="gap-1.5" title="Install Smart Control as a desktop app">
      <Download /> <span className="hidden sm:inline">Install app</span>
    </Button>
  );
}

const STEPS: Record<InstallPlatform, string> = {
  chromium: 'Click the install icon at the right end of the address bar, or open the browser menu and choose "Install Smart Control".',
  'safari-mac': 'In Safari, choose File › Add to Dock (macOS Sonoma or newer).',
  firefox: 'Firefox can’t install web apps. Open this page in Chrome or Edge to install it on Windows, macOS or Linux.',
  ios: 'Tap the Share button, then "Add to Home Screen".',
  other: 'Open this page in Chrome or Edge, then use "Install Smart Control" from the browser menu.',
};

/** Settings card: install button when available, otherwise per-browser steps. */
export function DesktopAppCard() {
  const { canPrompt, installed } = useInstallState();
  // Platform is only knowable in the browser; render the neutral text first.
  const [platform, setPlatform] = useState<InstallPlatform>('other');
  useEffect(() => setPlatform(detectInstallPlatform()), []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Desktop app</CardTitle>
        <CardDescription>
          Install Smart Control on Windows, macOS or Linux — it opens in its own window, with its own icon, like any app.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {installed ? (
          <div className="flex items-center gap-3 rounded-xl bg-primary/10 px-4 py-3 text-sm">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-brand-ink" />
            You&apos;re using the installed app.
          </div>
        ) : canPrompt ? (
          <Button onClick={install}>
            <MonitorDown /> Install Smart Control
          </Button>
        ) : (
          <div className="flex items-start gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
            <MonitorDown className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{STEPS[platform]}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
