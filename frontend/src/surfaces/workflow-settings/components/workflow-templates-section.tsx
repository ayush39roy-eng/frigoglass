import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { SectionBoundary } from '@/components/shared/section-boundary';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api/client';
import {
  CONFLICT_COPY,
  conflictLeafField,
  editConflicts,
  EditConflictDismissedError,
  keepMineBase,
  sendEditWithBase,
  type EditBase,
} from '@/lib/api/edit-conflict';
import { queryKeys } from '@/lib/query-keys';
import { useEditConflict } from '@/lib/use-edit-conflict';
import { formatTimestamp } from '@/lib/format';
import { usePermission } from '@/stores/session';

import type {
  ChamberSettingUpdateRequest,
  HubCalendarUpdateRequest,
  StepsUpdateRequest,
  WorkflowSettings,
  WorkflowSettingsSaveResult,
} from '../api/types';
import { AccessNotice } from './access-notice';
import { CalendarsTab } from './calendars-tab';
import { ChambersTab } from './chambers-tab';
import type { TemplateEditing } from './category-timeline';
import { LeadTimesTab } from './lead-times-tab';
import { StaleBanner } from './stale-banner';
import { StepsTab } from './steps-tab';
import { TimelinesTab } from './timelines-tab';
import { useTemplateApply } from '../hooks/use-template-apply';
import {
  useSaveChamber,
  useSaveHubCalendar,
  useSaveSteps,
  useWorkflowSettings,
} from '../hooks/use-workflow-settings';

/**
 * The workflow templates (P9-T04, contract §3; ADRs 0007–0009), moved out of
 * the page in P32-R04: steps & precedence, lead times, timeline previews, hub
 * calendars, chambers.
 *
 * Two write permissions since P33 (ADR 0045 §7, API_CONTRACT_P33 Part A):
 * - `workflow_templates.write` (Admin, Super Admin): the category templates —
 *   the Lead times tab and the Timeline previews editor (Move / Length,
 *   "+ Add category"). Both save through one apply (E2 → dialog → E3).
 * - `workflow_settings.write` (Super Admin): Steps & precedence, Hub calendars
 *   and Chambers. Their saves return the `X-Schedule-Stale-Count` header,
 *   shown as a persistent banner — those changes never re-schedule on their own.
 * Each tab says "Read-only for your role" only when that tab is read-only.
 */
export function WorkflowTemplatesSection(): React.JSX.Element {
  const settings = useWorkflowSettings();
  const { write: canWriteSettings } = usePermission('workflow_settings');
  const { write: canWriteTemplates } = usePermission('workflow_templates');
  const [staleCount, setStaleCount] = React.useState<number | null>(null);

  const saveSteps = useSaveSteps();
  const saveCalendar = useSaveHubCalendar();
  const saveChamber = useSaveChamber();
  const apply = useTemplateApply();

  const track = React.useCallback(async (p: Promise<WorkflowSettingsSaveResult>) => {
    const result = await p;
    setStaleCount(result.staleCount);
    return result;
  }, []);

  // P47 (ADR 0059): every Settings PUT carries `base`, the cached settings as
  // read (this surface does not poll, so the cache is what the editor started
  // from). A 409 EDIT_CONFLICT asks whose value to keep; "Use theirs" puts the
  // stored value in place of mine (these PUTs carry whole records).
  const conflict = useEditConflict();
  const queryClient = useQueryClient();
  const checkedPut = React.useCallback(
    async <B extends object>(
      body: B,
      original: object,
      send: (withBase: B & { base: EditBase }) => Promise<WorkflowSettingsSaveResult>,
    ): Promise<WorkflowSettingsSaveResult> => {
      const sent = await sendEditWithBase({
        body,
        original,
        send,
        ask: conflict.ask,
        replaceOnTheirs: true,
        onUseTheirs: () => queryClient.invalidateQueries({ queryKey: queryKeys.workflowSettings() }),
      });
      if (sent.outcome === 'saved') return sent.data;
      throw new EditConflictDismissedError(sent.outcome === 'theirs' ? CONFLICT_COPY.theirs : CONFLICT_COPY.dismissed);
    },
    [conflict.ask, queryClient],
  );
  const data = settings.data;
  const askConflict = conflict.ask;
  // The steps PUT carries `base` per step (`steps[i].base = {kind,
  // predecessor_ids}`); a conflict names the step (`entity: workflow_step`).
  const onSaveSteps = React.useCallback(
    (workflowId: string, body: StepsUpdateRequest) => {
      const read = new Map((data?.workflows.find((w) => w.id === workflowId)?.steps ?? []).map((st) => [st.step_id, st]));
      let steps = body.steps.map((st) => {
        const was = read.get(st.step_id);
        return was ? { ...st, base: { kind: was.kind, predecessor_ids: was.predecessor_ids } as EditBase } : st;
      });
      const run = async (): Promise<WorkflowSettingsSaveResult> => {
        for (;;) {
          try {
            return await saveSteps.mutateAsync({ workflowId, body: { steps } });
          } catch (err) {
            const conflicts = editConflicts(err);
            if (conflicts === null) throw err;
            const choice = await askConflict(conflicts);
            if (choice === null) throw new EditConflictDismissedError();
            steps = steps.map((st) => {
              const mine = conflicts.filter((c) => c.id === st.step_id);
              if (mine.length === 0 || !('base' in st) || !st.base) return st;
              const base = keepMineBase(st.base, mine);
              if (choice === 'mine') return { ...st, base };
              // "Use theirs": the stored value replaces mine for that field.
              const next: Record<string, unknown> = { ...st, base };
              for (const c of mine) next[conflictLeafField(c.field)] = c.current_value;
              return next as typeof st;
            });
            if (choice === 'theirs') {
              void queryClient.invalidateQueries({ queryKey: queryKeys.workflowSettings() });
              const mineLeft = steps.some(
                (st) =>
                  'base' in st &&
                  st.base &&
                  JSON.stringify({ kind: st.kind, predecessor_ids: st.predecessor_ids }) !== JSON.stringify(st.base),
              );
              if (!mineLeft) throw new EditConflictDismissedError(CONFLICT_COPY.theirs);
            }
          }
        }
      };
      return track(run());
    },
    [data, track, saveSteps, askConflict, queryClient],
  );
  const onSaveCalendar = React.useCallback(
    (hubId: string, body: HubCalendarUpdateRequest) => {
      const original = data?.hub_calendars.find((c) => c.hub_id === hubId) ?? {};
      return track(checkedPut(body, original, (withBase) => saveCalendar.mutateAsync({ hubId, body: withBase })));
    },
    [data, track, checkedPut, saveCalendar],
  );
  const onSaveChamber = React.useCallback(
    (chamberId: string, body: ChamberSettingUpdateRequest) => {
      const original = data?.chambers.find((c) => c.chamber_id === chamberId) ?? {};
      return track(checkedPut(body, original, (withBase) => saveChamber.mutateAsync({ chamberId, body: withBase })));
    },
    [data, track, checkedPut, saveChamber],
  );

  const denied =
    settings.error instanceof ApiError
      ? settings.error.isForbidden
        ? 'forbidden'
        : settings.error.isUnauthorized
          ? 'unauthorized'
          : null
      : null;

  if (denied) return <AccessNotice kind={denied} />;

  const settingsNotice = (
    <ReadOnlyNotice surface="workflow_settings" what="Changing steps & precedence, hub calendars and chambers (Super Admin only)" />
  );
  const templatesNotice = (
    <ReadOnlyNotice surface="workflow_templates" what="Changing the category templates (Admin and Super Admin)" />
  );

  return (
    <div className="flex flex-col gap-4">
      {staleCount !== null ? <StaleBanner count={staleCount} onDismiss={() => setStaleCount(null)} /> : null}
      <SectionBoundary query={settings} title="Workflow settings" errorDescription="Workflow settings could not be loaded.">
        {(data) => (
          <>
            <p className="text-2xs text-text-muted" data-numeric="">
              {/* ADR 0024: a 52-week year is presented; the served internal
                  search horizon (`horizon_weeks`) is not shown. */}
              Planning week W{data.current_week} of {data.within_year_week} · within-year by W
              {data.within_year_week}, later work is spillover · last changed {formatTimestamp(data.updated_at)}
              {data.updated_by ? ` by ${data.updated_by}` : ''}
            </p>
            <TemplateTabs
              data={data}
              canWriteSettings={canWriteSettings}
              canWriteTemplates={canWriteTemplates}
              settingsNotice={settingsNotice}
              templatesNotice={templatesNotice}
              apply={apply}
              saving={{ steps: saveSteps.isPending, calendar: saveCalendar.isPending, chamber: saveChamber.isPending }}
              onSaveSteps={onSaveSteps}
              onSaveCalendar={onSaveCalendar}
              onSaveChamber={onSaveChamber}
            />
          </>
        )}
      </SectionBoundary>
      {apply.element}
      {conflict.dialog}
    </div>
  );
}

function TemplateTabs({
  data,
  canWriteSettings,
  canWriteTemplates,
  settingsNotice,
  templatesNotice,
  apply,
  saving,
  onSaveSteps,
  onSaveCalendar,
  onSaveChamber,
}: {
  data: WorkflowSettings;
  canWriteSettings: boolean;
  canWriteTemplates: boolean;
  settingsNotice: React.ReactNode;
  templatesNotice: React.ReactNode;
  apply: ReturnType<typeof useTemplateApply>;
  saving: { steps: boolean; calendar: boolean; chamber: boolean };
  onSaveSteps: React.ComponentProps<typeof StepsTab>['onSave'];
  onSaveCalendar: React.ComponentProps<typeof CalendarsTab>['onSave'];
  onSaveChamber: React.ComponentProps<typeof ChambersTab>['onSave'];
}): React.JSX.Element {
  const versions = React.useMemo(
    () => Object.fromEntries(data.categories.map((c) => [c.code, c.template_version])),
    [data.categories],
  );
  const { start, busy } = apply;
  const editing = React.useMemo<TemplateEditing>(
    () => ({
      canWrite: canWriteTemplates,
      leadTimes: data.lead_times,
      versions,
      saving: busy,
      onSave: (entry, summary, onApplied) => start({ changes: [entry] }, { summary, onApplied }),
    }),
    [busy, canWriteTemplates, data.lead_times, start, versions],
  );

  return (
    <Tabs defaultValue="steps">
      <TabsList>
        <TabsTrigger value="steps">Steps &amp; precedence</TabsTrigger>
        <TabsTrigger value="lead-times">Lead times</TabsTrigger>
        <TabsTrigger value="timelines">Timeline previews</TabsTrigger>
        <TabsTrigger value="calendars">Hub calendars</TabsTrigger>
        <TabsTrigger value="chambers">Chambers</TabsTrigger>
      </TabsList>
      <TabsContent value="steps" className="space-y-3">
        {settingsNotice}
        <StepsTab workflows={data.workflows} canWrite={canWriteSettings} saving={saving.steps} onSave={onSaveSteps} />
      </TabsContent>
      <TabsContent value="lead-times" className="space-y-3">
        {templatesNotice}
        <LeadTimesTab
          workflows={data.workflows}
          leadTimes={data.lead_times}
          versions={versions}
          canWrite={canWriteTemplates}
          saving={busy}
          onSave={(changeSet, summary, onApplied) => start(changeSet, { summary, onApplied })}
        />
      </TabsContent>
      <TabsContent value="timelines" className="space-y-3">
        {templatesNotice}
        {/* P13-T16 previews; P33-T16 editor; P33-T18 "+ Add category". */}
        <TimelinesTab editing={editing} categories={data.categories} />
      </TabsContent>
      <TabsContent value="calendars" className="space-y-3">
        {settingsNotice}
        <CalendarsTab calendars={data.hub_calendars} canWrite={canWriteSettings} saving={saving.calendar} onSave={onSaveCalendar} />
      </TabsContent>
      <TabsContent value="chambers" className="space-y-3">
        {settingsNotice}
        <ChambersTab chambers={data.chambers} canWrite={canWriteSettings} saving={saving.chamber} onSave={onSaveChamber} />
      </TabsContent>
    </Tabs>
  );
}
