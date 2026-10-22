import * as React from 'react';

import type { WorkflowStepKind } from '@/types/enums';

import type { GanttProjectRow, GanttStepRow, StepTimingRequest, TimingEditable } from '../../api/types';

/**
 * The step a timing change acts on (ADR 0019). Every field is display data
 * from the served `GET /gantt` row; the browser never decides what is
 * editable (`timing_editable` is served) or where the bar lands.
 */
export interface StepTimingTarget {
  projectId: string;
  projectName: string;
  stepId: string;
  stepName: string;
  /** Served step kind: only a `design` step is stretched by FTE (ADR 0032). */
  kind: WorkflowStepKind;
  timingEditable: TimingEditable;
  /** The bar as served: CALENDAR weeks. */
  plannedStartWeek: number | null;
  plannedEndWeek: number | null;
  /** Served effective duration (`duration_weeks`): WORK weeks (ADR 0032). */
  durationWeeks: number | null;
  /**
   * Served `span_fte`: the FTE this step's calendar span is stretched by
   * (ADR 0032), or `null` (not stretched, or withheld from a caller who may
   * not edit timing). With it the right-edge drag converts calendar weeks to
   * work weeks; with `null` it keeps the 1:1 week mapping and the labels say
   * the calendar span follows the leader's FTE.
   */
  spanFte: number | null;
  /** Served lead-time table value. */
  leadTimeWeeks: number;
  /** The USER's duration (ADR 0041 R4): the only duration "Reset timing" clears. */
  durationOverrideWeeks: number | null;
  /** P30: the step's share of the client effort figure (served, never a user
   *  edit); what "Reset timing" falls back to. 0 = skipped by the split. */
  effortWeeks: number | null;
  startNotBeforeWeek: number | null;
}

export function stepTimingTarget(project: GanttProjectRow, step: GanttStepRow): StepTimingTarget {
  return {
    projectId: project.project_id,
    projectName: project.project_name,
    stepId: step.step_id,
    stepName: step.step_name,
    kind: step.kind,
    timingEditable: step.timing_editable,
    plannedStartWeek: step.planned_start_week,
    plannedEndWeek: step.planned_end_week,
    durationWeeks: step.duration_weeks,
    // A server that predates P20-T02 omits the field: treat it as not served
    // (null), never as `undefined` (which leaked "at undefined FTE" into labels).
    spanFte: step.span_fte ?? null,
    leadTimeWeeks: step.lead_time_weeks,
    durationOverrideWeeks: step.duration_override_weeks,
    // An older API (before P30) omits the field: no effort value.
    effortWeeks: step.effort_weeks ?? null,
    startNotBeforeWeek: step.start_not_before_week,
  };
}

/**
 * `true` when the step carries a planner override or floor (the "edited"
 * marker). P30 (ADR 0041 R4): reads ONLY the user's two fields; an effort
 * value (`effort_weeks`) is the client's figure, never a timing edit.
 */
export function hasTimingEdit(step: Pick<GanttStepRow, 'duration_override_weeks' | 'start_not_before_week'>): boolean {
  return step.duration_override_weeks !== null || step.start_not_before_week !== null;
}

/** The optimistic ghost shown at the drop position while the PATCH is in flight. */
export interface PendingGhost {
  projectId: string;
  stepId: string;
  startWeek: number;
  endWeek: number;
}

export interface StepTimingApi {
  /** Send a timing change (drag drop or dialog). Ignored while busy. */
  submit: (target: StepTimingTarget, body: StepTimingRequest, ghost?: { startWeek: number; endWeek: number }) => void;
  /** Open the keyboard "Edit timing" dialog for a step. */
  openDialog: (target: StepTimingTarget) => void;
  /** The ghost kept while a dropped change is being saved; `null` otherwise. */
  pending: PendingGhost | null;
  /** A change is being saved or its run is being followed. */
  busy: boolean;
}

export const StepTimingContext = React.createContext<StepTimingApi | null>(null);

/** The surrounding step-timing host, or `null` (read-only Gantt) when none is mounted. */
export function useStepTimingHost(): StepTimingApi | null {
  return React.useContext(StepTimingContext);
}
