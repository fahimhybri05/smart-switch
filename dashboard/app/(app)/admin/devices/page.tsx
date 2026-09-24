import type { Metadata } from 'next';

import { AdminDevices } from '@/components/admin/devices';

export const metadata: Metadata = { title: 'Devices' };

export default function AdminDevicesPage() {
  return <AdminDevices />;
}
