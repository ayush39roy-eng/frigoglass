import * as React from 'react';
import { ArrowLeft, Library, RefreshCw, Shapes } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatWeek } from '@/lib/format';

import { int } from '../../components/figures';
import { NativeSelect } from '../../components/form-controls';
import { Callout } from '../../components/result-parts';
import { useImportPlan } from '../import-store';
import type { ImportSimulateResponse } from '../import-types';
import { choiceLabel, cutoffWeek, savedWindowText } from '../plan-window';
import { savedBannerTitle, savedViewOf, sessionViewOf } from '../saved-scenarios';
import { useImportScenarios } from '../scenarios-store';
import { libraryErrorMessage, useFetchSavedScenario, useSavedScenarios } from '../use-import-library';
import { FeatureCard } from './feature-card';
import { PickProjectsButton } from './project-picker-sheet';
import { ExportScenarioButton, SaveImportScenarioButton } from './scenario-actions';

/**
 * P41 (ADR 0055, contract E2): the "Scenario" bar at the top of the Executive tab. Pick
 * what the results show (the current result, a session variant, or a saved scenario of
 * this import), pick the projects of a new scenario, save it, export it, or open the
 * library. Opening a scenario shows its STORED response read-only; nothing is recomputed in
 * the browser.
 */

const CURRENT = 'current';

export function ScenarioBar({ pending }: { pending: boolean }): React.JSX.Element {
  const view = useImportPlan((s) => s.view);
  const sha = useImportPlan((s) => s.source?.sha256 ?? null);
  const result = useImportPlan((s) => s.result);
  const openView = useImportPlan((s) => s.openView);
  const closeView = useImportPlan((s) => s.closeView);
  const setTab = useImportPlan((s) => s.setResultsTab);
  const sessionScenarios = useImportScenarios((s) => s.scenarios);
  const saved = useSavedScenarios(sha);
  const fetchSaved = useFetchSavedScenario();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const selectId = React.useId();

  const session = sessionScenarios.filter((s) => s.origin !== 'stored');
  const savedHere = saved.data?.items ?? [];
  const value = view === null ? CURRENT : `${view.kind}:${view.id}`;
  // A saved scenario opened from the library (another import) is listed too, so the
  // selector always names what is shown.
  const savedOptions =
    view?.kind === 'saved' && !savedHere.some((s) => s.id === view.id)
      ? [{ id: view.id, name: view.name }, ...savedHere]
      : savedHere;

  const choose = async (next: string) => {
    setError(null);
    if (next === CURRENT) {
      closeView();
      return;
    }
    const [kind, ...rest] = next.split(':');
    const id = rest.join(':');
    if (kind === 'session') {
      const s = sessionScenarios.find((x) => x.id === id);
      if (s) openView(sessionViewOf(s));
      return;
    }
    setLoading(true);
    try {
      openView(savedViewOf(await fetchSaved(id)));
    } catch (e) {
      setError(libraryErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const planExcluded = result?.kpis.plan_excluded;

  return (
    <FeatureCard
      icon={Shapes}
      title="Scenario"
      hint="Pick the projects, save the result for later, export it"
      testId="import-scenario-bar"
      bodyClassName="space-y-s2"
    >
      <div className="flex flex-wrap items-end gap-s2">
        <label htmlFor={selectId} className="flex flex-col gap-1 text-2xs text-text-muted">
          Showing
          <NativeSelect
            id={selectId}
            className="w-64 max-w-full"
            value={value}
            disabled={loading}
            onChange={(e) => void choose(e.target.value)}
            data-testid="scenario-select"
          >
            <option value={CURRENT}>Current result</option>
            {session.length > 0 ? (
              <optgroup label="This session">
                {session.map((s) => (
                  <option key={s.id} value={`session:${s.id}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {savedOptions.length > 0 ? (
              <optgroup label="Saved">
                {savedOptions.map((s) => (
                  <option key={s.id} value={`saved:${s.id}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </NativeSelect>
        </label>
        {loading ? <Spinner className="mb-2 size-4" label="Loading the scenario" /> : null}
        <PickProjectsButton disabled={pending} />
        <SaveImportScenarioButton disabled={pending} />
        <ExportScenarioButton disabled={pending} />
        <Button type="button" size="sm" variant="ghost" onClick={() => setTab('compare')}>
          <Library />
          Saved scenarios
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs font-medium text-danger-subtle-fg">
          {error}
        </p>
      ) : null}
      {view === null && result !== null && result.plan_from_label ? (
        <p className="text-2xs text-text-muted" data-testid="scenario-plan-window">
          {`Plan from ${result.plan_from_label} until ${choiceLabel(result.plan_week_choices, cutoffWeek(result))}`}
          {result.plan_window_label ? ` · plan window ${result.plan_window_label}` : ' · the plan year'}
        </p>
      ) : null}
      {view === null && planExcluded !== undefined && planExcluded > 0 ? (
        <p className="text-2xs text-text-muted" data-testid="scenario-plan-excluded">
          {`${int(planExcluded)} plan project${planExcluded === 1 ? ' is' : 's are'} left out of this scenario.`}
        </p>
      ) : null}
    </FeatureCard>
  );
}

/** The banner over every results tab while a scenario other than the current result is shown. */
export function ScenarioViewBanner({ current }: { current: ImportSimulateResponse | null }): React.JSX.Element | null {
  const view = useImportPlan((s) => s.view);
  const closeView = useImportPlan((s) => s.closeView);
  const setStep = useImportPlan((s) => s.setStep);
  const restore = useImportPlan((s) => s.restoreRequest);
  if (view === null) return null;
  // P48: opened from the upload step with no workbook loaded, there is no current result to
  // go back to; "Back" returns to the saved-scenario panel on the upload step.
  const back =
    current === null ? (
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          closeView();
          setStep('upload');
        }}
      >
        <ArrowLeft />
        Back to saved scenarios
      </Button>
    ) : (
      <Button type="button" size="sm" variant="secondary" onClick={closeView}>
        <ArrowLeft />
        Back to current result
      </Button>
    );
  if (view.kind === 'session') {
    return (
      <Callout tone="primary" title={`Session scenario “${view.name}” — read-only`} testId="import-view-banner">
        <div className="flex flex-wrap items-center gap-s2">
          <span>The figures are this variant&apos;s as computed. Gantt edits apply to the current result.</span>
          {back}
        </div>
      </Callout>
    );
  }
  return (
    <Callout
      tone="primary"
      title={savedBannerTitle(view.simulated_week, view.plan_version)}
      testId="import-view-banner"
    >
      <div className="flex flex-wrap items-center gap-s2">
        <span>
          “{view.name}” from {view.source.file_name}, shown as saved. The plan may have moved since
          {current !== null && current.current_week !== view.simulated_week
            ? ` (today is ${formatWeek(current.current_week)})`
            : ''}
          .
        </span>
        <span data-testid="import-view-window">
          {savedWindowText(view) ?? ''}
          {view.result.plan_window_label ? ` (${view.result.plan_window_label})` : ''}.
        </span>
        <Button type="button" size="sm" variant="secondary" onClick={() => restore(view.request, view.source)}>
          <RefreshCw />
          Re-run on today&apos;s plan
        </Button>
        {back}
      </div>
    </Callout>
  );
}
