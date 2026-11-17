import * as React from 'react';
import { Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { saveBlob } from '@/lib/download';

import { downloadSimulateExport, simulateExportBody } from '../../api/whatif-export';
import type { ScenarioRequest } from '../../api/whatif-types';
import { classifyWhatIfError, type WhatIfErrorInfo } from '../use-whatif';
import { WhatIfErrorNotice } from './whatif-error';

/**
 * P43 (ADR 0057 D3, API_CONTRACT_P43 §3/§6): "Export to Excel" for a simulated scenario.
 * Sends the scenario that produced the result on screen (plus an optional name) to
 * `POST /whatif/export.xlsx`; the server simulates again and builds the workbook. Nothing
 * is computed here. Errors read exactly like Simulate's (403 / 422 / 429 with the
 * `Retry-After` countdown / 503).
 */
export function SimulateExportButton({
  scenario,
  name,
  disabled = false,
  idleHint = 'Run Simulate first, then export its result.',
}: {
  /** The scenario of the computed result; null when there is nothing to export yet. */
  scenario: ScenarioRequest | null;
  name?: string | null;
  disabled?: boolean;
  /** Shown while there is no computed scenario. */
  idleHint?: string;
}): React.JSX.Element {
  const hintId = React.useId();
  const [pending, setPending] = React.useState(false);
  const [failure, setFailure] = React.useState<{ info: WhatIfErrorInfo; token: number } | null>(null);

  const run = React.useCallback(async () => {
    if (scenario === null) return;
    setPending(true);
    setFailure(null);
    try {
      const { blob, filename } = await downloadSimulateExport(simulateExportBody(scenario, name));
      saveBlob(blob, filename);
    } catch (err) {
      setFailure({ info: classifyWhatIfError(err, 'scenario'), token: Date.now() });
    } finally {
      setPending(false);
    }
  }, [scenario, name]);

  const off = scenario === null || disabled || pending;
  return (
    <div className="space-y-s2" data-testid="whatif-export">
      <div className="flex flex-wrap items-center justify-end gap-s2">
        {scenario === null ? (
          <span id={hintId} className="text-2xs text-text-muted" data-testid="whatif-export-hint">
            {idleHint}
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={off}
          aria-busy={pending || undefined}
          aria-describedby={scenario === null ? hintId : undefined}
          onClick={() => void run()}
        >
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
          {pending ? 'Exporting…' : 'Export to Excel'}
        </Button>
      </div>
      {failure ? (
        <WhatIfErrorNotice
          info={failure.info}
          errorToken={failure.token}
          onRetry={() => void run()}
          retryLabel="Export again"
        />
      ) : null}
    </div>
  );
}
