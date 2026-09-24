import type { Metadata } from 'next';

import { AdminGuard } from '@/components/admin/shared';

export const metadata: Metadata = { title: { default: 'Admin', template: '%s · Admin · Smart Control' } };

/** Hidden from non-admins client-side; the backend enforces is_admin on every /admin call. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminGuard>{children}</AdminGuard>;
}
