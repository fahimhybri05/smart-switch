import type { Metadata } from 'next';

import { AdminApiKeys } from '@/components/admin/api-keys';

export const metadata: Metadata = { title: 'API keys' };

export default function AdminApiKeysPage() {
  return <AdminApiKeys />;
}
