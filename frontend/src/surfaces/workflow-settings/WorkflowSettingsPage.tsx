import * as React from 'react';
import { useSearchParams } from 'react-router-dom';

import { PageHeader } from '@/components/layout/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SURFACES } from '@/app/nav';
import { usePermission } from '@/stores/session';

import { AccessNotice } from './components/access-notice';
import { ProjectStepTimingSection } from './components/project-step-timing/project-step-timing-section';
import { WorkflowTemplatesSection } from './components/workflow-templates-section';

const SURFACE = SURFACES.find((s) => s.path === '/settings/workflow');

type WorkflowTab = 'project-timing' | 'templates';

/**
 * Workflow (P9-T04; P32-R04). Two tabs:
 * - "Project step timing" (first — owner 2026-11-04: this is where step bars
 *   are mainly dragged): per-project waterfall with the Timeline's editing.
 *   Shown with `gantt` read; editing is the served `timing_editable`.
 * - "Workflow templates": the P9-T04 settings, unchanged — shown with
 *   `workflow_settings` read (Admin reads, Super Admin edits).
 * The tab is URL state (`?tab=templates`), as is the project (`?project=`).
 */
export default function WorkflowSettingsPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const canTiming = usePermission('gantt').read;
  const canTemplates = usePermission('workflow_settings').read;

  const requested = params.get('tab') === 'templates' ? 'templates' : 'project-timing';
  const tab: WorkflowTab =
    requested === 'templates' && canTemplates ? 'templates' : canTiming ? 'project-timing' : 'templates';

  const setTab = React.useCallback(
    (value: string) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value === 'templates') next.set('tab', 'templates');
        else next.delete('tab');
        return next;
      });
    },
    [setParams],
  );

  return (
    <>
      <PageHeader
        title={SURFACE?.title ?? 'Workflow Settings'}
        description="Adjust one project's step timing, or the workflow templates every project follows."
      />
      {!canTiming && !canTemplates ? (
        <AccessNotice kind="forbidden" />
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            {canTiming ? <TabsTrigger value="project-timing">Project step timing</TabsTrigger> : null}
            {canTemplates ? <TabsTrigger value="templates">Workflow templates</TabsTrigger> : null}
          </TabsList>
          {canTiming ? (
            <TabsContent value="project-timing">
              <ProjectStepTimingSection />
            </TabsContent>
          ) : null}
          {canTemplates ? (
            <TabsContent value="templates">
              <WorkflowTemplatesSection />
            </TabsContent>
          ) : null}
        </Tabs>
      )}
    </>
  );
}
