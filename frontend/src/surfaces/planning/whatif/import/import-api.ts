/**
 * Fetchers for the plan import (P32-T06, docs/API_CONTRACT_P32.md B2 / B3). Thin wrappers
 * over the shared transport; the only addition is the zod shape check of the response.
 * Nothing is transformed and no figure is derived (I9).
 */

import type { z } from 'zod';

import {
  apiDownload,
  apiGet,
  apiSend,
  apiUpload,
  type ApiRequestOptions,
  type DownloadedFile,
} from '@/lib/api/client';

import {
  importFormatSchema,
  importParseResponseSchema,
  importSimulateResponseSchema,
  savedScenarioListSchema,
  savedScenarioSchema,
} from './import-schema';
import type {
  ImportFormat,
  ImportFormatUpdate,
  ImportParseResponse,
  ImportSimulateRequest,
  ImportSimulateResponse,
  SavedScenario,
  SavedScenarioPage,
  SaveScenarioBody,
} from './import-types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

/** The server answered 2xx but not with the contract's shape. */
export class ImportShapeError extends Error {
  constructor(endpoint: string) {
    super(`Unexpected response shape from ${endpoint}`);
    this.name = 'ImportShapeError';
  }
}

export async function postImportParse(file: File, ctx: FetchCtx = {}): Promise<ImportParseResponse> {
  const form = new FormData();
  form.append('file', file, file.name);
  const raw = await apiUpload<unknown>('/whatif/import/parse', form, ctx);
  const parsed = importParseResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ImportShapeError('/whatif/import/parse');
  return parsed.data;
}

export async function postImportSimulate(
  body: ImportSimulateRequest,
  ctx: FetchCtx = {},
): Promise<ImportSimulateResponse> {
  const raw = await apiSend<unknown>('POST', '/whatif/import/simulate', body, ctx);
  const parsed = importSimulateResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ImportShapeError('/whatif/import/simulate');
  return parsed.data;
}

// --- P41 (docs/API_CONTRACT_P41.md A–D, ADR 0055) ----------------------------------------------

export const FORMAT_PATH = '/whatif/import/format';
export const SCENARIOS_PATH = '/whatif/import/scenarios';

function checked<T>(schema: z.ZodType<T>, raw: unknown, endpoint: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ImportShapeError(endpoint);
  return parsed.data;
}

/** `GET /whatif/import/format` (What-if access). */
export async function getImportFormat(ctx: FetchCtx = {}): Promise<ImportFormat> {
  return checked(importFormatSchema, await apiGet<unknown>(FORMAT_PATH, ctx), FORMAT_PATH);
}

/** `PUT /whatif/import/format` (Admin, Super Admin; 409 `FORMAT_VERSION_CONFLICT`). */
export async function putImportFormat(body: ImportFormatUpdate): Promise<ImportFormat> {
  return checked(importFormatSchema, await apiSend<unknown>('PUT', FORMAT_PATH, body), FORMAT_PATH);
}

/** `POST /whatif/import/format/reset` (Admin, Super Admin). */
export async function resetImportFormat(version: number): Promise<ImportFormat> {
  const path = `${FORMAT_PATH}/reset`;
  return checked(importFormatSchema, await apiSend<unknown>('POST', path, { version }), path);
}

/** Page size of the library (P41-R01 default) and of the per-file lookup (the cap). */
export const SCENARIO_PAGE = 50;
export const SCENARIO_PAGE_MAX = 200;

/** `GET /whatif/import/scenarios[?source_file_sha256=]&limit=&offset=`: one page, newest first, as served. */
export async function listSavedScenarios(
  page: { sha?: string | undefined; limit: number; offset: number },
  ctx: FetchCtx = {},
): Promise<SavedScenarioPage> {
  const raw = await apiGet<unknown>(SCENARIOS_PATH, {
    ...ctx,
    query: { source_file_sha256: page.sha, limit: page.limit, offset: page.offset },
  });
  return checked(savedScenarioListSchema, raw, SCENARIOS_PATH);
}

/** `GET /whatif/import/scenarios/{id}`: the frozen request + response. */
export async function getSavedScenario(id: string, ctx: FetchCtx = {}): Promise<SavedScenario> {
  const path = `${SCENARIOS_PATH}/${encodeURIComponent(id)}`;
  return checked(savedScenarioSchema, await apiGet<unknown>(path, ctx), SCENARIOS_PATH);
}

/** `POST /whatif/import/scenarios`: the server re-runs `request` and stores ITS output (201). */
export async function createSavedScenario(body: SaveScenarioBody): Promise<SavedScenario> {
  return checked(savedScenarioSchema, await apiSend<unknown>('POST', SCENARIOS_PATH, body), SCENARIOS_PATH);
}

/** `PATCH /whatif/import/scenarios/{id}` (creator, Admin, Super Admin). */
export async function patchSavedScenario(
  id: string,
  /** P47 (ADR 0059 C1): `base` = the name / note as read when the rename started. */
  body: { name?: string; note?: string | null; base?: Record<string, unknown> },
): Promise<unknown> {
  return apiSend<unknown>('PATCH', `${SCENARIOS_PATH}/${encodeURIComponent(id)}`, body);
}

/** `DELETE /whatif/import/scenarios/{id}` (204). */
export async function deleteSavedScenario(id: string): Promise<void> {
  await apiSend<unknown>('DELETE', `${SCENARIOS_PATH}/${encodeURIComponent(id)}`);
}

/** A file-system-safe fallback name; the server's `Content-Disposition` wins when present. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned === '' ? 'scenario' : cleaned).slice(0, 80);
}

/** `GET /whatif/import/format/template.xlsx` (What-if access). */
export function downloadFormatTemplate(): Promise<DownloadedFile> {
  return apiDownload(`${FORMAT_PATH}/template.xlsx`, { fallbackFilename: 'import-template.xlsx' });
}

/** `GET /whatif/import/scenarios/{id}/export.xlsx`: a saved scenario. */
export function downloadSavedScenario(id: string, name: string): Promise<DownloadedFile> {
  return apiDownload(`${SCENARIOS_PATH}/${encodeURIComponent(id)}/export.xlsx`, {
    fallbackFilename: `${safeFileName(name)}.xlsx`,
  });
}

/** `POST /whatif/import/export.xlsx`: an unsaved result; the server recomputes from `request`. */
export function downloadCurrentResult(name: string, request: ImportSimulateRequest): Promise<DownloadedFile> {
  return apiDownload('/whatif/import/export.xlsx', {
    method: 'POST',
    body: { name, request },
    fallbackFilename: `${safeFileName(name)}.xlsx`,
  });
}

/** `GET /whatif/import/scenarios/compare.xlsx?ids=a,b,c` (2–4 saved ids). */
export function downloadComparison(ids: readonly string[]): Promise<DownloadedFile> {
  return apiDownload(`${SCENARIOS_PATH}/compare.xlsx`, {
    query: { ids: ids.join(',') },
    fallbackFilename: 'scenario-comparison.xlsx',
  });
}
