# ADR 0017: The "Blocked" stage state is shown to users as "On Hold"

## Status

Accepted (2026-10-09). Part of P11. Changes labels only. Scheduling behaviour (DOMAIN_RULES
"How progress feeds a schedule run", ruling 5) is unchanged.

## Context

Frigoglass asked (relayed 2026-10-09): "Instead of blocked it should be on hold." Their own
workbook vocabulary has "On hold" and no "Blocked" (`docs/CLIENT_FORMULAS.md` §3). "Blocked"
appears in the UI as a stage status, the reason field, a health badge, a Dashboard bucket, a Gantt
badge and a notification.

## Decision

1. **Every user-facing "Blocked" becomes "On Hold"**:
   - stage status option and chip;
   - "Blocked reason" → "Hold reason";
   - health badge ⏸ On Hold;
   - the Dashboard bucket, tile and donut segment;
   - the Gantt step badge;
   - the notification text ("…stage X is on hold — reason");
   - Workspace activity summaries;
   - the Ask-the-agent context, so the agent says "on hold";
   - Excel exports.
2. **Stored and wire values do not change.** These stay as they are: `WorkflowStepStatus.BLOCKED
   = "Blocked"`, `blocked_reason`, `ScheduleRunProjectOutcome.blocked`, `blocked_count`,
   `NotificationReason.STAGE_BLOCKED`, the health value `"blocked"`. There is no migration, no
   scheduler change and no API break. The label lives in one map per side: a backend display-label
   helper for server-generated text, and the frontend's existing status/health meta maps.
3. **Two kinds of "On Hold" are kept distinct in the UI.** The project-level status `On Hold`
   already exists: the whole project is paused and taken out of the plan (DOMAIN_RULES "Booking
   rules"). A stage on hold is different: the project stays in the plan and waits at that stage.
   Wherever both could be confused, the stage-level one carries the qualifier "at a stage":
   - the Dashboard tile caption reads "In the plan, waiting at a stage";
   - the status overview's note keeps listing status-On-Hold projects as "paused (status On Hold)".

## Consequences

- The client sees one word for one idea, and no data changes hands.
- The API still says `Blocked`. Anyone integrating against the API or reading exports by code
  sees the old token. The display label is the only change.
- Should the Dashboard "On Hold" tile also count projects whose *status* is On Hold? Open as
  `docs/OPEN_QUESTIONS.md` #27. Until answered it counts stage holds only, as Blocked did.
