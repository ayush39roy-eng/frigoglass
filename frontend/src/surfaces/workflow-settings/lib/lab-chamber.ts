import { ApiError } from '@/lib/api/client';

/**
 * P58 (API_CONTRACT_P58 §1): the steps PUT answers 409 `LAB_STEP_HAS_NO_CHAMBER`
 * when a step becomes Lab while no chamber lists it (projects reaching it could
 * never be scheduled). The Effort matrix asks which existing lab step's chambers
 * should also run it, and retries the same body with `add_to_chambers_like`.
 */
export const LAB_STEP_HAS_NO_CHAMBER = 'LAB_STEP_HAS_NO_CHAMBER';

/** The step ids of a 409 `LAB_STEP_HAS_NO_CHAMBER`, else null. */
export function labStepsWithoutChamber(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== LAB_STEP_HAS_NO_CHAMBER) return null;
  const body = err.body as { steps?: unknown } | null | undefined;
  const steps = Array.isArray(body?.steps) ? body.steps.filter((s): s is string => typeof s === 'string') : [];
  return steps;
}

/** Thrown when the user cancels the dialog: nothing was saved, the drafts stay. */
export class LabChamberCancelledError extends Error {
  constructor() {
    super('Not saved: the lab step needs a chamber. Your resource change is still a draft.');
    this.name = 'LabChamberCancelledError';
  }
}
