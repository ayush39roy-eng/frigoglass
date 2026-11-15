import * as React from 'react';

import { SectionBoundary } from '@/components/shared/section-boundary';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api/client';
import { formatTimestamp } from '@/lib/format';
import { usePermission } from '@/stores/session';

import type { WorkflowSettings, WorkflowSettingsSaveResult } from '../api/types';
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
              onSaveSteps={(workflowId, body) => track(saveSteps.mutateAsync({ workflowId, body }))}
              onSaveCalendar={(hubId, body) => track(saveCalendar.mutateAsync({ hubId, body }))}
              onSaveChamber={(chamberId, body) => track(saveChamber.mutateAsync({ chamberId, body }))}
            />
          </>
        )}
      </SectionBoundary>
      {apply.element}
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
