import * as React from 'react';
import { BarChart3, Check, GitCompareArrows, Gauge, Info, Layers, Pencil, Star, Trash2, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { BarChart } from '@/components/ui/bar-chart';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBookedPct } from '@/lib/format';
import { cn } from '@/lib/utils';

import { int } from '../../components/figures';
import { NativeSelect } from '../../components/form-controls';
import { OUTCOME_LABEL, OUTCOME_TONE } from '../../components/outcome-meta';
import { Callout, ProjectRowsTable, type RowColumn } from '../../components/result-parts';
import {
  capacityCompare,
  COMPARE_KPIS,
  delta,
  formatDelta,
  outcomeChanges,
  type OutcomeChange,
} from '../scenario-compare';
import { MAX_COMPARE, MAX_SCENARIO_NAME, useImportScenarios, type ImportScenario } from '../scenarios-store';
import { planYearOf, weekOrDash } from '../week-labels';
import { FeatureCard } from './feature-card';
import { ServedStatusChip } from './status-chip';

/**
 * Results → Compare (P32-R05 C2): the session's saved scenarios side by side. Every figure
 * is a served field of a saved response; the delta column is the difference of two served
 * figures, and "projects that change outcome" matches served rows by ref.
 */

function ScenarioMeta({ s }: { s: ImportScenario }): React.JSX.Element {
  const year = planYearOf(s.response.plan_year_end_week, s.response.base_year);
  return (
    <span className="flex flex-wrap items-center gap-1 text-2xs text-text-muted">
      <Badge tone={s.origin === 'variant' ? 'primary' : 'neutral'}>{s.origin === 'variant' ? 'variant' : 'saved'}</Badge>
      <span>{s.response.mode === 'merge' ? 'merged with plan' : 'file only'}</span>
      <span aria-hidden="true">·</span>
      <span>plan year {String(year)}</span>
      {s.rules ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 break-words">{s.rules}</span>
        </>
      ) : null}
    </span>
  );
}

function ScenarioItem({ s, position }: { s: ImportScenario; position: number }): React.JSX.Element {
  const compareIds = useImportScenarios((st) => st.compareIds);
  const toggle = useImportScenarios((st) => st.toggleCompare);
  const rename = useImportScenarios((st) => st.rename);
  const remove = useImportScenarios((st) => st.remove);
  const makeBaseline = useImportScenarios((st) => st.makeBaseline);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(s.name);
  const checked = compareIds.includes(s.id);
  const full = !checked && compareIds.length >= MAX_COMPARE;
  const id = `scn-${s.id}`;
  return (
    <li
      className="flex flex-wrap items-start gap-s3 rounded-md border border-border px-s3 py-s2"
      data-testid="import-scenario"
      data-scenario={s.name}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={full}
        onCheckedChange={() => toggle(s.id)}
        aria-label={`Compare ${s.name}`}
        className="mt-1"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        {editing ? (
          <form
            className="flex flex-wrap items-center gap-s2"
            onSubmit={(e) => {
              e.preventDefault();
              rename(s.id, draft);
              setEditing(false);
            }}
          >
            <Input
              aria-label={`New name for ${s.name}`}
              className="h-8 w-56 max-w-full"
              value={draft}
              maxLength={MAX_SCENARIO_NAME}
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button type="submit" size="sm" variant="secondary" disabled={draft.trim() === ''} aria-label="Save name">
              <Check />
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} aria-label="Cancel rename">
              <X />
            </Button>
          </form>
        ) : (
          <Label htmlFor={id} className="flex flex-wrap items-center gap-s2 text-sm font-semibold text-text">
            {s.name}
            {position === 0 ? <Badge tone="success">baseline</Badge> : null}
          </Label>
        )}
        <ScenarioMeta s={s} />
      </div>
      <div className="flex items-center gap-1">
        {checked && position > 0 ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => makeBaseline(s.id)} aria-label={`Make ${s.name} the baseline`}>
            <Star />
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(s.name);
            setEditing(true);
          }}
          aria-label={`Rename ${s.name}`}
        >
          <Pencil />
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => remove(s.id)} aria-label={`Delete ${s.name}`}>
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

function KpiTable({ picked }: { picked: ImportScenario[] }): React.JSX.Element {
  const base = picked[0];
  // "Finish in 2027" as on the Executive tab when every scenario has the same plan year.
  const years = new Set(picked.map((s) => planYearOf(s.response.plan_year_end_week, s.response.base_year)));
  const planYear = years.size === 1 ? ([...years][0] ?? null) : null;
  return (
    <Table aria-label="Scenario figures" scrollLabel="Scenario figures">
      <TableHeader>
        <TableRow>
          <TableHead>Figure</TableHead>
          {picked.map((s, i) => (
            <TableHead key={s.id} className="text-right">
              {s.name}
              {i === 0 ? <span className="sr-only"> (baseline)</span> : null}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {COMPARE_KPIS.map((k) => {
          const b = base ? k.value(base.response) : null;
          return (
            <TableRow key={k.key} data-testid={`compare-kpi-${k.key}`}>
              <TableCell className="font-medium">
                {k.key === 'within_plan_year' && planYear !== null ? `Finish in ${String(planYear)}` : k.label}
              </TableCell>
              {picked.map((s, i) => {
                const v = k.value(s.response);
                const d = i === 0 ? null : delta(b, v);
                const good = d === null || d === 0 || k.higherIsBetter === null ? null : d > 0 === k.higherIsBetter;
                return (
                  <TableCell key={s.id} className="whitespace-nowrap text-right tabular-nums">
                    <span data-numeric="">{v === null ? '—' : int(v)}</span>
                    {d !== null ? (
                      <span
                        className={cn(
                          'ml-1.5 text-2xs font-semibold',
                          good === null ? 'text-text-muted' : good ? 'text-success-subtle-fg' : 'text-danger-subtle-fg',
                        )}
                        data-testid="compare-delta"
                      >
                        <span className="sr-only">change from baseline </span>
                        {formatDelta(d)}
                      </span>
                    ) : null}
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** The grouped bars read the same served figure as the key-figures row of that name. */
function kpiValue(key: string, s: ImportScenario): number | null {
  return COMPARE_KPIS.find((k) => k.key === key)?.value(s.response) ?? null;
}

function OutcomeBars({ picked }: { picked: ImportScenario[] }): React.JSX.Element {
  const groups = [
    { key: 'within', label: 'Finish in the plan year', tone: 'success' as const, value: (s: ImportScenario) => kpiValue('within_plan_year', s) },
    { key: 'spillover', label: 'Spill over', tone: 'warning' as const, value: (s: ImportScenario) => kpiValue('spillover', s) },
    { key: 'not_placed', label: 'Not placed', tone: 'danger' as const, value: (s: ImportScenario) => kpiValue('not_placed', s) },
  ];
  return (
    <div className="grid gap-s4 lg:grid-cols-3" data-testid="compare-bars">
      {groups.map((g) => (
        <div key={g.key} className="min-w-0 space-y-s2">
          <p className="label-caps text-text-subtle">{g.label}</p>
          <BarChart
            ariaLabel={`${g.label} by scenario`}
            data={picked.flatMap((s) => {
              const v = g.value(s);
              return v === null ? [] : [{ key: s.id, label: s.name, value: v, tone: g.tone }];
            })}
          />
        </div>
      ))}
    </div>
  );
}

function CapacityTable({ picked }: { picked: ImportScenario[] }): React.JSX.Element {
  const rows = React.useMemo(() => capacityCompare(picked.map((s) => s.response)), [picked]);
  if (rows.length === 0) return <p className="text-xs text-text-muted">No design capacity served.</p>;
  return (
    <Table aria-label="Design capacity booked by scenario" scrollLabel="Design capacity booked by scenario">
      <TableHeader>
        <TableRow>
          <TableHead>Hub</TableHead>
          <TableHead>Window</TableHead>
          {picked.map((s) => (
            <TableHead key={s.id} className="text-right">
              {s.name}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key} data-testid="compare-capacity-row">
            <TableCell className="font-medium">{r.hub}</TableCell>
            <TableCell className="whitespace-nowrap">{r.windowLabel}</TableCell>
            {r.cells.map((c, i) => (
              <TableCell key={picked[i]?.id ?? i} className="whitespace-nowrap text-right">
                {c === null ? (
                  <span className="text-text-muted">—</span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono tabular-nums">{formatBookedPct(c.booked_pct)}</span>
                    <ServedStatusChip status={c.status} />
                  </span>
                )}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function OutcomeCell({
  side,
  base,
}: {
  side: OutcomeChange['a'];
  base: number;
}): React.JSX.Element {
  if (side === null) return <span className="text-text-muted">not in scenario</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={OUTCOME_TONE[side.outcome]}>{OUTCOME_LABEL[side.outcome]}</Badge>
      <span className="tabular-nums">{weekOrDash(side.finish_week, base)}</span>
    </span>
  );
}

function OutcomeDiff({ picked }: { picked: ImportScenario[] }): React.JSX.Element {
  const pair = useImportScenarios((s) => s.diffPair);
  const setPair = useImportScenarios((s) => s.setDiffPair);
  const a = picked.find((s) => s.id === pair[0]);
  const b = picked.find((s) => s.id === pair[1]);
  const changes = React.useMemo(() => (a && b ? outcomeChanges(a.response, b.response) : []), [a, b]);
  const idA = React.useId();
  const idB = React.useId();
  const columns: RowColumn<OutcomeChange>[] = [
    { header: 'Project', cell: (c) => <span className="font-medium">{c.name}</span> },
    { header: 'Hub', cell: (c) => c.hub },
    { header: a?.name ?? 'A', cell: (c) => <OutcomeCell side={c.a} base={a?.response.base_year ?? 0} /> },
    { header: b?.name ?? 'B', cell: (c) => <OutcomeCell side={c.b} base={b?.response.base_year ?? 0} /> },
  ];
  return (
    <div className="space-y-s3" data-testid="compare-outcome-changes">
      <div className="flex flex-wrap items-end gap-s3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={idA} className="text-2xs text-text-muted">
            From
          </Label>
          <NativeSelect id={idA} className="w-48" value={pair[0] ?? ''} onChange={(e) => setPair([e.target.value, pair[1]])}>
            {picked.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={idB} className="text-2xs text-text-muted">
            To
          </Label>
          <NativeSelect id={idB} className="w-48" value={pair[1] ?? ''} onChange={(e) => setPair([pair[0], e.target.value])}>
            {picked
              .filter((s) => s.id !== pair[0])
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </NativeSelect>
        </div>
        <p className="pb-1.5 text-xs text-text-muted" role="status">
          {int(changes.length)} project{changes.length === 1 ? ' changes' : 's change'} outcome
        </p>
      </div>
      {changes.length === 0 ? (
        <p className="text-xs text-text-muted">No project changes outcome between these two scenarios.</p>
      ) : (
        <ProjectRowsTable rows={changes} columns={columns} rowKey={(c) => c.ref} label="Projects that change outcome" />
      )}
    </div>
  );
}

export function ResultsCompare(): React.JSX.Element {
  const scenarios = useImportScenarios((s) => s.scenarios);
  const compareIds = useImportScenarios((s) => s.compareIds);
  const picked = React.useMemo(
    () => compareIds.map((id) => scenarios.find((s) => s.id === id)).filter((s): s is ImportScenario => s !== undefined),
    [compareIds, scenarios],
  );
  const position = (id: string) => compareIds.indexOf(id);

  return (
    <div className="space-y-s5" data-testid="import-compare">
      <Callout tone="neutral" title="Scenarios are kept for this session only" testId="import-session-banner">
        <p className="flex items-center gap-1">
          <Info className="size-3.5" aria-hidden="true" />A page refresh clears them; nothing is saved to the plan.
        </p>
      </Callout>

      <FeatureCard
        icon={Layers}
        title={`Scenarios (${int(scenarios.length)})`}
        hint={`Tick up to ${String(MAX_COMPARE)} to compare; the first ticked is the baseline.`}
        testId="import-scenarios"
      >
        {scenarios.length === 0 ? (
          <p className="text-xs text-text-muted">
            No scenario yet. Use “Save as scenario” or “Build a variant” below the results.
          </p>
        ) : (
          <ul className="space-y-s2">
            {scenarios.map((s) => (
              <ScenarioItem key={s.id} s={s} position={position(s.id)} />
            ))}
          </ul>
        )}
      </FeatureCard>

      {picked.length < 2 ? (
        <p className="text-xs text-text-muted" data-testid="compare-need-two">
          Pick two to four scenarios to compare them.
        </p>
      ) : (
        <>
          <FeatureCard icon={GitCompareArrows} title="Key figures" hint="Change from the baseline beside each figure">
            <KpiTable picked={picked} />
          </FeatureCard>
          <FeatureCard icon={BarChart3} title="Outcomes" hint="Within the plan year, spill over and not placed">
            <OutcomeBars picked={picked} />
          </FeatureCard>
          <FeatureCard icon={Gauge} title="Design capacity booked" hint="Per hub and window, with the booking status">
            <CapacityTable picked={picked} />
          </FeatureCard>
          <FeatureCard
            icon={GitCompareArrows}
            title="Projects that change outcome"
            hint="Matched by project; copies of a multi-project row by their own number"
          >
            <OutcomeDiff picked={picked} />
          </FeatureCard>
        </>
      )}
    </div>
  );
}
