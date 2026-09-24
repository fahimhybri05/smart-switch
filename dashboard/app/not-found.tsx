import Link from 'next/link';

import { BrandMark } from '@/components/brand';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <BrandMark size={56} />
      <h1 className="text-2xl font-extrabold">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you&apos;re looking for doesn&apos;t exist.</p>
      <Link href="/" className="font-semibold text-brand-ink hover:underline">
        Back to Smart Control
      </Link>
    </div>
  );
}
