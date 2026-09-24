import type { Metadata } from 'next';

import { AdminActivity } from '@/components/admin/activity';

export const metadata: Metadata = { title: 'Activity' };

export default function AdminActivityPage() {
  return <AdminActivity />;
}
