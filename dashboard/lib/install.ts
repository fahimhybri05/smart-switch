'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * Desktop-app install support (PWA). Chrome/Edge fire `beforeinstallprompt`
 * once, early — often before any component mounts — so the event is captured
 * at module load and kept in a tiny store the UI subscribes to.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallPlatform = 'chromium' | 'safari-mac' | 'firefox' | 'ios' | 'other';

interface InstallState {
  /** Browser offered an install prompt we can trigger. */
  canPrompt: boolean;
  /** Running as the installed app (its own window). */
  installed: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { canPrompt: false, installed: false };
const listeners = new Set<() => void>();
const SERVER_STATE: InstallState = { canPrompt: false, installed: false };

function set(next: Partial<InstallState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

if (typeof window !== 'undefined') {
  state = { ...state, installed: isStandalone() };
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own button instead of the mini-infobar
    deferred = e as BeforeInstallPromptEvent;
    set({ canPrompt: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    set({ canPrompt: false, installed: true });
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}

/** Opens the browser's install dialog. Resolves true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = null; // a prompt can only be used once
  set({ canPrompt: false });
  await e.prompt();
  const { outcome } = await e.userChoice;
  return outcome === 'accepted';
}

export function detectInstallPlatform(): InstallPlatform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/(Chrome|Chromium|Edg|OPR)\//.test(ua)) return 'chromium';
  if (/Macintosh/.test(ua) && /Safari\//.test(ua)) return 'safari-mac';
  return 'other';
}

/** Registers /sw.js in production builds (dev keeps hot reload predictable). */
export function useServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Install still works in most browsers without it; nothing to surface.
    });
  }, []);
}
