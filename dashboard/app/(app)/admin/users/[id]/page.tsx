import type { Metadata } from 'next';

import { AdminUserDetail } from '@/components/admin/user-detail';

export const metadata: Metadata = { title: 'User' };

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AdminUserDetail userId={Number(id)} />;
}
