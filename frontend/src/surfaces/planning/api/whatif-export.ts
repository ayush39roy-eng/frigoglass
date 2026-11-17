/**
 * P43 (ADR 0057 D3, API_CONTRACT_P43 §3): the What-if planner's Excel export,
 * `POST /whatif/export.xlsx`. The server re-simulates the scenario and builds the
 * workbook (Summary, a drawn Gantt, Gantt data); the browser only saves the bytes.
 * Kept apart from `whatif-api.ts` so the JSON fetchers stay a small, mockable set.
 */

import { apiDownload, type DownloadedFile } from '@/lib/api/client';

import type { ScenarioRequest, SimulateExportRequest } from './whatif-types';

/** The server's name limit (`SimulateExportIn.name`, 1..120 chars). */
export const MAX_EXPORT_NAME = 120;

/** Server's file name when no name is sent; used only if `Content-Disposition` is missing. */
export const DEFAULT_EXPORT_FILENAME = 'whatif-scenario.xlsx';

/** The exact request body: the scenario as simulated, plus a name only when there is one. */
export function simulateExportBody(scenario: ScenarioRequest, name?: string | null): SimulateExportRequest {
  const trimmed = (name ?? '').trim().slice(0, MAX_EXPORT_NAME);
  return trimmed === '' ? { scenario } : { scenario, name: trimmed };
}

export function downloadSimulateExport(body: SimulateExportRequest): Promise<DownloadedFile> {
  return apiDownload('/whatif/export.xlsx', {
    method: 'POST',
    body,
    fallbackFilename: DEFAULT_EXPORT_FILENAME,
  });
}
