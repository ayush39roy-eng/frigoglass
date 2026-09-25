import * as React from 'react';
import {
  Boxes,
  CalendarRange,
  FilePlus2,
  GaugeCircle,
  LayoutDashboard,
  LayoutGrid,
  ScrollText,
} from 'lucide-react';

/** lucide-react does not export its icon component type from the package entry. */
export type IconComponent = React.ComponentType<React.SVGProps<SVGSVGElement>>;

/**
 * The six surfaces (PROJECT_AND_STACK.md §2) plus the Audit Log (P7-T05 —
 * not one of the original six/§2 surfaces; a read-only RBAC-gated addition
 * for the Auditor/Admin roles, filling the `core.rbac.Surface.AUDIT_LOG` gap
 * flagged by `frontend-builder` while writing `docs/HANDOVER/ADMIN_GUIDE.md`
 * for P7-T03 — see `docs/MEMORY.md`). This is the single source of truth for
 * both the sidebar nav and the router. Each surface is built in its own P4
 * task — until then the route renders a <PlaceholderPage> naming the owning
 * task.
 */
/**
 * Sidebar grouping. Four groups, ordered by how often a planner reaches for them:
 * you look at the plan, you execute against it, you configure the inputs, you export
 * the record. Group labels are uppercase micro-labels, not nav items — they are never
 * clickable, which is why they carry no path.
 */
export type NavGroup = 'Plan' | 'Execute' | 'Configure' | 'Data';

export const NAV_GROUP_ORDER: readonly NavGroup[] = ['Plan', 'Execute', 'Configure', 'Data'];

export interface SurfaceNavItem {
  /** Route path. */
  path: string;
  /** Sidebar label. */
  label: string;
  /** Full surface name for page titles / placeholders. */
  title: string;
  icon: IconComponent;
  /** IMPLEMENTATION_PLAN.md task that builds this surface. */
  task: string;
  /** One-line description shown on the placeholder page. */
  summary: string;
  /** Sidebar section this surface belongs to. */
  group: NavGroup;
  /**
   * Density zone this surface renders in (src/components/layout/density-zone.tsx).
   *
   * 'overview' is for screens a person READS — a board audience, a form being filled
   * in. 'working' is for screens a person WORKS — comparing 236 rows, dragging bars
   * across 78 weeks. The distinction is about the task, not the amount of data: the
   * Dashboard aggregates far more rows than the Registration form, and both are
   * 'overview' because neither is scanned.
   */
  density: 'overview' | 'working';
}

export const SURFACES: readonly SurfaceNavItem[] = [
  {
    path: '/',
    label: 'Dashboard',
    title: 'Global RPD Dashboard',
    icon: LayoutDashboard,
    task: 'P4-T02',
    summary:
      'Portfolio-wide view: within-year completion count, spillover and left-out totals, per-hub rollups — all sourced from the active schedule run (Invariant I9).',
    group: 'Plan',
    density: 'overview',
  },
  {
    path: '/capacity',
    label: 'Capacity',
    title: 'RPD Capacity',
    icon: GaugeCircle,
    task: 'P4-T03',
    summary:
      'Design and lab load vs. capacity per hub, reconciled to the week against the active schedule run (Invariants I6 / I7).',
    group: 'Plan',
    density: 'working',
  },
  {
    path: '/matrix',
    label: 'Prioritization',
    title: 'Prioritization Matrix',
    icon: LayoutGrid,
    task: 'P4-T04',
    summary:
      '236 projects x 13 scoring dimensions, weighted score and band per project, with a server-driven currency toggle (EUR / USD / INR).',
    group: 'Plan',
    density: 'working',
  },
  {
    path: '/timeline',
    label: 'Timeline',
    title: 'Project Execution Timeline',
    icon: CalendarRange,
    task: 'P4-T05',
    summary:
      'Hand-built virtualized Gantt: 14 workflow steps per project across the 78-week horizon, engineer and chamber assignments, conflict and spillover markers.',
    group: 'Execute',
    density: 'working',
  },
  {
    path: '/register',
    label: 'Register',
    title: 'Project Registration',
    icon: FilePlus2,
    task: 'P4-T06',
    summary:
      'Create and edit projects with hard-gated required fields (category, financials) validated client-side and re-validated by the API.',
    group: 'Execute',
    density: 'overview',
  },
  {
    path: '/planning',
    label: 'Planning',
    title: 'Capacity Planning',
    icon: Boxes,
    task: 'P4-T07',
    summary:
      'Engineer and chamber configuration, Apply Logic and Auto-assign. Per-engineer utilization display stays gated on OPEN_QUESTIONS #8 (GDPR).',
    group: 'Configure',
    density: 'working',
  },
  {
    path: '/audit-log',
    label: 'Audit Log',
    title: 'Audit Log',
    icon: ScrollText,
    task: 'P7-T05',
    summary:
      'Read-only, filterable view of every mutation recorded in the immutable append-only audit log — Auditor and Admin roles only.',
    group: 'Data',
    density: 'working',
  },
] as const;
