import type { Metadata } from 'next';

import { GeneralSettings } from '@/components/settings/general';
import { publicApiUrl } from '@/lib/server/config';

import pkg from '../../../package.json';

export const metadata: Metadata = { title: 'Settings' };

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return <GeneralSettings apiUrl={publicApiUrl()} version={pkg.version} />;
}
