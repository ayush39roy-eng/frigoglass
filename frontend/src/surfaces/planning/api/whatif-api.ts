/**
 * Fetchers for the What-if planner (P18-T03; `POST /whatif/*`, API_CONTRACT_P18 §9).
 * Thin wrappers over `apiSend`: no transformation, no derived numbers. The server
 * narrows every response to the caller's hub scope; nothing here re-scopes.
 */

import { apiSend, type ApiRequestOptions } from '@/lib/api/client';

import type {
  AskRequest,
  AskResponse,
  EstimateRequest,
  EstimateResponse,
  SimulateRequest,
  SimulateResponse,
  SolveRequest,
  SolveResponse,
} from './whatif-types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export function postEstimate(body: EstimateRequest, ctx: FetchCtx = {}): Promise<EstimateResponse> {
  return apiSend<EstimateResponse>('POST', '/whatif/estimate', body, ctx);
}

export function postSimulate(body: SimulateRequest, ctx: FetchCtx = {}): Promise<SimulateResponse> {
  return apiSend<SimulateResponse>('POST', '/whatif/simulate', body, ctx);
}

export function postSolve(body: SolveRequest, ctx: FetchCtx = {}): Promise<SolveResponse> {
  return apiSend<SolveResponse>('POST', '/whatif/solve', body, ctx);
}

export function postAsk(body: AskRequest, ctx: FetchCtx = {}): Promise<AskResponse> {
  return apiSend<AskResponse>('POST', '/whatif/ask', body, ctx);
}
