import * as React from 'react';
import { Play } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatInteger } from '@/lib/format';

import type { GreedyRecalcResponse } from '../api/types';
import { ConfirmDialog } from './confirm-dialog';

/**
 * "Apply Logic" (`docs/PROJECT_AND_STACK.md` §2: "An 'Apply Logic' action and
 * an 'Auto-assign' action for bulk resource assignment").
 *
 * **Why this calls `POST /schedule-runs/greedy-recalc`, not a bespoke
 * endpoint**: no endpoint named "apply logic" exists in the backend — grep
 * confirms `backend/api/routers/engineers.py` and `chambers.py` explicitly
 * disclaim it ("'Apply Logic' / 'Auto-assign' are explicitly OUT OF SCOPE...
 * there is no 'apply logic' endpoint at all yet"), and
 * `backend/api/routers/schedule_runs.py`'s own module docstring only
 * disclaims "Apply Priorities" (the Matrix's band-recompute action) and
 * "Auto-assign" (the CP-SAT path) by name — it does not disclaim being used
 * as Apply Logic. Reading `docs/PROJECT_AND_STACK.md` §2's phrasing
 * literally — "An 'Apply Logic' action AND an 'Auto-assign' action FOR bulk
 * resource assignment" — both named actions recompute resource assignment
 * from the current Engineer/Chamber/Project data, differing only in which
 * algorithm decides the assignment: "Logic" = the deterministic, rule-based
 * greedy SGS scheduler that implements `docs/DOMAIN_RULES.md`'s booking rules
 * verbatim ("apply the logic"); "Auto-assign" = the autonomous CP-SAT
 * optimizer (`POST /schedule-runs/cp-sat-dispatch`) deciding assignment on
 * its own. This reading is also the only one consistent with why
 * `docs/OPEN_QUESTIONS.md` #10 blocks Auto-assign specifically and not this
 * action: OQ#10 is about the CP-SAT objective silently dropping a
 * schedulable P1 project, a CP-SAT-only failure mode (confirmed in
 * `docs/MEMORY.md`'s P2-T07 entry) that does not apply to the greedy path.
 *
 * **Flagged for orchestrator/backend-builder review — not a silent
 * assumption**: this is an interpretation of an undocumented term, not a
 * confirmed contract. If backend-builder or the orchestrator intended a
 * dedicated "Apply Logic" endpoint distinct from the existing
 * "recompute-now" primitive, this wiring should be revisited rather than
 * treated as settled.
 *
 * **RBAC gap, also flagged**: `POST /schedule-runs/greedy-recalc` requires
 * `RoleName.ADMIN` specifically (`schedule_runs.py::_admin_only`), not
 * `CAPACITY_PLANNING` `WRITE` — so a Hub Planner, who per
 * `docs/PROJECT_AND_STACK.md` §5 has read/write on Capacity Planning (and can
 * therefore edit engineers/chambers on this very surface), will get a 403 on
 * this specific action. Handled here the same way every other P4 surface
 * handles a role-matrix vs. endpoint-RBAC mismatch (Matrix/Registration's
 * "canEdit default-true + 403-downgrade" pattern, `docs/MEMORY.md`'s P4-T04
 * review): the button is shown to anyone with Capacity Planning WRITE, and a
 * 403 downgrades to an inline notice rather than silently hiding the action
 * from a role the written spec says should have it.
 *
 * Whole-portfolio, not hub-scoped (same as every other `schedule-runs`
 * mutation) — confirmed with a dialog before firing, since it recomputes AND
 * ACTIVATES a new schedule for every hub, replacing what the
 * Dashboard/Capacity/Gantt currently show.
 */
export function ApplyLogicCard({
  canEdit,
  provenance,
  onApply,
  isApplying,
  lastResult,
  errorMessage,
}: {
  canEdit: boolean;
  provenance: { version: number; solverType: string } | null;
  onApply: () => Promise<void>;
  isApplying: boolean;
  lastResult: GreedyRecalcResponse | null;
  errorMessage: string | null;
}): React.JSX.Element {
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Apply Logic</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-muted">
          Recomputes the schedule over every current project, engineer and chamber using the
          deterministic scheduling logic (the greedy serial schedule-generation scheme,{' '}
          <span className="italic">docs/DOMAIN_RULES.md</span>&apos;s booking rules), then activates
          it as the live schedule. This is a whole-portfolio action — it replaces what the
          Dashboard, RPD Capacity and the Timeline currently show for every hub, not just yours.
        </p>
        {provenance ? (
          <p className="text-2xs text-text-muted" data-numeric="">
            Active schedule: version {formatInteger(provenance.version)} ({provenance.solverType})
          </p>
        ) : (
          <p className="text-2xs text-text-subtle">No schedule has been computed yet.</p>
        )}

        {canEdit ? (
          <Button type="button" size="sm" onClick={() => setConfirmOpen(true)} disabled={isApplying}>
            <Play />
            {isApplying ? 'Applying…' : 'Apply Logic'}
          </Button>
        ) : (
          <p className="text-2xs text-text-muted">
            Applying the scheduling logic is limited to Hub Planners and Admins.
          </p>
        )}

        {errorMessage ? (
          <p role="alert" className="text-2xs text-danger">
            {errorMessage}
          </p>
        ) : null}

        {lastResult ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-border bg-surface-sunken p-3 text-2xs sm:grid-cols-4">
            <ResultStat label="Projects" value={lastResult.project_count} />
            <ResultStat label="Within year" value={lastResult.within_year_count} />
            <ResultStat label="Spillover" value={lastResult.spillover_count} />
            <ResultStat label="Left out" value={lastResult.left_out_count} />
          </dl>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Apply Logic across the whole portfolio?"
        description="This recomputes and activates a new schedule for every hub using the current engineer and chamber configuration. The Dashboard, RPD Capacity and Timeline surfaces will immediately reflect the new schedule for every user."
        confirmLabel="Apply Logic"
        busy={isApplying}
        onConfirm={() => {
          setConfirmOpen(false);
          void onApply();
        }}
      />
    </Card>
  );
}

function ResultStat({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div>
      <dt className="text-text-subtle">{label}</dt>
      <dd className="tnum font-semibold text-text" data-numeric="">
        {formatInteger(value)}
      </dd>
    </div>
  );
}
