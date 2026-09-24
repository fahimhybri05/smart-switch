import type { Metadata } from 'next';

import { ActivityPage } from '@/components/activity/activity';

export const metadata: Metadata = { title: 'Activity' };

export default function Page() {
  return <ActivityPage />;
}
