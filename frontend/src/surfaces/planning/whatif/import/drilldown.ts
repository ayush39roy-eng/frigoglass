import { formatInteger } from '@/lib/format';
import { HUB_COUNTRY } from '@/surfaces/dashboard/lib/hub-geo';

import type { WhatIfOutcome } from '../../api/whatif-types';
import { bucketLabel } from './bucket-label';
import { capacityHubOf, copiesOfRow, isMappedStatus } from './import-rows';
import type {
  Breakdown,
  ImportParseIssue,
  ImportParseResponse,
  ImportResultProject,
  ImportRow,
  ImportSimulateResponse,
} from './import-types';
import { planYearOf } from './week-labels';
import { breakdownFor, NOT_PLACED_OUTCOMES, YEAR_ALL, YEAR_LATER, YEAR_NOT_PLACED, yearOptions } from './year-filter';

/**
 * Drill-down selection (P32-R07, owner 2026-11-05: "ALL the numbers should be clickable and it
 * should show which projects"). One function per clickable figure: it takes the figure the
 * page shows (a served field) and FILTERS the served `projects` (or the served parse `rows`)
 * by served fields to the list behind it. Nothing here counts for display; the list length is
 * compared with the served figure only to say "N of M shown" when the server counts projects
 * it does not return (docs/API_CONTRACT_P32.md B3 / C1).
 *
 * The year blocks, `not_placed` and the "unknown" bucket follow the server's breakdown rules
 * (`services/whatif_import.py` `breakdown_year_key` / `_buckets` / `finish_quarter`, C1):
 * - a placed project (within_year / spillover with a finish week) is in `<base>` for weeks
 *   1..52, `<base + 1>` for 53..104 and `later` beyond;
 * - left_out / blocked / data_error are `not_placed`;
 * - excluded file rows are only in `all`;
 * - a missing dimension value is the `unknown` bucket.
 */

const WEEKS_PER_YEAR = 52;
const QUARTER_WEEKS = 13;
const PLACED: ReadonlySet<WhatIfOutcome> = new Set(['within_year', 'spillover']);
export const UNKNOWN_BUCKET = 'unknown';

/** Why a list can be shorter than its served figure. */
export const SCOPE_REASON = 'others are outside your hub scope';
export const EXCLUDED_PLAN_REASON =
  'the other plan projects that are not scheduled (on hold, cancelled, commercialized) are counted but not listed by the planner';

export interface ProjectDrill {
  kind: 'projects';
  /** "Finish in 2027" — the figure's name; the sheet adds " · N projects". */
  title: string;
  /** The context of the figure ("Year: Finish in 2027", the scenario name), optional. */
  context?: string | undefined;
  /** The number the page shows (a served field). */
  figure: number;
  projects: readonly ImportResultProject[];
  baseYear: number;
  /** Set when the list is shorter than the figure: the reason ("others are outside your hub scope"). */
  shortfall?: string | undefined;
  /** The rows belong to the current result, so "Show on Gantt" applies. */
  gantt: boolean;
  /** Words after "Show the N projects …" ("finishing in 2027"). */
  phrase: string;
}

/** One entry of a parse-row drill: a file row (or, for "Projects to schedule", one copy of it). */
export interface DrillRow {
  id: string;
  row: ImportRow;
  /** "2/5" for copy k of a row with Num of Projects n (P32-R03), else null. */
  copy: string | null;
  issues: readonly ImportParseIssue[];
}

export interface RowDrill {
  kind: 'rows';
  title: string;
  context?: string | undefined;
  figure: number;
  rows: readonly DrillRow[];
  /** The noun the figure counts ("rows", "projects", "new designers"). */
  unit: string;
  /** Set when the figure does not count the rows one by one ("1 designer named on 2 rows"). */
  note?: string | undefined;
  shortfall?: string | undefined;
  phrase: string;
}

export type Drill = ProjectDrill | RowDrill;

/** The served list length against the served figure (no other arithmetic). */
function shortfallOf(listed: number, figure: number, reason: string): string | undefined {
  return listed < figure ? reason : undefined;
}

function projectDrill(
  result: ImportSimulateResponse,
  title: string,
  figure: number,
  projects: readonly ImportResultProject[],
  phrase: string,
  opts: { context?: string | undefined; reason?: string; gantt?: boolean } = {},
): ProjectDrill {
  return {
    kind: 'projects',
    title,
    context: opts.context,
    figure,
    projects,
    baseYear: result.base_year,
    shortfall: shortfallOf(projects.length, figure, opts.reason ?? SCOPE_REASON),
    gantt: opts.gantt ?? true,
    phrase,
  };
}

/** "Show the 197 projects finishing in 2027" — the figure button's accessible name. */
export function drillAriaLabel(figure: number, noun: string, phrase: string): string {
  const unit = figure === 1 ? noun.replace(/s$/, '') : noun;
  return `Show the ${formatInteger(figure)} ${unit} ${phrase}`.trim();
}

/** The accessible name of a figure button ("Show the 197 projects finishing in 2027"). */
export function drillLabel(d: Drill): string {
  return drillAriaLabel(d.figure, d.kind === 'projects' ? 'projects' : d.unit, d.phrase);
}

// --- year blocks (C1) --------------------------------------------------------------------

/** The served year block of a project besides `all` (C1 `breakdown_year_key`), or null. */
export function yearKeyOf(p: Pick<ImportResultProject, 'outcome' | 'finish_week'>, baseYear: number): string | null {
  if (NOT_PLACED_OUTCOMES.has(p.outcome)) return YEAR_NOT_PLACED;
  if (!PLACED.has(p.outcome) || p.finish_week === null) return null;
  if (p.finish_week <= WEEKS_PER_YEAR) return String(baseYear);
  if (p.finish_week <= 2 * WEEKS_PER_YEAR) return String(baseYear + 1);
  return YEAR_LATER;
}

/** The served projects of a year block (`all` = every served project). */
export function projectsInBlock(result: ImportSimulateResponse, key: string): ImportResultProject[] {
  if (key === YEAR_ALL) return [...result.projects];
  return result.projects.filter((p) => yearKeyOf(p, result.base_year) === key);
}

function yearLabel(result: ImportSimulateResponse, key: string): string {
  return yearOptions(result).find((o) => o.key === key)?.label ?? 'All projects';
}

function yearContext(result: ImportSimulateResponse, key: string): string | undefined {
  return key === YEAR_ALL ? undefined : `Year: ${yearLabel(result, key)}`;
}

/** "finishing in 2026", "finishing after 2027", "not placed" (the Year filter's words). */
function yearPhrase(result: ImportSimulateResponse, key: string): string {
  if (key === YEAR_NOT_PLACED) return 'not placed';
  if (key === YEAR_LATER) return `finishing after ${String(result.base_year + 1)}`;
  return `finishing in ${key}`;
}

function planYear(result: ImportSimulateResponse): number {
  return planYearOf(result.plan_year_end_week, result.base_year);
}

// --- Executive tiles ---------------------------------------------------------------------

export type ExecTile = 'total' | 'within' | 'spillover' | 'not_placed' | 'file' | 'plan' | 'excluded' | 'before' | 'after';

/**
 * The Executive KPI tile: its served figure (the block for the Year filter, else the served
 * kpis, as the tab has shown since P32-R05) and the projects behind it.
 */
export function execTileDrill(result: ImportSimulateResponse, key: string, tile: ExecTile): ProjectDrill {
  const k = result.kpis;
  const block: Breakdown | null = breakdownFor(result, key);
  const inBlock = block ? projectsInBlock(result, key) : [...result.projects];
  const year = planYear(result);
  const context = block ? yearContext(result, key) : undefined;
  const of = (outcome: WhatIfOutcome) => inBlock.filter((p) => p.outcome === outcome);
  const plan = result.projects.filter((p) => p.source === 'plan');
  switch (tile) {
    case 'total':
      return projectDrill(
        result,
        key === YEAR_ALL || !block ? 'Projects scheduled' : yearLabel(result, key),
        block ? block.total : k.projects_total,
        inBlock,
        key === YEAR_ALL || !block ? 'scheduled' : yearPhrase(result, key),
        { context, reason: block ? SCOPE_REASON : EXCLUDED_PLAN_REASON },
      );
    case 'within':
      return projectDrill(
        result,
        `Finish in ${String(year)}`,
        block ? block.outcomes.within_year : k.within_plan_year,
        of('within_year'),
        `finishing in ${String(year)}`,
        { context },
      );
    case 'spillover':
      return projectDrill(
        result,
        'Spill over',
        block ? block.outcomes.spillover : k.spillover,
        of('spillover'),
        `spilling over past ${String(year)}`,
        { context },
      );
    case 'not_placed': {
      // As the tile (P32-R05): All → the served `not_placed` block total; Not placed → its
      // total; a finish-year block holds placed projects only → its served `left_out` (0).
      if (block === null) return projectDrill(result, 'Not placed', k.left_out, of('left_out'), 'not placed');
      if (key === YEAR_ALL) {
        const np = breakdownFor(result, YEAR_NOT_PLACED);
        return np
          ? projectDrill(result, 'Not placed', np.total, projectsInBlock(result, YEAR_NOT_PLACED), 'not placed')
          : projectDrill(result, 'Not placed', block.outcomes.left_out, of('left_out'), 'not placed');
      }
      if (key === YEAR_NOT_PLACED) return projectDrill(result, 'Not placed', block.total, inBlock, 'not placed');
      return projectDrill(result, 'Not placed', block.outcomes.left_out, of('left_out'), 'not placed', { context });
    }
    case 'file':
      return projectDrill(
        result,
        'From the file',
        block ? block.file : k.file_projects,
        inBlock.filter((p) => p.source === 'file'),
        'from the file',
        { context },
      );
    case 'plan':
      return projectDrill(
        result,
        'From the plan',
        block ? block.plan : k.plan_projects,
        inBlock.filter((p) => p.source === 'plan'),
        'from the plan',
        { context, reason: block ? SCOPE_REASON : EXCLUDED_PLAN_REASON },
      );
    case 'excluded':
      return projectDrill(
        result,
        'Not scheduled',
        k.excluded,
        result.projects.filter((p) => p.outcome === 'excluded'),
        'not scheduled',
        { reason: EXCLUDED_PLAN_REASON },
      );
    case 'before':
      return projectDrill(
        result,
        `Plan projects in ${String(year)} before the import`,
        k.before_within_plan_year ?? 0,
        plan.filter((p) => p.before_outcome === 'within_year'),
        `of the plan finishing in ${String(year)} before the import`,
      );
    case 'after':
      return projectDrill(
        result,
        `Plan projects in ${String(year)} after the import`,
        k.after_within_plan_year_existing ?? 0,
        plan.filter((p) => p.outcome === 'within_year'),
        `of the plan finishing in ${String(year)} after the import`,
      );
  }
}

// --- donuts ------------------------------------------------------------------------------

export type BucketDim = 'by_category' | 'by_hub' | 'by_priority' | 'by_status' | 'by_source';

const DIM_FIELD: Record<BucketDim, 'category' | 'hub' | 'priority' | 'status' | 'source'> = {
  by_category: 'category',
  by_hub: 'hub',
  by_priority: 'priority',
  by_status: 'status',
  by_source: 'source',
};

const DIM_WORDS: Record<BucketDim, string> = {
  by_category: 'category',
  by_hub: 'hub',
  by_priority: 'priority',
  by_status: 'status',
  by_source: 'source',
};

/** The bucket key a project falls in for a dimension (`unknown` for a missing value, C1). */
export function bucketKeyOf(p: ImportResultProject, dim: BucketDim): string {
  const v = p[DIM_FIELD[dim]] as string | null | undefined;
  return v === null || v === undefined || v === '' ? UNKNOWN_BUCKET : v;
}

/** A donut slice / legend chip: the bucket's served `total` and its projects in the block. */
export function bucketDrill(result: ImportSimulateResponse, key: string, dim: BucketDim, bucket: string): ProjectDrill {
  const served = breakdownFor(result, key)?.[dim].find((b) => b.key === bucket);
  const label = bucketLabel(bucket);
  return projectDrill(
    result,
    `${DIM_WORDS[dim][0]?.toUpperCase() ?? ''}${DIM_WORDS[dim].slice(1)} ${label}`,
    served?.total ?? 0,
    projectsInBlock(result, key).filter((p) => bucketKeyOf(p, dim) === bucket),
    `with ${DIM_WORDS[dim]} ${label}`,
    { context: yearContext(result, key) },
  );
}

export type OutcomeKey = keyof Breakdown['outcomes'];

/** An Outcome donut slice: the block's served outcome count and its projects. */
export function outcomeDrill(
  result: ImportSimulateResponse,
  key: string,
  outcome: OutcomeKey,
  label: string,
): ProjectDrill {
  return projectDrill(
    result,
    label,
    breakdownFor(result, key)?.outcomes[outcome] ?? 0,
    projectsInBlock(result, key).filter((p) => p.outcome === outcome),
    `with outcome ${label}`,
    { context: yearContext(result, key) },
  );
}

/** The served quarter key of an absolute finish week (C1 `finish_quarter`: "2027-Q2"). */
export function quarterKeyOf(week: number, baseYear: number): string {
  const offset = Math.floor((week - 1) / WEEKS_PER_YEAR);
  const inYear = (week - 1) % WEEKS_PER_YEAR;
  return `${String(baseYear + offset)}-Q${String(Math.min(Math.floor(inYear / QUARTER_WEEKS) + 1, 4))}`;
}

/** A "Finishes per quarter" bar: the served count and the placed projects finishing in it. */
export function quarterDrill(result: ImportSimulateResponse, key: string, quarter: string): ProjectDrill {
  const served = breakdownFor(result, key)?.by_finish_quarter.find((q) => q.key === quarter);
  const label = served?.label ?? quarter;
  return projectDrill(
    result,
    `Finish in ${label}`,
    served?.count ?? 0,
    projectsInBlock(result, key).filter(
      (p) => PLACED.has(p.outcome) && p.finish_week !== null && quarterKeyOf(p.finish_week, result.base_year) === quarter,
    ),
    `finishing in ${label}`,
    { context: yearContext(result, key) },
  );
}

/** The newly-slipping / recovered list header: the served change rows' projects, by ref. */
export function changeDrill(
  result: ImportSimulateResponse,
  kind: 'newly_slipping' | 'recovered',
  title: string,
): ProjectDrill {
  const refs = new Set(result.changes[kind].map((c) => c.ref));
  const year = planYear(result);
  return projectDrill(
    result,
    title,
    result.changes[kind].length,
    result.projects.filter((p) => refs.has(p.ref)),
    kind === 'newly_slipping' ? `slipping out of ${String(year)}` : `moving into ${String(year)}`,
  );
}

// --- Capacity ----------------------------------------------------------------------------

/** Steps of `kind` the served schedule books with weeks inside [from, to]. */
function booksIn(p: ImportResultProject, kind: 'design' | 'lab', from: number, to: number): boolean {
  if (p.outcome === 'excluded' || p.data_error !== null) return false;
  return p.steps.some(
    (s) =>
      s.kind === kind &&
      !s.skipped &&
      !s.done_before_import &&
      s.start_week !== null &&
      s.end_week !== null &&
      s.start_week <= to &&
      s.end_week >= from,
  );
}

/** The lab region a hub's lab steps book (DOMAIN_RULES "Hubs and lab-region mapping"). */
export function labRegionOfHub(hub: string): string | null {
  return (HUB_COUNTRY as Record<string, string | undefined>)[hub] ?? null;
}

/**
 * A capacity cell (hub × window): projects whose design work for that capacity hub is booked
 * in the window. The cell shows served load weeks, not a project count, so there is no
 * figure to match; the sheet shows the list's own length.
 */
export function capacityHubDrill(result: ImportSimulateResponse, hub: string, windowKey: string): ProjectDrill {
  const w = result.capacity.windows.find((x) => x.key === windowKey);
  const projects = w
    ? result.projects.filter((p) => (p.capacity_hub || capacityHubOf(p.hub)) === hub && booksIn(p, 'design', w.from_week, w.to_week))
    : [];
  return projectDrill(result, `${hub} design work in ${w?.label ?? windowKey}`, projects.length, projects, `with design work booked for ${hub} in ${w?.label ?? windowKey}`);
}

/** A lab-region cell (region × window): projects with lab steps booked in that region in the window. */
export function capacityLabDrill(result: ImportSimulateResponse, region: string, windowKey: string): ProjectDrill {
  const w = result.capacity.windows.find((x) => x.key === windowKey);
  const projects = w
    ? result.projects.filter((p) => labRegionOfHub(p.hub) === region && booksIn(p, 'lab', w.from_week, w.to_week))
    : [];
  return projectDrill(result, `${region} lab work in ${w?.label ?? windowKey}`, projects.length, projects, `with lab work booked in ${region} in ${w?.label ?? windowKey}`);
}

/** A designer row: the projects that designer leads in the run (served `leader_ref`). */
export function designerDrill(result: ImportSimulateResponse, ref: string, name: string): ProjectDrill {
  const projects = result.projects.filter((p) => p.leader_ref === ref);
  return projectDrill(result, `Led by ${name}`, projects.length, projects, `led by ${name}`);
}

// --- Compare -----------------------------------------------------------------------------

/**
 * A Compare key-figure cell: that scenario's projects behind the figure, by the same served
 * field as `COMPARE_KPIS` (`scenario-compare.ts`). Not for the current result's Gantt.
 */
export function compareKpiDrill(
  response: ImportSimulateResponse,
  kpiKey: string,
  label: string,
  figure: number,
  scenarioName: string,
): ProjectDrill {
  const all = response.projects;
  const served = breakdownFor(response, YEAR_ALL) !== null;
  const outcome = (o: WhatIfOutcome) => all.filter((p) => p.outcome === o);
  let projects: readonly ImportResultProject[];
  let reason = SCOPE_REASON;
  switch (kpiKey) {
    case 'projects_scheduled':
      projects = all;
      if (!served) reason = EXCLUDED_PLAN_REASON;
      break;
    case 'within_plan_year':
      projects = outcome('within_year');
      break;
    case 'spillover':
      projects = outcome('spillover');
      break;
    case 'not_placed':
      projects = served ? all.filter((p) => NOT_PLACED_OUTCOMES.has(p.outcome)) : outcome('left_out');
      break;
    case 'file_projects':
      projects = all.filter((p) => p.source === 'file');
      break;
    case 'plan_projects':
      projects = all.filter((p) => p.source === 'plan');
      if (!served) reason = EXCLUDED_PLAN_REASON;
      break;
    case 'excluded':
      projects = outcome('excluded');
      reason = EXCLUDED_PLAN_REASON;
      break;
    case 'left_out':
    case 'blocked':
    case 'data_error':
      projects = outcome(kpiKey);
      break;
    case 'newly_slipping': {
      const refs = new Set(response.changes.newly_slipping.map((c) => c.ref));
      projects = all.filter((p) => refs.has(p.ref));
      break;
    }
    default:
      projects = [];
  }
  return projectDrill(response, label, figure, projects, `${label.toLowerCase()} in ${scenarioName}`, {
    context: `Scenario: ${scenarioName}`,
    reason,
    gantt: false,
  });
}

/** "N projects change outcome" between two scenarios: each change's project (B's row, else A's). */
export function outcomeChangeDrill(
  a: ImportSimulateResponse,
  b: ImportSimulateResponse,
  changes: readonly { ref: string }[],
  names: [string, string],
): ProjectDrill {
  const byRefA = new Map(a.projects.map((p) => [p.ref, p]));
  const byRefB = new Map(b.projects.map((p) => [p.ref, p]));
  const projects = changes.flatMap((c) => {
    const p = byRefB.get(c.ref) ?? byRefA.get(c.ref);
    return p ? [p] : [];
  });
  return projectDrill(b, 'Change outcome', changes.length, projects, `that change outcome from ${names[0]} to ${names[1]}`, {
    context: `${names[0]} → ${names[1]} (outcome and finish shown for ${names[1]})`,
    gantt: false,
  });
}

// --- Review (parse rows) -----------------------------------------------------------------

export type ReviewTile =
  | 'rows'
  | 'schedulable'
  | 'projects'
  | 'not_scheduled'
  | 'matched'
  | 'new'
  | 'auto_assign'
  | 'new_designers'
  | 'not_a_project';

function issuesOf(parsed: ImportParseResponse): Map<string, ImportParseIssue[]> {
  const m = new Map<string, ImportParseIssue[]>();
  for (const i of parsed.issues) {
    if (i.row_key === null) continue;
    m.set(i.row_key, [...(m.get(i.row_key) ?? []), i]);
  }
  return m;
}

function entries(rows: readonly ImportRow[], issues: Map<string, ImportParseIssue[]>): DrillRow[] {
  return rows.map((row) => ({ id: row.key, row, copy: null, issues: issues.get(row.key) ?? [] }));
}

/** One entry per project a row becomes ("Num of Projects" n ≥ 2 → n copies, P32-R03). */
function copyEntries(rows: readonly ImportRow[], expand: boolean, issues: Map<string, ImportParseIssue[]>): DrillRow[] {
  return rows.flatMap((row): DrillRow[] => {
    const n = copiesOfRow(row, expand);
    if (n === 1) return [{ id: row.key, row, copy: null, issues: issues.get(row.key) ?? [] }];
    return Array.from({ length: n }, (_, i) => ({
      id: `${row.key}-${String(i + 1)}`,
      row,
      copy: `${String(i + 1)}/${String(n)}`,
      issues: issues.get(row.key) ?? [],
    }));
  });
}

/** The distinct new designers named on rows (the parse's (name, capacity hub) rule). */
export function newDesignerKeys(rows: readonly ImportRow[]): Set<string> {
  return new Set(
    rows.flatMap((r) =>
      r.leader.kind === 'new' ? [`${r.leader.name.trim().toLowerCase()}|${capacityHubOf(r.hub)}`] : [],
    ),
  );
}

/**
 * A Review count tile. The served parse counts (`counts.*`) are over the rows AS PARSED, so they
 * filter `parsed.rows`; "Projects to schedule" and "Auto-assign" show the planner's current
 * rows (`current`, with `servedProjects` telling which figure the tile shows), as the tiles do.
 */
export function reviewTileDrill(
  parsed: ImportParseResponse,
  current: readonly ImportRow[],
  tile: ReviewTile,
  opts: { figure: number; expandMulti: boolean; servedProjects: boolean },
): RowDrill {
  const issues = issuesOf(parsed);
  const served = parsed.rows;
  const make = (
    title: string,
    rows: DrillRow[],
    phrase: string,
    extra: Partial<Pick<RowDrill, 'unit' | 'note' | 'context'>> = {},
  ): RowDrill => {
    const d: RowDrill = {
      kind: 'rows',
      title,
      figure: opts.figure,
      rows,
      unit: extra.unit ?? 'rows',
      note: extra.note,
      context: extra.context,
      phrase,
    };
    return { ...d, shortfall: shortfallOf(listedCount(d), opts.figure, SCOPE_REASON) };
  };
  const asParsed = 'As read from the file';
  switch (tile) {
    case 'rows':
      return make('Rows', entries(served, issues), 'in the file', { context: asParsed });
    case 'schedulable':
      return make('Schedulable', entries(served.filter((r) => isMappedStatus(r.status)), issues), 'that can be scheduled', {
        context: asParsed,
      });
    case 'not_scheduled':
      return make('Not scheduled', entries(served.filter((r) => !isMappedStatus(r.status)), issues), 'not scheduled', {
        context: `${asParsed} · on hold or finished`,
      });
    case 'matched':
      return make('Matched to plan', entries(served.filter((r) => r.matched_project_id !== null), issues), 'matched to the plan', {
        context: asParsed,
      });
    case 'new':
      return make('New projects', entries(served.filter((r) => r.matched_project_id === null), issues), 'new to the plan', {
        context: asParsed,
      });
    case 'not_a_project': {
      const keys = new Set(parsed.issues.filter((i) => i.code === 'NOT_A_PROJECT').map((i) => i.row_key));
      return make('Budget lines', entries(served.filter((r) => keys.has(r.key)), issues), 'that look like budget lines', {
        context: asParsed,
      });
    }
    case 'new_designers': {
      const named = served.filter((r) => r.leader.kind === 'new');
      return make('New designers', entries(named, issues), 'named as new designers', {
        context: asParsed,
        unit: 'new designers',
        note: `${formatInteger(newDesignerKeys(named).size)} new designer${newDesignerKeys(named).size === 1 ? '' : 's'} named on ${formatInteger(named.length)} row${named.length === 1 ? '' : 's'}`,
      });
    }
    case 'auto_assign':
      return make(
        'Auto-assign',
        entries(current.filter((r) => r.include && isMappedStatus(r.status) && r.leader.kind === 'auto'), issues),
        'to schedule with no engineer',
      );
    case 'projects': {
      const source = opts.servedProjects ? served : current;
      return make(
        'Projects to schedule',
        copyEntries(source.filter((r) => r.include && isMappedStatus(r.status)), opts.expandMulti, issues),
        'to schedule',
        { unit: 'projects', context: opts.expandMulti ? '“Num of Projects” counted: one line per copy' : undefined },
      );
    }
  }
}

/** The number of list entries a figure is compared with (designers for "New designers"). */
export function listedCount(d: Drill): number {
  if (d.kind === 'projects') return d.projects.length;
  if (d.unit === 'new designers') return newDesignerKeys(d.rows.map((r) => r.row)).size;
  return d.rows.length;
}
