import type { Metadata } from 'next';

import { ScenesPage } from '@/components/scenes/scenes-page';

export const metadata: Metadata = { title: 'Scenes' };

export default function Page() {
  return <ScenesPage />;
}
