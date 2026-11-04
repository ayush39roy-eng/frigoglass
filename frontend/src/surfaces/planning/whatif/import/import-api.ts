/**
 * Fetchers for the plan import (P32-T06, docs/API_CONTRACT_P32.md B2 / B3). Thin wrappers
 * over the shared transport; the only addition is the zod shape check of the response.
 * Nothing is transformed and no figure is derived (I9).
 */

import { apiSend, apiUpload, type ApiRequestOptions } from '@/lib/api/client';

import { importParseResponseSchema, importSimulateResponseSchema } from './import-schema';
import type { ImportParseResponse, ImportSimulateRequest, ImportSimulateResponse } from './import-types';

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
