import { z } from 'zod';

import {
  HUB_NAMES,
  LAB_REGIONS,
  NON_OEM_CATEGORIES,
  OEM_CATEGORIES,
  PROJECT_PRIORITIES,
  PROJECT_TYPES,
  SCHEDULABLE_STATUSES,
  UI_SCHEDULABLE_STATUSES,
  type ProjectCategory,
  type ProjectPriority,
  type ProjectType,
  type WorkflowId,
} from '@/types/enums';

import type {
  AddChamberIn,
  AddEngineerIn,
  AddProjectIn,
  ChamberDowntimeIn,
  ChatScenario,
  RemoveEngineerCountIn,
  ScenarioRequest,
  WhatIfHub,
  WhatIfRegion,
  WhatIfStatus,
} from '../api/whatif-types';

/**
 * Form-side description of a what-if scenario, and its strict zod validation.
 *
 * The limits mirror `backend/schemas/whatif.py` (the server stays the authority:
 * a 422 is still handled). Validation here only decides whether a request may be
 * SENT; it never produces a figure. Lines hold raw strings (like the other
 * Planning forms) and are turned into the request body by `buildScenarioRequest`.
 */

export const MAX_LINES = 30;

/** Caps mirrored from `backend/schemas/whatif.py` (P18-R02, S18-M1). Each is both the
 *  per-line maximum and the maximum of the TOTAL over all lines of one scenario. */
export const CAPS = { projects: 200, designersAdded: 50, designersRemoved: 50, chambers: 20 } as const;

export type CapKey = keyof typeof CAPS;

export interface CapTotal {
  key: CapKey;
  /** Plural noun used in messages, e.g. "projects". */
  noun: string;
  total: number;
  cap: number;
  remaining: number;
  over: boolean;
}

const CAP_NOUN: Record<CapKey, string> = {
  projects: 'projects added',
  designersAdded: 'designers added',
  designersRemoved: 'designers removed',
  chambers: 'chambers added',
};

/** Sum of the whole-number `count` texts of the lines; a blank or invalid count adds nothing
 *  (the line error already shows). This is a form hint, not a result: the server re-checks. */
function sumCounts(lines: readonly { count: string }[]): number {
  let t = 0;
  for (const l of lines) {
    const v = l.count.trim();
    if (/^\d+$/.test(v)) t += Number(v);
  }
  return t;
}

/** Live running totals against the caps. */
export function scenarioTotals(lines: Pick<ScenarioLines, 'projects' | 'engineers' | 'removals' | 'chambers'>): CapTotal[] {
  const raw: Record<CapKey, number> = {
    projects: sumCounts(lines.projects),
    designersAdded: sumCounts(lines.engineers),
    designersRemoved: sumCounts(lines.removals),
    chambers: sumCounts(lines.chambers),
  };
  return (Object.keys(CAPS) as CapKey[]).map((key) => ({
    key,
    noun: CAP_NOUN[key],
    total: raw[key],
    cap: CAPS[key],
    remaining: Math.max(0, CAPS[key] - raw[key]),
    over: raw[key] > CAPS[key],
  }));
}

/** The statuses OFFERED for a hypothetical project (P23-T01: no In Buyoff). The
 *  default is In Queue (`newProjectLine`, the backend default too). The schema
 *  below still accepts every status the backend does (`WhatIfStatus`), so a
 *  scenario the assistant returns with In Buyoff loads and sends unchanged. */
export const WHATIF_STATUSES: readonly WhatIfStatus[] = UI_SCHEDULABLE_STATUSES;

export const OEM_HUBS: readonly string[] = ['OEM-HCK', 'OEM-Seitek'];

/** Categories a hub's workflow accepts (OEM hubs use the -OEM categories). */
export function categoriesForHub(hub: string): readonly ProjectCategory[] {
  return OEM_HUBS.includes(hub) ? OEM_CATEGORIES : NON_OEM_CATEGORIES;
}

// --- draft lines -----------------------------------------------------------------------

export interface ProjectLine {
  key: string;
  hub: WhatIfHub;
  category: ProjectCategory;
  count: string;
  status: WhatIfStatus;
  /** '' = server default (P3). */
  priority: '' | ProjectPriority;
  /** '' = none. */
  projectType: '' | ProjectType;
  /** Used only when no priority is given. '' = none. */
  score: string;
  certification: boolean;
  /** Carried through from a chat scenario; not editable in the form. */
  workflowId: WorkflowId | null;
}

export interface EngineerLine {
  key: string;
  hub: WhatIfHub;
  fte: string;
  count: string;
  /** Carried through from a chat scenario; not editable in the form. */
  allowedCategories: ProjectCategory[] | null;
}

export interface RemovalLine {
  key: string;
  hub: WhatIfHub;
  count: string;
}

export interface ChamberLine {
  key: string;
  labRegion: WhatIfRegion;
  count: string;
  platforms: string;
  efficiency: string;
  maintenance: string;
  breakdown: string;
  calibration: string;
  /** Carried through from a chat scenario; not editable in the form. */
  allowedStages: string[] | null;
}

export interface DowntimeLine {
  key: string;
  chamberId: string;
  maintenance: string;
  breakdown: string;
  calibration: string;
}

export interface ScenarioLines {
  projects: ProjectLine[];
  engineers: EngineerLine[];
  removals: RemovalLine[];
  chambers: ChamberLine[];
  downtime: DowntimeLine[];
}

export type LineListName = keyof ScenarioLines;

// --- field validators ------------------------------------------------------------------

interface NumberRule {
  label: string;
  min: number;
  max: number;
  int?: boolean;
  /** `gt` rather than `ge` against `min`. */
  exclusiveMin?: boolean;
  optional?: boolean;
}

/** A numeric text field -> number (or null when optional and blank). */
function numeric(rule: NumberRule) {
  return z.string().transform((raw, ctx): number | null => {
    const v = raw.trim();
    if (v === '') {
      if (rule.optional) return null;
      ctx.addIssue({ code: 'custom', message: `${rule.label} is required` });
      return z.NEVER;
    }
    if (rule.int ? !/^\d+$/.test(v) : !/^\d+(\.\d+)?$/.test(v)) {
      ctx.addIssue({ code: 'custom', message: rule.int ? 'Enter a whole number' : 'Enter a number' });
      return z.NEVER;
    }
    const n = Number(v);
    if (rule.exclusiveMin ? n <= rule.min : n < rule.min) {
      ctx.addIssue({
        code: 'custom',
        message: rule.exclusiveMin ? `Must be more than ${String(rule.min)}` : `Must be at least ${String(rule.min)}`,
      });
      return z.NEVER;
    }
    if (n > rule.max) {
      ctx.addIssue({ code: 'custom', message: `Must be at most ${String(rule.max)}` });
      return z.NEVER;
    }
    return n;
  });
}

const hubSchema = z.enum(HUB_NAMES);
const regionSchema = z.enum(LAB_REGIONS);

const weeks = (label: string) => numeric({ label, min: 0, max: 52, optional: true });

const projectSchema = z
  .object({
    hub: hubSchema,
    category: z.string(),
    count: numeric({ label: 'Count', min: 1, max: CAPS.projects, int: true }),
    status: z.enum(SCHEDULABLE_STATUSES),
    priority: z.union([z.literal(''), z.enum(PROJECT_PRIORITIES)]),
    projectType: z.union([z.literal(''), z.enum(PROJECT_TYPES)]),
    score: numeric({ label: 'Score', min: 0, max: 100, optional: true }),
  })
  .superRefine((v, ctx) => {
    if (!categoriesForHub(v.hub).some((c) => c === v.category)) {
      ctx.addIssue({
        code: 'custom',
        path: ['category'],
        message: OEM_HUBS.includes(v.hub)
          ? 'OEM hubs use the A-OEM, B-OEM and C-OEM categories'
          : 'This hub uses the A+, A, B and C categories',
      });
    }
  });

const engineerSchema = z.object({
  hub: hubSchema,
  fte: numeric({ label: 'FTE', min: 0, max: 1, exclusiveMin: true }),
  count: numeric({ label: 'Count', min: 1, max: CAPS.designersAdded, int: true }),
});

const removalSchema = z.object({
  hub: hubSchema,
  count: numeric({ label: 'Count', min: 1, max: CAPS.designersRemoved, int: true }),
});

const chamberSchema = z.object({
  labRegion: regionSchema,
  count: numeric({ label: 'Count', min: 1, max: CAPS.chambers, int: true }),
  platforms: numeric({ label: 'Platforms', min: 1, max: 20, int: true, optional: true }),
  efficiency: numeric({ label: 'Efficiency', min: 0, max: 1.5, optional: true }),
  maintenance: weeks('Maintenance weeks'),
  breakdown: weeks('Breakdown weeks'),
  calibration: weeks('Calibration weeks'),
});

const downtimeSchema = z
  .object({
    chamberId: z.string().trim().min(1, 'Choose a chamber').max(64),
    maintenance: weeks('Maintenance weeks'),
    breakdown: weeks('Breakdown weeks'),
    calibration: weeks('Calibration weeks'),
  })
  .superRefine((v, ctx) => {
    if (v.maintenance === null && v.breakdown === null && v.calibration === null) {
      ctx.addIssue({ code: 'custom', path: ['maintenance'], message: 'Enter at least one downtime value' });
    }
  });

// --- building the request ---------------------------------------------------------------

/** field -> message, per line key. */
export type LineErrors = Record<string, Record<string, string>>;

export interface ScenarioValidation {
  /** null when any line is invalid. */
  request: ScenarioRequest | null;
  errors: LineErrors;
  /** Errors not tied to a line (e.g. list length). */
  listErrors: string[];
  /** True when there is no line at all (the zero scenario). */
  empty: boolean;
  /** Running totals against the per-scenario caps. */
  totals: CapTotal[];
}

function collect<L extends { key: string }, T>(
  lines: readonly L[],
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  errors: LineErrors,
  listErrors: string[],
  listLabel: string,
): { parsed: { line: L; value: T }[]; ok: boolean } {
  const parsed: { line: L; value: T }[] = [];
  let ok = true;
  if (lines.length > MAX_LINES) {
    ok = false;
    listErrors.push(`${listLabel}: at most ${String(MAX_LINES)} lines (remove ${String(lines.length - MAX_LINES)}).`);
  }
  for (const line of lines) {
    const result = schema.safeParse(line);
    if (result.success) {
      parsed.push({ line, value: result.data });
    } else {
      ok = false;
      const perField: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const field = String(issue.path[0] ?? '_');
        perField[field] ??= issue.message;
      }
      errors[line.key] = perField;
    }
  }
  return { parsed, ok };
}

export function buildScenarioRequest(lines: ScenarioLines): ScenarioValidation {
  const errors: LineErrors = {};
  const listErrors: string[] = [];

  const projects = collect(lines.projects, projectSchema, errors, listErrors, 'Projects');
  const engineers = collect(lines.engineers, engineerSchema, errors, listErrors, 'Added designers');
  const removals = collect(lines.removals, removalSchema, errors, listErrors, 'Removed designers');
  const chambers = collect(lines.chambers, chamberSchema, errors, listErrors, 'Added chambers');
  const downtime = collect(lines.downtime, downtimeSchema, errors, listErrors, 'Chamber downtime');

  const totals = scenarioTotals(lines);
  for (const t of totals) {
    if (t.over) {
      listErrors.push(
        `At most ${String(t.cap)} ${t.noun} in one scenario (you have ${String(t.total)}). Reduce the counts by ${String(t.total - t.cap)}.`,
      );
    }
  }

  const empty =
    lines.projects.length +
      lines.engineers.length +
      lines.removals.length +
      lines.chambers.length +
      lines.downtime.length ===
    0;
  const ok =
    projects.ok && engineers.ok && removals.ok && chambers.ok && downtime.ok && !totals.some((t) => t.over);
  if (!ok) return { request: null, errors, listErrors, empty, totals };

  const request: ScenarioRequest = {
    add_projects: projects.parsed.map(({ line, value }): AddProjectIn => ({
      hub: value.hub,
      category: value.category as ProjectCategory,
      count: value.count ?? 1,
      project_type: value.projectType === '' ? null : value.projectType,
      status: value.status,
      priority: value.priority === '' ? null : value.priority,
      score: value.score,
      workflow_id: line.workflowId,
      certification_testing_required: line.certification,
    })),
    add_engineers: engineers.parsed.map(({ line, value }): AddEngineerIn => ({
      hub: value.hub,
      fte: value.fte ?? 1,
      count: value.count ?? 1,
      allowed_categories: line.allowedCategories,
    })),
    remove_engineer_counts: removals.parsed.map(({ value }): RemoveEngineerCountIn => ({
      hub: value.hub,
      count: value.count ?? 1,
    })),
    add_chambers: chambers.parsed.map(({ line, value }): AddChamberIn => ({
      lab_region: value.labRegion,
      count: value.count ?? 1,
      platforms: value.platforms,
      efficiency: value.efficiency,
      maintenance_weeks: value.maintenance,
      breakdown_weeks: value.breakdown,
      calibration_weeks: value.calibration,
      allowed_stages: line.allowedStages,
    })),
    chamber_downtime: downtime.parsed.map(({ value }): ChamberDowntimeIn => ({
      chamber_id: value.chamberId.trim(),
      maintenance_weeks: value.maintenance,
      breakdown_weeks: value.breakdown,
      calibration_weeks: value.calibration,
    })),
  };
  return { request, errors, listErrors, empty, totals };
}

// --- chat scenario -> form lines ---------------------------------------------------------

let keyCounter = 0;
export function nextLineKey(): string {
  keyCounter += 1;
  return `line-${String(keyCounter)}`;
}

const str = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(v));

/** The inverse of `buildScenarioRequest` for the shape the chat returns, so
 *  "Edit in builder" loads the assistant's scenario into the form unchanged. */
export function linesFromChatScenario(s: ChatScenario): ScenarioLines {
  return {
    projects: (s.add_projects ?? []).map((p) => ({
      key: nextLineKey(),
      hub: p.hub,
      category: p.category,
      count: str(p.count ?? 1),
      status: p.status ?? 'In Queue',
      priority: p.priority ?? '',
      projectType: p.project_type ?? '',
      score: str(p.score),
      certification: p.certification_testing_required ?? true,
      workflowId: p.workflow_id ?? null,
    })),
    engineers: (s.add_engineers ?? []).map((e) => ({
      key: nextLineKey(),
      hub: e.hub,
      fte: str(e.fte ?? 1),
      count: str(e.count ?? 1),
      allowedCategories: e.allowed_categories ?? null,
    })),
    removals: (s.remove_engineer_counts ?? []).map((r) => ({
      key: nextLineKey(),
      hub: r.hub,
      count: str(r.count ?? 1),
    })),
    chambers: (s.add_chambers ?? []).map((c) => ({
      key: nextLineKey(),
      labRegion: c.lab_region,
      count: str(c.count ?? 1),
      platforms: str(c.platforms),
      efficiency: str(c.efficiency),
      maintenance: str(c.maintenance_weeks),
      breakdown: str(c.breakdown_weeks),
      calibration: str(c.calibration_weeks),
      allowedStages: c.allowed_stages ?? null,
    })),
    downtime: (s.chamber_downtime ?? []).map((d) => ({
      key: nextLineKey(),
      chamberId: d.chamber_id,
      maintenance: str(d.maintenance_weeks),
      breakdown: str(d.breakdown_weeks),
      calibration: str(d.calibration_weeks),
    })),
  };
}

/** Default new line per list. */
export const LINE_FACTORIES: { [K in LineListName]: () => ScenarioLines[K][number] } = {
  projects: () => ({
    key: nextLineKey(),
    hub: 'PD-India',
    category: 'A',
    count: '1',
    status: 'In Queue',
    priority: '',
    projectType: '',
    score: '',
    certification: true,
    workflowId: null,
  }),
  engineers: () => ({ key: nextLineKey(), hub: 'PD-India', fte: '1', count: '1', allowedCategories: null }),
  removals: () => ({ key: nextLineKey(), hub: 'PD-India', count: '1' }),
  chambers: () => ({
    key: nextLineKey(),
    labRegion: 'India',
    count: '1',
    platforms: '',
    efficiency: '',
    maintenance: '',
    breakdown: '',
    calibration: '',
    allowedStages: null,
  }),
  downtime: () => ({ key: nextLineKey(), chamberId: '', maintenance: '', breakdown: '', calibration: '' }),
};

const designerFteSchema = numeric({ label: 'FTE', min: 0, max: 1, exclusiveMin: true });

/** The FTE per designer sent with estimate and fewest-additions (0 < fte <= 1). */
export function parseDesignerFte(raw: string): { value: number; error?: undefined } | { value?: undefined; error: string } {
  const r = designerFteSchema.safeParse(raw);
  if (r.success && r.data !== null) return { value: r.data };
  return { error: r.success ? 'FTE is required' : (r.error.issues[0]?.message ?? 'Enter a valid FTE') };
}
