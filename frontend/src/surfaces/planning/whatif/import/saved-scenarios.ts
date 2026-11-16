import { buildSimulateRequest, editKey, type EditMap, type ImportOptions } from './import-rows';
import type { ImportSource, ImportState, ScenarioView } from './import-store';
import type { ImportSimulateRequest, PlanYearEndWeek, SavedScenario, SavedScenarioSummary } from './import-types';
import type { ImportScenario, NewScenario, StoredMeta } from './scenarios-store';

/**
 * P41 (ADR 0055 D3 / D4): plumbing between a server-saved scenario and the session's
 * stores. Every figure stays the stored, served response; nothing here derives one.
 */

export const MAX_SAVED_NAME = 120;
export const MAX_SAVED_NOTE = 1000;

export function optionsOf(request: ImportSimulateRequest): ImportOptions {
  return {
    mode: request.mode,
    planYearEndWeek: request.plan_year_end_week as PlanYearEndWeek,
    expandMulti: request.expand_multi,
  };
}

export function editMapOf(request: ImportSimulateRequest): EditMap {
  return Object.fromEntries(request.edits.map((e) => [editKey(e.project_ref, e.step_id), { ...e }]));
}

export function sourceOf(s: SavedScenarioSummary): ImportSource {
  return { file_name: s.source_file_name, sha256: s.source_file_sha256, imported_at: s.imported_at };
}

export function storedMetaOf(s: SavedScenarioSummary): StoredMeta {
  return {
    id: s.id,
    sourceSha256: s.source_file_sha256,
    simulatedWeek: s.simulated_week,
    planVersion: s.plan_version,
    createdByName: s.created_by_name,
    createdAt: s.created_at,
    canEdit: s.can_edit,
  };
}

/** A saved scenario as an entry of the Compare list (its stored request and response). */
export function storedEntryOf(s: SavedScenario): NewScenario & { stored: StoredMeta } {
  return {
    name: s.name,
    origin: 'stored',
    rules: s.note,
    fileName: s.source_file_name,
    rows: s.request.rows,
    options: optionsOf(s.request),
    edits: editMapOf(s.request),
    excludedPlanIds: s.request.exclude_plan_project_ids ?? [],
    response: s.result,
    stored: storedMetaOf(s),
  };
}

/** The read-only view of a saved scenario on the results. */
export function savedViewOf(s: SavedScenario): ScenarioView {
  return {
    kind: 'saved',
    id: s.id,
    name: s.name,
    result: s.result,
    request: s.request,
    simulated_week: s.simulated_week,
    plan_version: s.plan_version,
    source: sourceOf(s),
    can_edit: s.can_edit,
  };
}

/** The request a session scenario was computed from. */
export function sessionRequestOf(s: ImportScenario): ImportSimulateRequest {
  return buildSimulateRequest(s.rows, s.options, s.edits, s.excludedPlanIds ?? []);
}

export function sessionViewOf(s: ImportScenario): ScenarioView {
  return { kind: 'session', id: s.id, name: s.name, result: s.response, request: sessionRequestOf(s) };
}

export interface SourceGroup {
  key: string;
  fileName: string;
  importedAt: string;
  items: SavedScenarioSummary[];
}

/**
 * The library's groups: one per source file (its sha) and import date, in the served
 * newest-first order of their first scenario; scenarios keep the served order.
 */
export function groupBySource(items: readonly SavedScenarioSummary[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const s of items) {
    const key = `${s.source_file_sha256}|${s.imported_at.slice(0, 10)}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, fileName: s.source_file_name, importedAt: s.imported_at, items: [] };
      groups.set(key, g);
    }
    g.items.push(s);
  }
  return [...groups.values()];
}

/** "Saved scenario — simulated W47 against plan v14". */
export function savedBannerTitle(simulatedWeek: number, planVersion: number | null): string {
  const plan = planVersion === null ? '' : ` against plan v${String(planVersion)}`;
  return `Saved scenario — simulated W${String(simulatedWeek)}${plan}`;
}

/** The request behind what the results show (a view's own, else the session's). */
export function currentRequest(st: Pick<ImportState, 'view' | 'rows' | 'options' | 'edits' | 'excludedPlanIds'>): ImportSimulateRequest {
  if (st.view) return st.view.request;
  return buildSimulateRequest(st.rows, st.options, st.edits, st.excludedPlanIds);
}
