import type { Metadata } from 'next';

import { SchedulesPage } from '@/components/schedules/schedules-page';

export const metadata: Metadata = { title: 'Schedules' };

export default function Page() {
  return <SchedulesPage />;
}
