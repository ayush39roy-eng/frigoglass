import * as React from 'react';
import { Plus, Trash2, Wand2 } from 'lucide-react';

import { MultiChipFilter } from '@/components/shared/multi-chip-filter';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import { int } from '../../components/figures';
import { NativeSelect } from '../../components/form-controls';
import { WhatIfErrorNotice } from '../../components/whatif-error';
import { buildSimulateRequest } from '../import-rows';
import { useImportPlan } from '../import-store';
import type { ImportMode } from '../import-types';
import {
  applyScenarioRules,
  describeRules,
  DIMENSION_LABEL,
  dimensionValues,
  emptyRules,
  isCandidate,
  RULE_DIMENSIONS,
  SOURCE_LABEL,
  type RowSource,
  type RuleDimension,
  type ScenarioRules,
} from '../scenario-rules';
import { defaultScenarioName, MAX_SCENARIO_NAME, MAX_SCENARIOS, useImportScenarios } from '../scenarios-store';
import { classifyImportError, useImportSimulation } from '../use-import';

/**
 * Scenario builder (P32-R05 C2): a variant of the Review rows made with quick rules
 * (only / except per category, hub, priority, status, source; "at most N of category X";
 * merge or file only), computed with the normal `/whatif/import/simulate` and saved as a
 * session scenario. The rules only decide which rows are sent; every figure is served.
 */
export function ScenarioBuilderButton({ onSaved }: { onSaved?: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const full = useImportScenarios((s) => s.scenarios.length >= MAX_SCENARIOS);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={full}
        title={full ? `At most ${String(MAX_SCENARIOS)} scenarios; delete one first` : undefined}
        onClick={() => setOpen(true)}
      >
        <Wand2 />
        Build a variant
      </Button>
      {open ? <BuilderDialog onClose={() => setOpen(false)} onSaved={onSaved} /> : null}
    </>
  );
}

function BuilderDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: ((id: string) => void) | undefined;
}): React.JSX.Element {
  const rows = useImportPlan((s) => s.rows);
  const options = useImportPlan((s) => s.options);
  const edits = useImportPlan((s) => s.edits);
  const fileName = useImportPlan((s) => s.parsed?.file_name ?? null);
  const scenarios = useImportScenarios((s) => s.scenarios);
  const save = useImportScenarios((s) => s.save);
  const [name, setName] = React.useState(() => defaultScenarioName(scenarios, 'Variant'));
  const [rules, setRules] = React.useState<ScenarioRules>(() => emptyRules(options.mode));
  const nameId = React.useId();

  const variantRows = React.useMemo(() => applyScenarioRules(rows, rules), [rows, rules]);
  const candidates = rows.filter(isCandidate).length;
  const included = variantRows.filter((r) => r.include).length;
  const categories = React.useMemo(() => dimensionValues(rows, 'category'), [rows]);

  const pendingName = React.useRef('');
  const simulation = useImportSimulation((response, body) => {
    const id = save({
      name: pendingName.current,
      origin: 'variant',
      rules: describeRules(rules),
      fileName,
      rows: body.rows,
      options: { ...options, mode: body.mode },
      edits,
      response,
    });
    onClose();
    if (id) onSaved?.(id);
  });

  const setFilter = (dim: RuleDimension, patch: Partial<ScenarioRules['filters'][RuleDimension]>) =>
    setRules((r) => ({ ...r, filters: { ...r.filters, [dim]: { ...r.filters[dim], ...patch } } }));
  const setCap = (i: number, patch: Partial<ScenarioRules['caps'][number]>) =>
    setRules((r) => ({ ...r, caps: r.caps.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() === '' || included === 0) return;
    pendingName.current = name;
    simulation.run(buildSimulateRequest(variantRows, { ...options, mode: rules.mode }, edits));
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="import-scenario-builder">
        <form onSubmit={submit} className="space-y-s4">
          <DialogHeader>
            <DialogTitle>Build a variant</DialogTitle>
            <DialogDescription>
              Start from the rows on Review, keep or drop rows with quick rules, then compute and save it.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-s3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="flex flex-col gap-1">
              <Label htmlFor={nameId} className="text-2xs text-text-muted">
                Scenario name
              </Label>
              <Input id={nameId} value={name} maxLength={MAX_SCENARIO_NAME} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <span id={`${nameId}-mode`} className="text-2xs text-text-muted">
                Mode
              </span>
              <ToggleGroup
                type="single"
                size="sm"
                value={rules.mode}
                onValueChange={(v) => {
                  if (v) setRules((r) => ({ ...r, mode: v as ImportMode }));
                }}
                aria-labelledby={`${nameId}-mode`}
              >
                <ToggleGroupItem value="merge">Merge with plan</ToggleGroupItem>
                <ToggleGroupItem value="file_only">File only</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          <fieldset className="space-y-s2">
            <legend className="text-xs font-semibold text-text">Rows to keep</legend>
            {RULE_DIMENSIONS.map((dim) => {
              const values = dimensionValues(rows, dim);
              if (values.length < 2 && rules.filters[dim].values.length === 0) return null;
              const rule = rules.filters[dim];
              return (
                <div key={dim} className="flex flex-wrap items-start gap-s2" data-testid={`builder-${dim}`}>
                  <NativeSelect
                    aria-label={`${DIMENSION_LABEL[dim]} rule`}
                    className="h-7 w-24 text-xs"
                    value={rule.op}
                    onChange={(e) => setFilter(dim, { op: e.target.value as 'only' | 'except' })}
                  >
                    <option value="only">Only</option>
                    <option value="except">All except</option>
                  </NativeSelect>
                  <MultiChipFilter
                    label={DIMENSION_LABEL[dim]}
                    options={values.map((v) => ({
                      value: v,
                      label: dim === 'source' ? SOURCE_LABEL[v as RowSource] : v,
                    }))}
                    value={rule.values}
                    onChange={(next) => setFilter(dim, { values: next })}
                    allLabel="Any"
                    className="min-w-0 flex-1"
                  />
                </div>
              );
            })}
          </fieldset>

          <fieldset className="space-y-s2">
            <legend className="text-xs font-semibold text-text">Limits</legend>
            {rules.caps.map((cap, i) => (
              <div key={i} className="flex flex-wrap items-center gap-s2" data-testid="builder-cap">
                <span className="text-xs text-text-muted">At most</span>
                <Input
                  type="number"
                  min={0}
                  className="h-8 w-20"
                  aria-label={`Limit ${String(i + 1)}: number of rows`}
                  value={String(cap.max)}
                  onChange={(e) => setCap(i, { max: Math.max(0, Number(e.target.value) || 0) })}
                />
                <NativeSelect
                  aria-label={`Limit ${String(i + 1)}: category`}
                  className="h-8 w-28"
                  value={cap.category}
                  onChange={(e) => setCap(i, { category: e.target.value })}
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </NativeSelect>
                <span className="text-xs text-text-muted">rows</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove limit ${String(i + 1)}`}
                  onClick={() => setRules((r) => ({ ...r, caps: r.caps.filter((_, j) => j !== i) }))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-s2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={categories.length === 0}
                onClick={() =>
                  setRules((r) => ({ ...r, caps: [...r.caps, { category: categories[0] ?? 'A+', max: 5 }] }))
                }
              >
                <Plus />
                Add a limit
              </Button>
              {categories.includes('A+') && !rules.caps.some((c) => c.category === 'A+') ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setRules((r) => ({ ...r, caps: [...r.caps, { category: 'A+', max: 5 }] }))}
                >
                  Only 5 A+
                </Button>
              ) : null}
              <span className="text-2xs text-text-muted">
                Keeps the first rows by priority, then rank, then file row.
              </span>
            </div>
          </fieldset>

          <p className="text-xs text-text" role="status" data-testid="builder-preview">
            {int(included)} of {int(candidates)} rows kept · {describeRules(rules)}
          </p>
          {simulation.error ? (
            <WhatIfErrorNotice
              info={classifyImportError(simulation.error, 'simulate')}
              errorToken={simulation.token}
              onRetry={simulation.retry}
            />
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim() === '' || included === 0 || simulation.pending}>
              {simulation.pending ? <Spinner className="size-4" /> : <Wand2 />}
              {simulation.pending ? 'Computing…' : 'Compute and save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
