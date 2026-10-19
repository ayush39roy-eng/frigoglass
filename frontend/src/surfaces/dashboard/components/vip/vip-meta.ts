import type { VipItem, VipPillar, VipStatusTag } from '@/lib/api/vip';

/**
 * Display metadata for the VIP board (P14, ADR 0027 §6). Class strings are
 * written out in full so Tailwind sees them. Accents come from the
 * `--vip-*` tokens (tokens.css, AA pinned by `styles/vip-pillar-contrast.test.ts`):
 * Innovation amber/ochre, Market Expansion blue, Performance teal.
 */
export interface PillarStyle {
  /** The solid band / number disc. */
  band: string;
  /** A highlighted (VIP) item's background + its left rule. */
  highlight: string;
  /** Accent text on the surface or the highlight background. */
  ink: string;
  /** The small "VIP" marker. */
  marker: string;
  /** Column top rule. */
  rule: string;
}

export const PILLAR_STYLE: Record<VipPillar, PillarStyle> = {
  INNOVATION: {
    band: 'bg-vip-innovation text-vip-innovation-fg',
    highlight: 'bg-vip-innovation-subtle border-l-4 border-vip-innovation',
    ink: 'text-vip-innovation-ink',
    marker: 'bg-vip-innovation text-vip-innovation-fg',
    rule: 'border-t-4 border-vip-innovation',
  },
  MARKET_EXPANSION: {
    band: 'bg-vip-market text-vip-market-fg',
    highlight: 'bg-vip-market-subtle border-l-4 border-vip-market',
    ink: 'text-vip-market-ink',
    marker: 'bg-vip-market text-vip-market-fg',
    rule: 'border-t-4 border-vip-market',
  },
  PERFORMANCE: {
    band: 'bg-vip-performance text-vip-performance-fg',
    highlight: 'bg-vip-performance-subtle border-l-4 border-vip-performance',
    ink: 'text-vip-performance-ink',
    marker: 'bg-vip-performance text-vip-performance-fg',
    rule: 'border-t-4 border-vip-performance',
  },
};

export const STATUS_TAG_META: Record<VipStatusTag, { label: string; tone: 'success' | 'warning' | 'danger' | 'primary' | 'neutral' }> = {
  ON_TRACK: { label: 'On track', tone: 'success' },
  DELAYED: { label: 'Delayed', tone: 'warning' },
  HIGH_RISK: { label: 'High risk', tone: 'danger' },
  COMMERCIALIZED: { label: 'Commercialized', tone: 'primary' },
  IMPLEMENTED: { label: 'Implemented', tone: 'primary' },
  TBD: { label: 'TBD', tone: 'neutral' },
  UNDER_INVESTIGATION: { label: 'Under investigation', tone: 'neutral' },
  AWAITING_APPROVAL: { label: 'Awaiting approval', tone: 'warning' },
};

/** Find a served item (top level or sub-item) by id — a lookup, not a derivation. */
export function findItem(items: VipItem[], id: string): VipItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    const child = item.children.find((c) => c.id === id);
    if (child) return child;
  }
  return null;
}

/** The Project Workspace — the client's "project folder" (ADR 0027 §6). */
export function workspaceHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}
