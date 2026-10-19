import * as React from 'react';

import { cn } from '@/lib/utils';
import type { LabRegion } from '@/types/enums';

/**
 * A small inline CSS flag for a country filter (ADR 0025 §3, contract §4).
 * Pure CSS gradients on spans: no emoji (inconsistent across OSes, unreadable
 * to some screen readers), no image request, no `dangerouslySetInnerHTML`.
 * Decorative — the country name is always given in text beside it.
 *
 * Flag colours are the national colours, not theme tokens: a flag must look
 * the same in light and dark mode. A hairline ring keeps the white bands
 * visible on a white surface.
 */

const GREECE_BLUE = '#0D5EAF';

const STRIPES: Record<LabRegion, React.CSSProperties> = {
  // Nine horizontal stripes, blue first.
  Greece: {
    backgroundImage: `repeating-linear-gradient(to bottom, ${GREECE_BLUE} 0 11.111%, #FFFFFF 11.111% 22.222%)`,
  },
  // Saffron / white / green.
  India: {
    backgroundImage: 'linear-gradient(to bottom, #FF9933 0 33.333%, #FFFFFF 33.333% 66.666%, #138808 66.666% 100%)',
  },
  // Blue / yellow / red, vertical.
  Romania: {
    backgroundImage: 'linear-gradient(to right, #002B7F 0 33.333%, #FCD116 33.333% 66.666%, #CE1126 66.666% 100%)',
  },
};

/** Greece's canton: a white cross on blue, top-left, five stripes tall. */
const GREECE_CANTON: React.CSSProperties = {
  backgroundColor: GREECE_BLUE,
  backgroundImage:
    'linear-gradient(#FFFFFF, #FFFFFF), linear-gradient(#FFFFFF, #FFFFFF)',
  backgroundSize: '100% 20%, 20% 100%',
  backgroundPosition: 'center, center',
  backgroundRepeat: 'no-repeat',
};

/** India's Ashoka Chakra, reduced to a navy ring at this size. */
const INDIA_CHAKRA: React.CSSProperties = { borderColor: '#000080' };

export function CountryFlag({ region, className }: { region: LabRegion; className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid={`flag-${region}`}
      className={cn(
        'relative inline-block h-[0.6875rem] w-4 shrink-0 overflow-hidden rounded-[2px] ring-1 ring-black/15 dark:ring-white/25',
        className,
      )}
      style={STRIPES[region]}
    >
      {region === 'Greece' ? (
        <span className="absolute left-0 top-0 h-[55.6%] w-[37.5%]" style={GREECE_CANTON} />
      ) : null}
      {region === 'India' ? (
        <span
          className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full border"
          style={INDIA_CHAKRA}
        />
      ) : null}
    </span>
  );
}
