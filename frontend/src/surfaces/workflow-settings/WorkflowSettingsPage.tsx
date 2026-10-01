import * as React from 'react';

import { PageHeader } from '@/components/layout/page-header';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api/client';
import { formatTimestamp } from '@/lib/format';
import { SURFACES } from '@/app/nav';
import { usePermission } from '@/stores/session';

import type { WorkflowSettingsSaveResult } from './api/types';
import { AccessNotice } from './components/access-notice';
import { CalendarsTab } from './components/calendars-tab';
import { ChambersTab } from './components/chambers-tab';
import { LeadTimesTab } from './components/lead-times-tab';
import { StaleBanner } from './components/stale-banner';
import { StepsTab } from './components/steps-tab';
import {
  useSaveChamber,
  useSaveHubCalendar,
  useSaveLeadTimes,
  useSaveSteps,
  useWorkflowSettings,
} from './hooks/use-workflow-settings';

const SURFACE = SURFACES.find((s) => s.path === '/settings/workflow');

/**
 * Workflow Settings (P9-T04, contract §3; ADRs 0007–0009). Four tabs: steps &
 * precedence, lead times, hub calendars, chambers. Writes are Super Admin only
 * (`workflow_settings.write`); Admin sees everything read-only. Every save
 * returns the full payload and the `X-Schedule-Stale-Count` header, shown as a
 * persistent banner — a settings change never re-schedules on its own.
 */
export default function WorkflowSettingsPage(): React.JSX.Element {
  const settings = useWorkflowSettings();
  const { write: canWrite } = usePermission('workflow_settings');
  const [staleCount, setStaleCount] = React.useState<number | null>(null);

  const saveSteps = useSaveSteps();
  const saveLeadTimes = useSaveLeadTimes();
  const saveCalendar = useSaveHubCalendar();
  const saveChamber = useSaveChamber();

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

  return (
    <>
      <PageHeader
        title={SURFACE?.title ?? 'Workflow Settings'}
        description={SURFACE?.summary ?? 'Step kinds, precedence, lead times, calendars and chamber downtime.'}
      />
      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          <ReadOnlyNotice surface="workflow_settings" what="Changing workflow settings (Super Admin only)" />
          {staleCount !== null ? <StaleBanner count={staleCount} onDismiss={() => setStaleCount(null)} /> : null}
          <SectionBoundary query={settings} title="Workflow settings" errorDescription="Workflow settings could not be loaded.">
            {(data) => (
              <>
                <p className="text-2xs text-text-muted" data-numeric="">
                  Planning week W{data.current_week} · horizon {data.horizon_weeks} weeks · within-year by W
                  {data.within_year_week} · last changed {formatTimestamp(data.updated_at)}
                  {data.updated_by ? ` by ${data.updated_by}` : ''}
                </p>
                <Tabs defaultValue="steps">
                  <TabsList>
                    <TabsTrigger value="steps">Steps &amp; precedence</TabsTrigger>
                    <TabsTrigger value="lead-times">Lead times</TabsTrigger>
                    <TabsTrigger value="calendars">Hub calendars</TabsTrigger>
                    <TabsTrigger value="chambers">Chambers</TabsTrigger>
                  </TabsList>
                  <TabsContent value="steps">
                    <StepsTab
                      workflows={data.workflows}
                      canWrite={canWrite}
                      saving={saveSteps.isPending}
                      onSave={(workflowId, body) => track(saveSteps.mutateAsync({ workflowId, body }))}
                    />
                  </TabsContent>
                  <TabsContent value="lead-times">
                    <LeadTimesTab
                      workflows={data.workflows}
                      leadTimes={data.lead_times}
                      canWrite={canWrite}
                      saving={saveLeadTimes.isPending}
                      onSave={(body) => track(saveLeadTimes.mutateAsync(body))}
                    />
                  </TabsContent>
                  <TabsContent value="calendars">
                    <CalendarsTab
                      calendars={data.hub_calendars}
                      canWrite={canWrite}
                      saving={saveCalendar.isPending}
                      onSave={(hubId, body) => track(saveCalendar.mutateAsync({ hubId, body }))}
                    />
                  </TabsContent>
                  <TabsContent value="chambers">
                    <ChambersTab
                      chambers={data.chambers}
                      canWrite={canWrite}
                      saving={saveChamber.isPending}
                      onSave={(chamberId, body) => track(saveChamber.mutateAsync({ chamberId, body }))}
                    />
                  </TabsContent>
                </Tabs>
              </>
            )}
          </SectionBoundary>
        </div>
      )}
    </>
  );
}
