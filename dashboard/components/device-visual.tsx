import { useId } from 'react';

import type { DeviceKind } from '@/lib/device-kind';
import { cn } from '@/lib/utils';

const OFF = '#8B8E8E';
const ACCENT = 'hsl(var(--primary))';
const WARM = '#FFC86B';

/**
 * The app's switch artwork as SVG: a physical wall plate with a glyph per
 * device kind. ON: accent colours, fans spin, bulbs breathe (animations
 * are disabled for prefers-reduced-motion in globals.css).
 */
export function DeviceVisual({
  kind,
  on,
  dimmed = false,
  className,
}: {
  kind: DeviceKind;
  on: boolean;
  dimmed?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const ink = on ? ACCENT : OFF;

  return (
    <svg
      viewBox="0 0 120 100"
      role="img"
      aria-hidden="true"
      className={cn('transition-opacity duration-300', dimmed && 'opacity-50', className)}
    >
      <defs>
        <linearGradient id={`plate-${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--sc-plate-hi)" />
          <stop offset="1" stopColor="var(--sc-plate-lo)" />
        </linearGradient>
        <filter id={`shadow-${uid}`} x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000" floodOpacity="0.18" />
        </filter>
        <radialGradient id={`glow-${uid}`}>
          <stop offset="0" stopColor={kind === 'light' ? WARM : ACCENT} stopOpacity="0.55" />
          <stop offset="1" stopColor={kind === 'light' ? WARM : ACCENT} stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Wall plate */}
      <rect
        x="22"
        y="6"
        width="76"
        height="88"
        rx="16"
        fill={`url(#plate-${uid})`}
        stroke="var(--sc-plate-edge)"
        strokeWidth="1.2"
        filter={`url(#shadow-${uid})`}
      />
      {on && kind !== 'switch' && (
        <circle cx="60" cy="50" r="34" fill={`url(#glow-${uid})`} className="sc-breathe" />
      )}

      <Glyph kind={kind} on={on} ink={ink} />
    </svg>
  );
}

function Glyph({ kind, on, ink }: { kind: DeviceKind; on: boolean; ink: string }) {
  switch (kind) {
    case 'switch':
      return (
        <g>
          <rect x="34" y="20" width="52" height="60" rx="9" fill="var(--sc-plate-lo)" />
          <rect x="36" y="22" width="48" height="56" rx="8" fill="var(--sc-plate-hi)" />
          {/* Rocker grows to fill the frame when ON, like the app */}
          <rect
            x={on ? 39 : 45}
            y={on ? 25 : 34}
            width={on ? 42 : 30}
            height={on ? 50 : 34}
            rx="6"
            fill="var(--sc-paddle)"
            stroke="var(--sc-plate-edge)"
            className="transition-all duration-300"
          />
          <circle cx="60" cy={on ? 32 : 41} r="2.4" fill={on ? ACCENT : OFF} className="transition-all duration-300" />
          <Screw x={28} />
          <Screw x={92} />
        </g>
      );
    case 'light':
      return (
        <g>
          <path
            d="M60 24c-9.4 0-17 7.2-17 16.2 0 6 3.3 10.4 6.9 13.7 2.1 1.9 3.1 4 3.1 6.4V64h14v-3.7c0-2.4 1-4.5 3.1-6.4 3.6-3.3 6.9-7.7 6.9-13.7C77 31.2 69.4 24 60 24z"
            fill={on ? WARM : 'var(--sc-glyph-off)'}
            stroke={on ? '#E0A548' : OFF}
            strokeWidth="1.6"
            className="transition-colors duration-300"
          />
          <rect x="53" y="66" width="14" height="4" rx="2" fill={on ? '#FFB36B' : OFF} />
          <rect x="54.5" y="72" width="11" height="4" rx="2" fill={on ? '#FFB36B' : OFF} />
        </g>
      );
    case 'fan':
      return (
        <g>
          <circle cx="60" cy="50" r="27" fill="none" stroke={OFF} strokeWidth="2" opacity="0.8" />
          <g className={cn('origin-center', on && 'sc-spin')} style={{ transformOrigin: '60px 50px', transformBox: 'view-box' }}>
            {[0, 90, 180, 270].map((deg) => (
              <path
                key={deg}
                transform={`rotate(${deg} 60 50)`}
                d="M60 45 Q74 30 82 42 Q70 49 60 55 Z"
                fill="var(--sc-glyph-off)"
                stroke={OFF}
                strokeWidth="0.8"
              />
            ))}
          </g>
          <circle cx="60" cy="50" r="5.5" fill={ink} className="transition-colors duration-300" />
        </g>
      );
    case 'plug':
      return (
        <g>
          <rect x="52" y="20" width="4" height="14" rx="2" fill={OFF} />
          <rect x="64" y="20" width="4" height="14" rx="2" fill={OFF} />
          <path d="M44 34h32v12c0 9-7 16-16 16s-16-7-16-16V34z" fill="var(--sc-glyph-off)" stroke={OFF} strokeWidth="1.6" />
          <rect x="56" y="62" width="8" height="16" rx="3" fill={OFF} />
          <circle cx="60" cy="46" r="3" fill={ink} className="transition-colors duration-300" />
        </g>
      );
    case 'socket':
      return (
        <g>
          <rect x="38" y="28" width="44" height="44" rx="12" fill="var(--sc-glyph-off)" stroke={OFF} strokeWidth="1.6" />
          <rect x="49" y="42" width="5" height="12" rx="2.5" fill={OFF} />
          <rect x="66" y="42" width="5" height="12" rx="2.5" fill={OFF} />
          <circle cx="60" cy="61" r="2.6" fill={OFF} />
          <circle cx="60" cy="34" r="2.2" fill={ink} className="transition-colors duration-300" />
        </g>
      );
    case 'multiPlug':
      return (
        <g>
          <rect x="34" y="26" width="52" height="48" rx="10" fill="var(--sc-glyph-off)" stroke={OFF} strokeWidth="1.6" />
          {[40, 57].map((y) => (
            <g key={y}>
              <circle cx="48" cy={y} r="5.5" fill="none" stroke={OFF} strokeWidth="1.6" />
              <circle cx="72" cy={y} r="5.5" fill="none" stroke={OFF} strokeWidth="1.6" />
            </g>
          ))}
          <circle cx="60" cy="67" r="2.2" fill={ink} className="transition-colors duration-300" />
        </g>
      );
    case 'tv':
      return (
        <g>
          <rect
            x="34"
            y="28"
            width="52"
            height="36"
            rx="6"
            fill={on ? '#5AAEB5' : '#394647'}
            fillOpacity={on ? 0.85 : 1}
            stroke={OFF}
            strokeWidth="1.6"
            className="transition-colors duration-300"
          />
          <rect x="52" y="66" width="16" height="4" rx="2" fill={OFF} />
          <rect x="46" y="71" width="28" height="3" rx="1.5" fill={OFF} />
        </g>
      );
    case 'router':
      return (
        <g>
          <rect x="44" y="24" width="3" height="20" rx="1.5" fill={OFF} />
          <rect x="73" y="24" width="3" height="20" rx="1.5" fill={OFF} />
          <rect x="36" y="44" width="48" height="24" rx="7" fill="var(--sc-glyph-off)" stroke={OFF} strokeWidth="1.6" />
          {[48, 56, 64, 72].map((x) => (
            <circle key={x} cx={x} cy="56" r="2.4" fill={ink} className="transition-colors duration-300" />
          ))}
        </g>
      );
    case 'ledStrip':
      return (
        <g>
          <rect x="30" y="44" width="60" height="12" rx="6" fill="var(--sc-glyph-off)" stroke={OFF} strokeWidth="1.4" />
          {[38, 49, 60, 71, 82].map((x) => (
            <circle key={x} cx={x} cy="50" r="3" fill={ink} className="transition-colors duration-300" />
          ))}
        </g>
      );
    case 'fishTank':
      return (
        <g>
          <rect x="34" y="28" width="52" height="44" rx="6" fill="none" stroke={OFF} strokeWidth="1.8" />
          <rect
            x="36"
            y="40"
            width="48"
            height="30"
            rx="4"
            fill={on ? '#5AAEB5' : '#394647'}
            fillOpacity={on ? 0.75 : 0.55}
            className="transition-colors duration-300"
          />
          <path d="M52 55c4-4 10-4 14 0l4-3v6l-4-3c-4 4-10 4-14 0z" fill={on ? ACCENT : OFF} />
          {on && (
            <>
              <circle cx="72" cy="46" r="1.6" fill="#fff" opacity="0.8" className="sc-breathe" />
              <circle cx="76" cy="50" r="1.1" fill="#fff" opacity="0.7" className="sc-breathe" />
            </>
          )}
        </g>
      );
    case 'pump':
      return (
        <g>
          {/* outlet pipe, volute, base */}
          <rect x="59" y="26" width="9" height="20" rx="3" fill="var(--sc-glyph-off)" stroke={OFF} strokeWidth="1.6" />
          <circle cx="56" cy="56" r="16" fill="var(--sc-glyph-off)" stroke={OFF} strokeWidth="1.8" />
          <rect x="38" y="74" width="36" height="5" rx="2.5" fill={OFF} />
          <g className={cn(on && 'sc-spin')} style={{ transformOrigin: '56px 56px', transformBox: 'view-box' }}>
            {[0, 72, 144, 216, 288].map((deg) => (
              <line key={deg} x1="56" y1="56" x2="66" y2="56" transform={`rotate(${deg} 56 56)`} stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
            ))}
          </g>
          <circle cx="56" cy="56" r="3.2" fill={ink} className="transition-colors duration-300" />
          {/* water drop at the outlet */}
          <path
            d="M63.5 13c3 4 4.6 6.4 4.6 8.3a4.6 4.6 0 0 1-9.2 0c0-1.9 1.6-4.3 4.6-8.3z"
            fill={on ? '#4FA3E0' : 'var(--sc-glyph-off)'}
            stroke={on ? 'none' : OFF}
            strokeWidth="1"
            className={cn('transition-colors duration-300', on && 'sc-rise')}
          />
        </g>
      );
    case 'motor':
      return (
        <g>
          {/* feet, body with cooling fins, terminal box, shaft, rotor end */}
          <rect x="37" y="68" width="10" height="5" rx="2" fill={OFF} />
          <rect x="60" y="68" width="10" height="5" rx="2" fill={OFF} />
          <rect x="32" y="40" width="44" height="30" rx="8" fill="var(--sc-glyph-off)" stroke={OFF} strokeWidth="1.8" />
          {[41, 50, 59, 68].map((x) => (
            <line key={x} x1={x} y1="45" x2={x} y2="65" stroke={OFF} strokeWidth="1.4" opacity="0.7" />
          ))}
          <rect x="47" y="32" width="14" height="9" rx="2.5" fill="var(--sc-glyph-off)" stroke={OFF} strokeWidth="1.4" />
          <circle cx="54" cy="36.5" r="2" fill={ink} className="transition-colors duration-300" />
          <line x1="76" y1="55" x2="86" y2="55" stroke={OFF} strokeWidth="4" strokeLinecap="round" />
          <circle cx="88" cy="55" r="9" fill="var(--sc-glyph-off)" stroke={OFF} strokeWidth="1.6" />
          <g className={cn(on && 'sc-spin')} style={{ transformOrigin: '88px 55px', transformBox: 'view-box' }}>
            {[0, 120, 240].map((deg) => (
              <line key={deg} x1="88" y1="55" x2="95" y2="55" transform={`rotate(${deg} 88 55)`} stroke={ink} strokeWidth="2.2" strokeLinecap="round" />
            ))}
          </g>
        </g>
      );
    case 'appliance':
    default:
      return (
        <g fill="none" stroke={ink} strokeWidth="4" strokeLinecap="round" className="transition-colors duration-300">
          <path d="M60 30v18" />
          <path d="M49 36a18 18 0 1 0 22 0" />
        </g>
      );
  }
}

function Screw({ x }: { x: number }) {
  return (
    <g stroke="var(--sc-screw)" strokeWidth="0.9">
      <circle cx={x} cy="50" r="3.6" fill="var(--sc-plate-hi)" />
      <line x1={x - 1.6} y1="50" x2={x + 1.6} y2="50" />
      <line x1={x} y1="48.4" x2={x} y2="51.6" />
    </g>
  );
}
