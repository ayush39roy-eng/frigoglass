import * as React from 'react';
import { Globe2, MapPin } from 'lucide-react';

import { GlassPanel } from '@/components/ui/glass-panel';
import { useTheme } from '@/components/theme/theme-context';
import { EmptyState } from '@/components/shared/empty-state';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { cn } from '@/lib/utils';
import { formatInteger } from '@/lib/format';

import type { HubTypePipelineRow } from '../api/types';
import { buildHubMarkers } from '../lib/hub-geo';

/**
 * "Hub footprint" — the reference deck's "Sales Mapping by Country" globe panel,
 * repurposed onto real data: Frigoglass's 6 hubs across Greece, India and Romania
 * (`docs/DOMAIN_RULES.md` "Hubs and lab-region mapping"), sized by each hub's
 * real project count from `GET /dashboard/hub-type-pipeline`.
 *
 * The globe itself (`./hub-globe.tsx`, `cobe`) is loaded via `React.lazy()` and
 * mounted ONLY when every eligibility gate holds — reduced motion and low core
 * count don't just skip rendering it, they skip FETCHING it: `shouldRenderGlobe`
 * gates the `<HubGlobe>` element itself, so `import('./hub-globe')` is never
 * called at all when ineligible. Visibility (IntersectionObserver) and tab focus
 * (`document.hidden`) additionally mount/unmount it after that — an unmount
 * calls `cobe`'s `destroy()` via the child's cleanup, which is this component's
 * stand-in for R3F's `frameloop="demand"` pause (see `./hub-globe.tsx`'s header
 * comment for the full mapping from the task's R3F-shaped requirements to their
 * `cobe` equivalents).
 *
 * The legend list beside the canvas is the accessible equivalent of what it
 * draws — the canvas itself is `aria-hidden` (a decorative WebGL rendering has
 * no accessible text content of its own), so the same real hub/country/count
 * data is always present as real text/DOM, not only as pixels.
 */

const HubGlobe = React.lazy(() =>
  import('./hub-globe').then((mod) => ({ default: mod.HubGlobe })),
);

const RANK_DOT = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-chart-6',
];

export interface HubGlobePanelProps {
  rows: HubTypePipelineRow[];
}

export function HubGlobePanel({ rows }: HubGlobePanelProps): React.JSX.Element {
  const { resolvedTheme } = useTheme();
  const reducedMotion = usePrefersReducedMotion();
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const [inView, setInView] = React.useState(false);
  const [tabVisible, setTabVisible] = React.useState(
    typeof document === 'undefined' || !document.hidden,
  );

  const lowPowerDevice =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number' &&
    navigator.hardwareConcurrency > 0 &&
    navigator.hardwareConcurrency <= 4;

  const eligible = !reducedMotion && !lowPowerDevice;

  React.useEffect(() => {
    if (!eligible) return;
    const node = wrapperRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      // No IntersectionObserver in this environment (older browser / test DOM) —
      // fail open to "visible" rather than never rendering the globe at all.
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry?.isIntersecting ?? false),
      { threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [eligible]);

  React.useEffect(() => {
    if (!eligible || typeof document === 'undefined') return;
    const onVisibility = () => setTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [eligible]);

  const markers = React.useMemo(() => buildHubMarkers(rows), [rows]);
  const maxCount = markers.reduce((max, m) => Math.max(max, m.count), 0);
  const shouldRenderGlobe = eligible && inView && tabVisible && markers.length > 0;

  return (
    <GlassPanel opacity="hero" className="flex flex-col gap-4 p-card">
      <div className="flex items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-pill bg-primary-subtle text-primary-subtle-fg">
          <Globe2 className="size-4" aria-hidden="true" />
        </span>
        <h3 className="text-h2">Hub footprint</h3>
      </div>

      {markers.length === 0 ? (
        <EmptyState
          title="No hubs in scope"
          description="There are no projects in the hub × type pipeline for your hub scope."
        />
      ) : (
        <>
          <div
            ref={wrapperRef}
            className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(11rem,0.85fr)]"
          >
            <div className="relative aspect-square w-full max-w-[22rem] justify-self-center sm:justify-self-start">
              {shouldRenderGlobe ? (
                <React.Suspense
                  fallback={
                    <div className="size-full animate-pulse rounded-full bg-surface-sunken" />
                  }
                >
                  <HubGlobe markers={markers} dark={resolvedTheme === 'dark'} className="size-full" />
                </React.Suspense>
              ) : (
                <div
                  aria-hidden="true"
                  className="flex size-full flex-col items-center justify-center gap-2 rounded-full border border-dashed border-border-strong bg-surface-sunken text-center"
                >
                  <MapPin className="size-6 text-text-subtle" />
                  <p className="max-w-[10rem] text-2xs text-text-subtle">
                    {reducedMotion || lowPowerDevice
                      ? 'Animated globe disabled for this device/preference'
                      : 'Globe loads when in view'}
                  </p>
                </div>
              )}
            </div>

            {/* Legend — real per-hub counts, ranked. This IS the accessible
                equivalent of the canvas (which is `aria-hidden`, being
                decorative WebGL with no text content of its own) as well as
                the "colour by load" half of the requirement: `cobe` markers
                take one colour each, but the swatch-and-bar legend is what
                carries the rank-ordered ramp a reader can actually read a
                value from (chart-theme.ts's own rule: colour is assigned by
                VALUE rank, never by array position). */}
            <ol
              aria-label="Real project count per hub, from the live hub × type pipeline"
              className="flex flex-col justify-center gap-2"
            >
              {markers.map((marker, index) => {
                const pct = maxCount > 0 ? Math.round((marker.count / maxCount) * 100) : 0;
                return (
                  <li key={marker.hub} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-2 text-2xs">
                      <span className="flex min-w-0 items-center gap-1.5 truncate font-medium text-text">
                        <span
                          className={cn(
                            'size-2 shrink-0 rounded-pill',
                            RANK_DOT[Math.min(index, RANK_DOT.length - 1)],
                          )}
                        />
                        <span className="truncate">{marker.hub}</span>
                      </span>
                      <span className="tnum shrink-0 font-mono text-text-muted" data-numeric="">
                        {formatInteger(marker.count)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-pill bg-surface-sunken">
                      <div
                        className={cn(
                          'h-full rounded-pill transition-[width] duration-slow ease-ease-out-expo',
                          RANK_DOT[Math.min(index, RANK_DOT.length - 1)],
                        )}
                        style={{ width: `${String(pct)}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          <p className="text-2xs text-text-subtle">
            Sized by each hub&apos;s share of the live pipeline (
            <code>GET /dashboard/hub-type-pipeline</code>). Marker positions are
            approximate, country-level anchors, not exact facility addresses — the Hub model has no
            stored coordinates.
          </p>
        </>
      )}
    </GlassPanel>
  );
}
