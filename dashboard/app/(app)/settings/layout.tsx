import type { ReactNode } from 'react';

import { SettingsNav } from '@/components/settings/settings-nav';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <SettingsNav />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
