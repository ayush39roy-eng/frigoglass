/**
 * TanStack Query hooks for Workflow Settings (P9-T04). Every save writes the
 * returned full payload straight into the `workflow-settings` cache and
 * invalidates everything a settings change can stale: the Gantt (stale
 * chips), Capacity (supply figures), projects (schedule_stale), the reference
 * step templates and chambers. A settings change never auto-solves (ADR 0007
 * / 0009) — the page shows the stale count and the user recalculates.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import {
  fetchWorkflowSettings,
  retryUnlessAuth,
  saveChamber,
  saveHubCalendar,
  saveLeadTimes,
  saveSteps,
} from '../api/workflow-settings-api';
import type {
  ChamberSettingUpdateRequest,
  HubCalendarUpdateRequest,
  LeadTimesUpdateRequest,
  StepsUpdateRequest,
  WorkflowSettingsSaveResult,
} from '../api/types';

export function useWorkflowSettings() {
  return useQuery({
    queryKey: queryKeys.workflowSettings(),
    queryFn: ({ signal }) => fetchWorkflowSettings({ signal }),
    retry: retryUnlessAuth,
  });
}

function afterSave(queryClient: QueryClient, result: WorkflowSettingsSaveResult): void {
  queryClient.setQueryData(queryKeys.workflowSettings(), result.settings);
  for (const key of [['gantt'], ['capacity'], ['projects'], ['dashboard'], ['workflow-template'], ['chambers']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export function useSaveSteps() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, body }: { workflowId: string; body: StepsUpdateRequest }) =>
      saveSteps(workflowId, body),
    onSuccess: (result) => afterSave(queryClient, result),
  });
}

export function useSaveLeadTimes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LeadTimesUpdateRequest) => saveLeadTimes(body),
    onSuccess: (result) => afterSave(queryClient, result),
  });
}

export function useSaveHubCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ hubId, body }: { hubId: string; body: HubCalendarUpdateRequest }) =>
      saveHubCalendar(hubId, body),
    onSuccess: (result) => afterSave(queryClient, result),
  });
}

export function useSaveChamber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chamberId, body }: { chamberId: string; body: ChamberSettingUpdateRequest }) =>
      saveChamber(chamberId, body),
    onSuccess: (result) => afterSave(queryClient, result),
  });
}
