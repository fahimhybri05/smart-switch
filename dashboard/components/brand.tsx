import Image from 'next/image';

import { cn } from '@/lib/utils';

export function BrandMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <Image
      src="/logo-mark.png"
      alt=""
      unoptimized
      width={size}
      height={size}
      priority
      className={cn('rounded-[28%] shadow-glow-sm', className)}
    />
  );
}

export function Brand({ className, size = 36 }: { className?: string; size?: number }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark size={size} />
      <span className="text-lg font-extrabold tracking-tight">
        Smart <span className="text-brand-ink">Control</span>
      </span>
    </span>
  );
}
