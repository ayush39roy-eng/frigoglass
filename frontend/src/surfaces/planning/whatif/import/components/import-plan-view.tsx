import * as React from 'react';
import { Check } from 'lucide-react';

import { CardInfo } from '@/components/ui/card-info';
import { cn } from '@/lib/utils';

import { buildSimulateRequest } from '../import-rows';
import { useImportPlan, type ImportStep } from '../import-store';
import type { ImportSimulateRequest } from '../import-types';
import { RESIMULATE_DEBOUNCE_MS, useImportSimulation } from '../use-import';
import { useDrill } from '../drill-store';
import { DrillSheet } from './drill-sheet';
import { ResultsStep } from './results-step';
import { ReviewStep } from './review-step';
import { UploadStep } from './upload-step';

const STEPS: { key: ImportStep; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'review', label: 'Review' },
  { key: 'results', label: 'Results' },
];

function Stepper({ step, canResults, onGo }: { step: ImportStep; canResults: boolean; onGo: (s: ImportStep) => void }) {
  const idx = STEPS.findIndex((s) => s.key === step);
  return (
    <nav aria-label="Import steps">
      <ol className="flex flex-wrap items-center gap-s2 rounded-pill border border-border bg-surface px-s3 py-1.5">
        {STEPS.map((s, i) => {
          const done = i < idx;
          const reachable = s.key === 'upload' ? false : s.key === 'review' ? idx > 1 : canResults && idx === 1;
          const content = (
            <>
              <span
                className={cn(
                  'inline-flex size-5 items-center justify-center rounded-full border text-2xs font-semibold',
                  i === idx
                    ? 'border-primary bg-primary text-primary-fg'
                    : done
                      ? 'border-primary text-primary'
                      : 'border-border-strong text-text-muted',
                )}
                aria-hidden="true"
              >
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              <span className={cn('text-xs', i === idx ? 'font-semibold text-text' : 'text-text-muted')}>
                {s.label}
              </span>
            </>
          );
          return (
            <li key={s.key} className="flex items-center gap-s2" aria-current={i === idx ? 'step' : undefined}>
              {reachable ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onGo(s.key)}
                >
                  {content}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5">{content}</span>
              )}
              {i < STEPS.length - 1 ? <span className="h-px w-6 bg-border-strong" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * "Import plan (Excel)" on the What-if planner (P32-T06, ADR 0044): Upload → Review →
 * Results. All state is the session-only store; every figure is the server's.
 */
export default function ImportPlanView(): React.JSX.Element {
  const step = useImportPlan((s) => s.step);
  const parsed = useImportPlan((s) => s.parsed);
  const result = useImportPlan((s) => s.result);
  const rows = useImportPlan((s) => s.rows);
  const options = useImportPlan((s) => s.options);
  const edits = useImportPlan((s) => s.edits);
  const setResult = useImportPlan((s) => s.setResult);
  const setStep = useImportPlan((s) => s.setStep);
  const pruneEdits = useImportPlan((s) => s.pruneEdits);

  const lastSent = React.useRef<string | null>(null);
  const goToResults = React.useRef(false);
  const simulation = useImportSimulation((res) => {
    setResult(res);
    if (goToResults.current) {
      goToResults.current = false;
      setStep('results');
    }
  });
  const { run } = simulation;

  const body: ImportSimulateRequest = React.useMemo(
    () => buildSimulateRequest(rows, options, edits),
    [rows, options, edits],
  );
  const bodyKey = React.useMemo(() => JSON.stringify(body), [body]);

  const compute = () => {
    // Stale edits are pruned from the map itself (the body never carries them anyway).
    pruneEdits();
    goToResults.current = true;
    lastSent.current = bodyKey;
    run(body);
  };

  // On the results, every change of the request (a Gantt drop, undo, reset) re-simulates,
  // debounced; the previous request is aborted by the runner.
  React.useEffect(() => {
    if (step !== 'results' || lastSent.current === bodyKey) return;
    lastSent.current = bodyKey;
    run(body, RESIMULATE_DEBOUNCE_MS);
  }, [step, body, bodyKey, run]);

  // The drill-down sheet belongs to this view: closed when the view goes or the step changes.
  const closeDrill = useDrill((s) => s.close);
  React.useEffect(() => () => closeDrill(false), [step, closeDrill]);

  return (
    <section className="space-y-s4" aria-labelledby="import-plan-heading" data-testid="import-plan-view">
      <div className="flex flex-wrap items-center justify-between gap-s3">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h3 id="import-plan-heading" className="text-lg font-semibold text-text">
              Import plan (Excel)
            </h3>
            <CardInfo label="How this works">
              <p>
                Upload the capacity-planning workbook, check and fix its rows, then let the scheduler place every
                project: a Gantt you can adjust and the capacity it needs.
              </p>
              <p>
                Save a result as a scenario, or build variants with quick rules, and compare up to four side by side.
                Scenarios last for this session only. Nothing is saved or applied to the real plan.
              </p>
            </CardInfo>
          </div>
          <p className="text-xs text-text-muted">Try a workbook against the plan. Nothing is saved.</p>
        </div>
        <Stepper step={step} canResults={result !== null} onGo={setStep} />
      </div>
      {step === 'upload' || parsed === null ? (
        <UploadStep />
      ) : step === 'review' || result === null ? (
        <ReviewStep parsed={parsed} simulation={simulation} onCompute={compute} onRetry={compute} />
      ) : (
        <ResultsStep result={result} simulation={simulation} onRetry={simulation.retry} />
      )}
      <DrillSheet />
    </section>
  );
}
