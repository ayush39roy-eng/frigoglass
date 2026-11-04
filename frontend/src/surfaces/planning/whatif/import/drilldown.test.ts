import { describe, expect, it } from 'vitest';

import { OUTCOME_LABEL } from '../components/outcome-meta';
import {
  bucketDrill,
  bucketKeyOf,
  capacityHubDrill,
  capacityLabDrill,
  changeDrill,
  compareKpiDrill,
  designerDrill,
  drillLabel,
  EXCLUDED_PLAN_REASON,
  execTileDrill,
  listedCount,
  outcomeChangeDrill,
  outcomeDrill,
  projectsInBlock,
  quarterDrill,
  quarterKeyOf,
  reviewTileDrill,
  yearKeyOf,
  type BucketDim,
  type ExecTile,
  type OutcomeKey,
  type ReviewTile,
} from './drilldown';
import { projectsToSchedule } from './import-rows';
import type { Breakdown } from './import-types';
import { COMPARE_KPIS, outcomeChanges } from './scenario-compare';
import { DRILL_RESPONSE, PARSE_RESPONSE, SIMULATE_RESPONSE } from './test-fixtures';

/**
 * P32-R07: for the fixture, EVERY clickable figure's list length equals the figure shown.
 * The one served figure that cannot be reproduced by filtering is `kpis.excluded` ("Not
 * scheduled"): it also counts the not-scheduled plan projects the server does not return
 * (B3), so its list says "N of M shown" instead.
 */

const r = DRILL_RESPONSE;
const KEYS = r.breakdowns?.years.map((y) => y.key) ?? [];
const block = (key: string): Breakdown => {
  const b = r.breakdowns?.by_year[key];
  if (!b) throw new Error(`no block ${key}`);
  return b;
};
const refs = (d: { projects: readonly { ref: string }[] }) => d.projects.map((p) => p.ref);
const DIMS: BucketDim[] = ['by_category', 'by_hub', 'by_priority', 'by_status', 'by_source'];
const OUTCOMES: OutcomeKey[] = ['within_year', 'spillover', 'left_out', 'blocked', 'data_error', 'excluded'];

describe('P32-R07 drill-down selection', () => {
  it('the year blocks follow C1 (placed by finish week, not placed, excluded only under all)', () => {
    expect(KEYS).toEqual(['all', '2026', '2027', 'later', 'not_placed']);
    expect(r.projects.map((p) => yearKeyOf(p, r.base_year))).toEqual([
      '2027',
      'not_placed',
      'later',
      null,
      'not_placed',
      '2026',
      'not_placed',
    ]);
    for (const key of KEYS) expect(projectsInBlock(r, key)).toHaveLength(block(key).total);
    expect(quarterKeyOf(50, 2026)).toBe('2026-Q4');
    expect(quarterKeyOf(67, 2026)).toBe('2027-Q2');
    expect(quarterKeyOf(110, 2026)).toBe('2028-Q1');
    expect(quarterKeyOf(104, 2026)).toBe('2027-Q4');
    expect(bucketKeyOf(r.projects[4]!, 'by_category')).toBe('unknown');
  });

  it('every Executive tile, for every year key, lists exactly its figure', () => {
    const tiles: ExecTile[] = ['total', 'within', 'spillover', 'not_placed', 'file', 'plan', 'before', 'after'];
    for (const key of KEYS) {
      const b = block(key);
      const served: Record<string, number> = {
        total: b.total,
        within: b.outcomes.within_year,
        spillover: b.outcomes.spillover,
        not_placed: key === 'all' ? block('not_placed').total : key === 'not_placed' ? b.total : b.outcomes.left_out,
        file: b.file,
        plan: b.plan,
        before: r.kpis.before_within_plan_year ?? -1,
        after: r.kpis.after_within_plan_year_existing ?? -1,
      };
      for (const t of tiles) {
        const d = execTileDrill(r, key, t);
        expect(d.figure, `${key}/${t}`).toBe(served[t]);
        expect(d.projects, `${key}/${t}`).toHaveLength(d.figure);
        expect(d.shortfall).toBeUndefined();
      }
    }
    expect(refs(execTileDrill(r, 'all', 'before'))).toEqual(['plan-1', 'plan-2']);
    expect(refs(execTileDrill(r, 'all', 'after'))).toEqual(['plan-2']);
    expect(drillLabel(execTileDrill(r, 'all', 'within'))).toBe('Show the 2 projects finishing in 2027');
    expect(drillLabel(execTileDrill(r, '2026', 'total'))).toBe('Show the 1 project finishing in 2026');
  });

  it('"Not scheduled" (kpis.excluded) cannot be reproduced: N of M shown, with the reason', () => {
    const d = execTileDrill(r, 'all', 'excluded');
    expect(d.figure).toBe(3);
    expect(refs(d)).toEqual(['row-7']);
    expect(d.shortfall).toBe(EXCLUDED_PLAN_REASON);
  });

  it('every donut slice / legend chip of every dimension and year lists its bucket total', () => {
    for (const key of KEYS) {
      const b = block(key);
      for (const dim of DIMS) {
        const seen: string[] = [];
        for (const bucket of b[dim]) {
          const d = bucketDrill(r, key, dim, bucket.key);
          expect(d.figure, `${key}/${dim}/${bucket.key}`).toBe(bucket.total);
          expect(d.projects, `${key}/${dim}/${bucket.key}`).toHaveLength(bucket.total);
          seen.push(...refs(d));
        }
        // The buckets partition the block, as the server's Σ buckets = total.
        expect(seen.sort()).toEqual(projectsInBlock(r, key).map((p) => p.ref).sort());
      }
      for (const o of OUTCOMES) {
        const d = outcomeDrill(r, key, o, OUTCOME_LABEL[o]);
        expect(d.projects, `${key}/${o}`).toHaveLength(b.outcomes[o]);
      }
      for (const q of b.by_finish_quarter) {
        const d = quarterDrill(r, key, q.key);
        expect(d.figure).toBe(q.count);
        expect(d.projects, `${key}/${q.key}`).toHaveLength(q.count);
      }
    }
    expect(refs(bucketDrill(r, 'all', 'by_category', 'unknown'))).toEqual(['row-8-2']);
    expect(refs(bucketDrill(r, 'all', 'by_status', 'Commercialized'))).toEqual(['row-7']);
    expect(refs(bucketDrill(r, '2026', 'by_category', 'B'))).toEqual(['plan-2']);
  });

  it('the newly slipping / recovered headers list their served change rows', () => {
    const slip = changeDrill(r, 'newly_slipping', 'Newly slipping out of 2027');
    expect(slip.figure).toBe(r.changes.newly_slipping.length);
    expect(refs(slip)).toEqual(['plan-1']);
    expect(changeDrill(r, 'recovered', 'Recovered').projects).toHaveLength(0);
  });

  it('capacity cells list the projects with work of that kind booked in the window; designers their projects', () => {
    const hub = (h: string, w: string) => refs(capacityHubDrill(r, h, w));
    expect(hub('R&D-Greece', 'y0')).toEqual(['row-5', 'plan-2']);
    expect(hub('R&D-Greece', 'y1')).toEqual(['row-5']);
    expect(hub('PD-India', 'y0')).toEqual(['plan-1']);
    expect(hub('PD-India', 'y1')).toEqual(['plan-1']);
    expect(hub('PD-Romania', 'y0')).toEqual([]);
    const lab = (g: string, w: string) => refs(capacityLabDrill(r, g, w));
    expect(lab('Greece', 'y0')).toEqual(['row-5', 'plan-2']);
    expect(lab('Greece', 'y1')).toEqual(['row-5']);
    expect(lab('India', 'y1')).toEqual(['plan-1']);
    expect(lab('Romania', 'y1')).toEqual([]);
    for (const [h, w] of [['R&D-Greece', 'y0'], ['PD-India', 'y1']] as const) {
      const d = capacityHubDrill(r, h, w);
      expect(d.projects).toHaveLength(d.figure);
    }
    expect(refs(designerDrill(r, 'eng-1', 'Nikos'))).toEqual(['row-5']);
    expect(refs(designerDrill(r, 'eng-2', 'Lokesh'))).toEqual(['plan-1', 'plan-3']);
    expect(refs(designerDrill(r, 'new:1', 'Antonis'))).toEqual(['plan-2']);
  });

  it('every Compare cell lists its figure; "changes outcome" lists every change', () => {
    for (const k of COMPARE_KPIS) {
      const v = k.value(r);
      if (v === null) continue;
      const d = compareKpiDrill(r, k.key, k.label, v, 'Base');
      expect(d.gantt).toBe(false);
      if (k.key === 'excluded') {
        expect(d.projects.length).toBeLessThan(v);
        expect(d.shortfall).toBe(EXCLUDED_PLAN_REASON);
      } else {
        expect(d.projects, k.key).toHaveLength(v);
      }
    }
    const changes = outcomeChanges(r, SIMULATE_RESPONSE);
    const d = outcomeChangeDrill(r, SIMULATE_RESPONSE, changes, ['A', 'B']);
    expect(d.figure).toBe(changes.length);
    expect(d.projects).toHaveLength(changes.length);
    expect(refs(d)).toEqual(['row-7', 'row-8-2', 'plan-2', 'plan-3']);
  });

  it('without breakdowns the served kpis count projects not returned: N of M shown', () => {
    const bare = { ...SIMULATE_RESPONSE, breakdowns: undefined };
    const d = execTileDrill(bare, 'all', 'total');
    expect(d.figure).toBe(240);
    expect(d.projects).toHaveLength(3);
    expect(d.shortfall).toBe(EXCLUDED_PLAN_REASON);
  });

  it('every Review tile lists the rows behind its served count', () => {
    const p = PARSE_RESPONSE;
    const c = p.counts;
    const current = p.rows;
    const figures: Record<ReviewTile, number> = {
      rows: c.rows,
      schedulable: c.schedulable,
      projects: projectsToSchedule(current, true),
      not_scheduled: c.not_scheduled,
      matched: c.matched,
      new: c.new,
      auto_assign: current.filter((x) => x.include && x.leader.kind === 'auto').length,
      new_designers: c.new_designers,
      not_a_project: c.not_a_project,
    };
    for (const [tile, figure] of Object.entries(figures) as [ReviewTile, number][]) {
      const d = reviewTileDrill(p, current, tile, { figure, expandMulti: true, servedProjects: false });
      expect(listedCount(d), tile).toBe(figure);
      expect(d.shortfall).toBeUndefined();
    }
    const designers = reviewTileDrill(p, current, 'new_designers', { figure: 1, expandMulti: true, servedProjects: false });
    expect(designers.note).toBe('1 new designer named on 1 row');
  });

  it('"Projects to schedule" lists one line per copy of a Num of Projects row', () => {
    const rows = PARSE_RESPONSE.rows.map((x, i) => (i === 1 ? { ...x, num_projects: 3 } : x));
    const figure = projectsToSchedule(rows, true);
    const d = reviewTileDrill(PARSE_RESPONSE, rows, 'projects', { figure, expandMulti: true, servedProjects: false });
    expect(figure).toBe(5);
    expect(d.rows).toHaveLength(5);
    expect(d.rows.map((x) => x.copy)).toEqual([null, '1/3', '2/3', '3/3', null]);
  });
});
