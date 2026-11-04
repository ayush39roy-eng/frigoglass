import * as React from 'react';
import { useMutation } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';

import { classifyWhatIfError, scenarioLimitMessage, type WhatIfErrorInfo } from '../use-whatif';
import { ImportShapeError, postImportParse, postImportSimulate } from './import-api';
import type { ImportSimulateRequest, ImportSimulateResponse } from './import-types';

/** Debounce between a Gantt drop and the re-simulate (quick drops are coalesced). */
export const RESIMULATE_DEBOUNCE_MS = 400;

/** Parse is a pure read on a POST: never retried automatically (as every What-if call). */
export function useImportParse() {
  return useMutation({
    mutationFn: (file: File) => postImportParse(file),
    retry: false,
  });
}

/**
 * Plain copy for a failed parse / simulate. The import-specific answers come first
 * (413 `FILE_TOO_LARGE`, 422 `IMPORT_FORMAT`, 422 `INVALID_IMPORT`, an unexpected
 * response shape); 401 / 403 / 429 / 503 `WHATIF_TIMEOUT` are the What-if planner's.
 */
export function classifyImportError(error: unknown, endpoint: 'parse' | 'simulate'): WhatIfErrorInfo {
  if (error instanceof ImportShapeError) {
    return {
      kind: 'other',
      message: 'The server answered in an unexpected format. Reload the page; if it persists, report it.',
      retryable: true,
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 413) {
      return {
        kind: 'invalid',
        message: 'The file is larger than 5 MB. Remove unused sheets or rows and try again.',
        retryable: false,
      };
    }
    if (error.status === 415 || (error.status === 422 && error.code === 'UNSUPPORTED_FILE_TYPE')) {
      return {
        kind: 'invalid',
        message: 'This file is not an Excel workbook (.xlsx).',
        retryable: false,
      };
    }
    if (error.status === 422 && error.code === 'IMPORT_FORMAT') {
      const detail = error.detail ? ` ${scenarioLimitMessage(error.detail)}` : '';
      return {
        kind: 'invalid',
        message: `The workbook is not in the expected format.${detail}`,
        retryable: false,
      };
    }
    if (error.status === 422 && endpoint === 'simulate') {
      const detail = error.code === 'INVALID_IMPORT' && error.detail ? ` ${scenarioLimitMessage(error.detail)}` : '';
      return {
        kind: 'invalid',
        message: `The planner could not use these rows.${detail || ' Check the highlighted fields and try again.'}`,
        retryable: false,
      };
    }
    if (error.status === 422 && endpoint === 'parse') {
      return {
        kind: 'invalid',
        message: 'The server could not read this file. Check it is the capacity-planning workbook.',
        retryable: false,
      };
    }
  }
  return classifyWhatIfError(error, 'scenario');
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export interface ImportSimulationState {
  pending: boolean;
  error: unknown;
  /** Changes on every settled request (restarts a 429 countdown). */
  token: number;
}

/**
 * `/whatif/import/simulate` with the Gantt's needs: a new request aborts the one in
 * flight, an optional debounce coalesces quick drops, and only the LATEST request's
 * answer is ever applied. `onResult` receives the served response untouched.
 */
export function useImportSimulation(onResult: (result: ImportSimulateResponse, body: ImportSimulateRequest) => void) {
  const [state, setState] = React.useState<ImportSimulationState>({
    pending: false,
    error: null,
    token: 0,
  });
  const controller = React.useRef<AbortController | null>(null);
  const timer = React.useRef<number | null>(null);
  const seq = React.useRef(0);
  const lastBody = React.useRef<ImportSimulateRequest | null>(null);
  const onResultRef = React.useRef(onResult);
  React.useEffect(() => {
    onResultRef.current = onResult;
  });

  const run = React.useCallback((body: ImportSimulateRequest, delayMs = 0) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    controller.current?.abort();
    controller.current = null;
    seq.current += 1;
    const id = seq.current;
    lastBody.current = body;
    setState((s) => ({ ...s, pending: true, error: null }));
    const fire = () => {
      timer.current = null;
      const c = new AbortController();
      controller.current = c;
      postImportSimulate(body, { signal: c.signal }).then(
        (result) => {
          if (id !== seq.current) return;
          controller.current = null;
          onResultRef.current(result, body);
          setState({ pending: false, error: null, token: id });
        },
        (error: unknown) => {
          if (id !== seq.current || isAbort(error)) return;
          controller.current = null;
          setState({ pending: false, error, token: id });
        },
      );
    };
    if (delayMs > 0) timer.current = window.setTimeout(fire, delayMs);
    else fire();
  }, []);

  const retry = React.useCallback(() => {
    if (lastBody.current) run(lastBody.current);
  }, [run]);

  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      controller.current?.abort();
    },
    [],
  );

  return { ...state, run, retry };
}
