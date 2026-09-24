import type { Metadata } from 'next';

import { Integrations } from '@/components/integrations/integrations';
import { publicApiUrl } from '@/lib/server/config';

export const metadata: Metadata = { title: 'API & Integrations' };

// PUBLIC_API_URL is read at request time so it can change without a rebuild.
export const dynamic = 'force-dynamic';

export default function IntegrationsPage() {
  return <Integrations apiUrl={publicApiUrl()} />;
}
