import * as React from 'react';
import { HelpCircle } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/**
 * "Auto-assign" (`docs/PROJECT_AND_STACK.md` §2: bulk resource assignment via
 * the CP-SAT optimizer, `POST /schedule-runs/cp-sat-dispatch`) is
 * DELIBERATELY NOT WIRED into this surface.
 *
 * `docs/OPEN_QUESTIONS.md` #10 is explicitly blocking for this exact feature,
 * not for any task before it: under ADR 0005's provisional CP-SAT objective,
 * the optimizer can — and, confirmed live on the real 46-project seed
 * dataset, DOES — silently return `left_out=True, steps=()` for a
 * schedulable P1 project (`26-00201`, a customer-certification-at-risk
 * project) in order to lift other projects' within-year completion, a
 * decision the client has not yet been asked to bless. "Auto-assign" would be
 * the first feature in this application that exposes that CP-SAT-optimized
 * schedule to a real user, per `docs/OPEN_QUESTIONS.md` #10's own text
 * ("CP-SAT must not be wired into a user-facing 'Auto-assign' action until
 * this is resolved").
 *
 * This is the same category of decision as `docs/OPEN_QUESTIONS.md` #8's
 * GDPR block on named-engineer utilization (`engineer-utilization-
 * placeholder.tsx`, RPD Capacity, P4-T03/P4-T08): a client/portfolio-owner
 * decision this session is not authorized to make an engineering default
 * for, surfaced as a visible, honest placeholder rather than a broken or
 * half-built button. Per the orchestrator's explicit scope instruction for
 * this task (P4-T07), this component intentionally never imports
 * `triggerApplyLogic`/`dispatch_cp_sat_run`-equivalent code — there is no
 * "Auto-assign" fetcher anywhere in `api/planning-api.ts`.
 */
export function AutoAssignPlaceholder(): React.JSX.Element {
  return (
    <EmptyState
      media={<HelpCircle className="size-8" />}
      title="Auto-assign is pending a client decision"
      description="CP-SAT's optimizer can drop a schedulable, customer-certification-at-risk P1 project entirely to lift other projects within-year (docs/OPEN_QUESTIONS.md #10). This bulk resource-assignment action is withheld until the portfolio/commercial owner decides whether that trade-off is acceptable, and if not, how it should be constrained. Apply Logic (above) — the deterministic, rule-based scheduler — is available today."
    />
  );
}
