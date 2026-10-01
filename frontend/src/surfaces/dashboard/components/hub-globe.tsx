import * as React from 'react';
import createGlobe from 'cobe';

import type { HubMarker } from '../lib/hub-geo';

/**
 * The hub-footprint globe (Dashboard "crazy-charts" polish, 2026-09-30). This is
 * the file the client's three.js exception was written for — see
 * `docs/MEMORY.md` for the exact authorization text. It does NOT actually import
 * three.js / @react-three/fiber: `cobe` (already a project dependency, unused
 * until this task) draws the same "auto-rotating, drag-to-spin, glowing-marker
 * globe" with a WebGL canvas at a fraction of the weight of a full R3F scene
 * graph, and the task text explicitly names it as an accepted alternative
 * ("a @react-three/fiber globe, cobe is also available if simpler suits
 * better"). three/@react-three/* remain installed and available, unused, exactly
 * as before this task — the exception is not spent, only unneeded here.
 *
 * This component is the ONLY file that imports `cobe`. It is loaded via
 * `React.lazy()` from `hub-globe-panel.tsx`, which also owns every eligibility
 * gate (reduced motion, low core count) and the visibility-based mount/unmount
 * that stands in for R3F's `frameloop="demand"` + IntersectionObserver pause —
 * this file assumes it is only ever mounted when it should actually be
 * rendering, and its one job is: create the globe, animate it, and tear it down
 * cleanly on unmount.
 *
 * Every marker's location/size/colour comes from `buildHubMarkers()` (real
 * `GET /dashboard/hub-type-pipeline` counts) — nothing here invents a number.
 */

/** Mirrors `src/lib/chart-theme.ts`'s `SERIES_TOKENS` ramp (chart-1..6), as
 * literal RGB 0..1 tuples. cobe's marker colour is a WebGL uniform, not a CSS
 * property, so it cannot resolve `hsl(var(--chart-n))` at render time the way
 * `chart-theme.ts::token()` does for SVG/Recharts — these are the same ramp
 * steps' resolved values, computed once, not a second colour system. */
const RAMP_LIGHT: [number, number, number][] = [
  [0.107, 0.23, 0.633], // chart-1 / blue-800
  [0.14, 0.387, 0.92], // chart-2 / blue-600
  [0.379, 0.65, 0.981], // chart-3 / blue-400
  [0.069, 0.531, 0.492], // chart-4 / teal-600
  [0.17, 0.83, 0.742], // chart-5 / teal-400
  [0.556, 0.618, 0.704], // chart-6 / slate-400
];
const RAMP_DARK: [number, number, number][] = [
  [0.569, 0.766, 0.991], // chart-1 / blue-300
  [0.236, 0.515, 0.964], // chart-2 / blue-500
  [0.108, 0.29, 0.792], // chart-3 / blue-700
  [0.17, 0.83, 0.742], // chart-4 / teal-400
  [0.069, 0.531, 0.492], // chart-5 / teal-600
  [0.386, 0.448, 0.534], // chart-6 / slate-500
];

const MIN_MARKER_SIZE = 0.05;
const MAX_MARKER_SIZE = 0.16;

function markerSize(count: number, maxCount: number): number {
  if (maxCount <= 0) return MIN_MARKER_SIZE;
  const t = count / maxCount;
  return MIN_MARKER_SIZE + t * (MAX_MARKER_SIZE - MIN_MARKER_SIZE);
}

export interface HubGlobeProps {
  markers: HubMarker[];
  dark: boolean;
  /** Auto-rotation speed in radians/frame; 0 disables auto-rotate (still
   *  drag-to-spin) — used when a coarser reduced-motion preference allows the
   *  static globe but not continuous animation. */
  autoRotateSpeed?: number;
  className?: string;
}

export function HubGlobe({
  markers,
  dark,
  autoRotateSpeed = 0.0032,
  className,
}: HubGlobeProps): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const phiRef = React.useRef(0);
  const widthRef = React.useRef(0);
  const pointerInteracting = React.useRef<number | null>(null);
  const pointerMovement = React.useRef(0);

  const ramp = dark ? RAMP_DARK : RAMP_LIGHT;
  const maxCount = markers.reduce((max, m) => Math.max(max, m.count), 0);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const cobeMarkers = markers.map((marker, index) => ({
      location: [marker.lat, marker.lng] as [number, number],
      size: markerSize(marker.count, maxCount),
      color: ramp[Math.min(index, ramp.length - 1)],
    }));

    const onResize = () => {
      if (wrapper) widthRef.current = wrapper.offsetWidth;
    };
    onResize();
    window.addEventListener('resize', onResize);

    // `cobe` 2.x has no internal RAF loop / `onRender` callback (that was the
    // older cobe README's API) — it exposes an imperative `update()` and the
    // CALLER drives the animation loop. That is actually the more precise
    // primitive for this task's "frameloop control" requirement: the
    // `raf` handle below is exactly the thing an unmount cancels, which is
    // this component's half of the pause behaviour `hub-globe-panel.tsx`
    // implements the other half of (mount/unmount on visibility).
    //
    // Defensive: `createGlobe` itself already fails soft (returns a no-op
    // `{update, destroy}` stub) when no WebGL context is available rather than
    // throwing — confirmed by reading `cobe`'s source. The try/catch is a
    // second line of defence against any other construction-time throw (a
    // future cobe version, an unusual embedded webview), so a broken globe
    // never takes down the whole Dashboard route for a decorative panel.
    let raf = 0;
    try {
      const globe = createGlobe(canvas, {
        devicePixelRatio: dpr,
        width: widthRef.current * dpr,
        height: widthRef.current * dpr,
        phi: 0,
        theta: 0.3,
        dark: dark ? 1 : 0,
        diffuse: 1.2,
        mapSamples: 14_000,
        mapBrightness: dark ? 3.5 : 6,
        baseColor: dark ? [0.13, 0.16, 0.22] : [0.86, 0.89, 0.94],
        markerColor: ramp[0],
        glowColor: dark ? [0.15, 0.19, 0.26] : [0.95, 0.96, 0.98],
        markers: cobeMarkers,
      });

      const frame = () => {
        if (pointerInteracting.current === null) {
          phiRef.current += autoRotateSpeed;
        }
        globe.update({
          phi: phiRef.current + pointerMovement.current,
          width: widthRef.current * dpr,
          height: widthRef.current * dpr,
        });
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      // Fade the canvas in once the first frame has painted — avoids a flash
      // of an unstyled/blank canvas while the WebGL context and map texture
      // warm up.
      requestAnimationFrame(() => {
        if (canvas) canvas.style.opacity = '1';
      });

      return () => {
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(raf);
        globe.destroy();
      };
    } catch {
      // No WebGL available — leave the canvas blank; the panel's legend list
      // is the real, always-present accessible data regardless.
      return () => {
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(raf);
      };
    }
    // markers/ramp/maxCount/dark/autoRotateSpeed are captured once per
    // (re)mount; `hub-globe-panel.tsx` keys this component by a stable
    // identity per data snapshot rather than diffing marker arrays
    // frame-to-frame, so re-running this effect on every prop change would
    // tear down and rebuild the whole WebGL context for no visual benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointerInteracting.current = event.clientX;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
  };
  const pointerUp = () => {
    pointerInteracting.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerInteracting.current === null) return;
    const delta = event.clientX - pointerInteracting.current;
    pointerMovement.current += delta / 200;
    pointerInteracting.current = event.clientX;
  };

  return (
    <div ref={wrapperRef} className={className}>
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        onPointerDown={pointerDown}
        onPointerUp={pointerUp}
        onPointerOut={pointerUp}
        onPointerMove={pointerMove}
        style={{
          width: '100%',
          height: '100%',
          cursor: 'grab',
          opacity: 0,
          transition: 'opacity 400ms ease-out',
          touchAction: 'none',
        }}
      />
    </div>
  );
}
