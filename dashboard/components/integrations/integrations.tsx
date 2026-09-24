'use client';

import { BookOpen, KeyRound, Link2 } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { PageHeader } from '@/components/common';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { ApiKeysPanel } from './api-keys';
import { ApiDocs } from './docs';
import { HooksPanel } from './hooks';

const TABS = ['keys', 'hooks', 'docs'] as const;
type Tab = (typeof TABS)[number];

export function Integrations({ apiUrl }: { apiUrl: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as Tab) : 'keys';

  return (
    <>
      <PageHeader
        title="API & Integrations"
        description="Control your switches from Home Assistant, IFTTT, scripts or your own dashboard."
      />
      <Tabs
        value={tab}
        onValueChange={(v) => router.replace(`${pathname}?tab=${v}`, { scroll: false })}
      >
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="keys">
            <KeyRound /> API keys
          </TabsTrigger>
          <TabsTrigger value="hooks">
            <Link2 /> Hook URLs
          </TabsTrigger>
          <TabsTrigger value="docs">
            <BookOpen /> Docs
          </TabsTrigger>
        </TabsList>
        <TabsContent value="keys">
          <ApiKeysPanel />
        </TabsContent>
        <TabsContent value="hooks">
          <HooksPanel />
        </TabsContent>
        <TabsContent value="docs">
          <ApiDocs apiUrl={apiUrl} />
        </TabsContent>
      </Tabs>
    </>
  );
}
