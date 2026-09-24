import type { Metadata } from 'next';

import { GroupsPage } from '@/components/groups/groups';

export const metadata: Metadata = { title: 'Groups' };

export default function Page() {
  return <GroupsPage />;
}
