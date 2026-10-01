import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Brand illustration for the sign-in page (2026-10-01): a glass-door commercial
 * cooler — Frigoglass's core product — drawn as inline SVG so it ships inside the
 * bundle. The app runs on-premise behind the client's network, where an image CDN
 * would be blocked, so no external image is ever fetched. Colours read the theme
 * tokens; it sits on the blue feature gradient, so most fills are white at
 * varying opacity. Purely decorative (`aria-hidden`).
 */

const BOTTLE_TONES = [
  'hsl(var(--dash-cat-6))',
  'hsl(var(--dash-cat-5))',
  'hsl(var(--dash-cat-4))',
  'hsl(var(--dash-cat-3))',
  'hsl(var(--dash-cat-2))',
  'hsl(var(--dash-cat-10))',
];

function Bottle({ x, y, tone, tall = false }: { x: number; y: number; tone: string; tall?: boolean }): React.JSX.Element {
  const h = tall ? 58 : 46;
  return (
    <g transform={`translate(${String(x)} ${String(y - h)})`}>
      <rect x={5} y={0} width={8} height={8} rx={2} fill="white" fillOpacity={0.85} />
      <path
        d={`M3 10 Q9 6 15 10 L17 18 L17 ${String(h - 4)} Q17 ${String(h)} 13 ${String(h)} L5 ${String(h)} Q1 ${String(h)} 1 ${String(h - 4)} L1 18 Z`}
        fill={tone}
      />
      <rect x={3} y={h * 0.45} width={12} height={h * 0.25} rx={2} fill="white" fillOpacity={0.9} />
      <rect x={4} y={14} width={2.5} height={h - 22} rx={1.25} fill="white" fillOpacity={0.35} />
    </g>
  );
}

function Can({ x, y, tone }: { x: number; y: number; tone: string }): React.JSX.Element {
  return (
    <g transform={`translate(${String(x)} ${String(y - 32)})`}>
      <rect x={0} y={0} width={16} height={32} rx={4} fill={tone} />
      <rect x={0} y={11} width={16} height={9} fill="white" fillOpacity={0.85} />
      <rect x={3} y={3} width={2} height={26} rx={1} fill="white" fillOpacity={0.35} />
    </g>
  );
}

export function CoolerIllustration({ className }: { className?: string }): React.JSX.Element {
  const shelves = [118, 196, 274, 352];
  return (
    <svg viewBox="0 0 320 440" className={cn('h-auto w-full', className)} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="cooler-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="white" stopOpacity={0.28} />
          <stop offset="55%" stopColor="white" stopOpacity={0.08} />
          <stop offset="100%" stopColor="white" stopOpacity={0.18} />
        </linearGradient>
        <linearGradient id="cooler-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(224 30% 16%)" />
          <stop offset="100%" stopColor="hsl(224 34% 8%)" />
        </linearGradient>
        <radialGradient id="cooler-glow" cx="0.5" cy="0.35" r="0.6">
          <stop offset="0%" stopColor="hsl(var(--blue-300))" stopOpacity={0.55} />
          <stop offset="100%" stopColor="hsl(var(--blue-300))" stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* floor shadow */}
      <ellipse cx={160} cy={428} rx={130} ry={10} fill="black" fillOpacity={0.25} />

      {/* cabinet */}
      <rect x={40} y={20} width={240} height={400} rx={22} fill="url(#cooler-body)" />
      {/* canopy / brand header */}
      <rect x={40} y={20} width={240} height={52} rx={22} fill="hsl(var(--blue-700))" />
      <rect x={40} y={50} width={240} height={22} fill="hsl(var(--blue-700))" />
      <text x={160} y={53} textAnchor="middle" fontSize={17} fontWeight={800} fill="white" letterSpacing={2}>
        FRIGOGLASS
      </text>

      {/* interior + LED glow */}
      <rect x={58} y={84} width={204} height={310} rx={10} fill="hsl(224 40% 18%)" />
      <rect x={58} y={84} width={204} height={310} rx={10} fill="url(#cooler-glow)" />

      {/* shelves with stock */}
      {shelves.map((y, row) => (
        <g key={y}>
          {Array.from({ length: 6 }, (_, i) => {
            const x = 68 + i * 32;
            const tone = BOTTLE_TONES[(i + row) % BOTTLE_TONES.length] ?? 'white';
            return row % 2 === 0 ? (
              <Bottle key={i} x={x} y={y} tone={tone} tall={i % 3 === 0} />
            ) : (
              <Can key={i} x={x + 2} y={y} tone={tone} />
            );
          })}
          <rect x={60} y={y} width={200} height={5} rx={2.5} fill="white" fillOpacity={0.55} />
        </g>
      ))}

      {/* glass door + reflections */}
      <rect x={52} y={78} width={216} height={322} rx={12} fill="url(#cooler-glass)" stroke="white" strokeOpacity={0.5} strokeWidth={3} />
      <path d="M80 92 L130 92 L84 380 L66 380 Z" fill="white" fillOpacity={0.1} />
      <path d="M150 92 L166 92 L120 380 L112 380 Z" fill="white" fillOpacity={0.07} />
      {/* handle */}
      <rect x={250} y={190} width={8} height={96} rx={4} fill="white" fillOpacity={0.9} />

      {/* plinth + feet */}
      <rect x={40} y={398} width={240} height={22} rx={8} fill="hsl(224 34% 6%)" />
      <rect x={60} y={404} width={200} height={4} rx={2} fill="white" fillOpacity={0.18} />
      <rect x={58} y={418} width={18} height={8} rx={3} fill="hsl(224 34% 6%)" />
      <rect x={244} y={418} width={18} height={8} rx={3} fill="hsl(224 34% 6%)" />
    </svg>
  );
}
