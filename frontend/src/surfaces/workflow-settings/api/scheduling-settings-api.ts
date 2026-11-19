import { apiGet, apiSend } from '@/lib/api/client';

/**
 * P53 (ADR 0063, R53-2; API_CONTRACT_P53 §2): the scheduling search limit N.
 * `GET` any authenticated role; `PUT` Admin / Super Admin (403 otherwise),
 * optimistic `version` (409 `VERSION_CONFLICT`), 422 when N ∉ 1..10. No run is
 * dispatched by a save — the UI offers the standard Recalculate.
 */
export interface SchedulingSettings {
  horizon_years: number;
  /** 0 = never saved (the default 5 is in force). */
  version: number;
  updated_at: string | null;
  current_week: number;
  /** `current_week + 52 × N`, served. */
  horizon_weeks_next_run: number;
}

export interface SchedulingSettingsUpdate {
  horizon_years: number;
  version: number;
}

export function fetchSchedulingSettings(ctx: { signal?: AbortSignal } = {}): Promise<SchedulingSettings> {
  return apiGet<SchedulingSettings>('/scheduling-settings', ctx);
}

export function updateSchedulingSettings(body: SchedulingSettingsUpdate): Promise<SchedulingSettings> {
  return apiSend<SchedulingSettings>('PUT', '/scheduling-settings', body);
}

/** The Admin setting's served range (contract §2); the server re-validates. */
export const HORIZON_YEARS_CHOICES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
