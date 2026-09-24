import type { Metadata } from 'next';

import { HouseholdPage } from '@/components/household/household';

export const metadata: Metadata = { title: 'Household' };

export default function Page() {
  return <HouseholdPage />;
}
