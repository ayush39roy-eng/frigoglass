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
 * - "Project step timing" (first, owner 2026-11-04): per-project waterfall,
 *   read-only since P33-T15 (ADR 0048: timing follows the category template).
 *   Shown with `gantt` read.
 * - "Workflow templates": the P9-T04 settings — shown with `workflow_settings`
 *   or `workflow_templates` read. Admin and Super Admin edit the category
 *   templates (P33); Super Admin alone edits steps, calendars and chambers.
 * The tab is URL state (`?tab=templates`), as is the project (`?project=`).
 */
export default function WorkflowSettingsPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const canTiming = usePermission('gantt').read;
  // P33 (ADR 0045 §7): either surface shows the template tabs; each tab gates
  // its own writes (`workflow_templates` / `workflow_settings`).
  const canSettings = usePermission('workflow_settings').read;
  const canCategoryTemplates = usePermission('workflow_templates').read;
  const canTemplates = canSettings || canCategoryTemplates;

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
        description="See each project's step timing, or the workflow templates every project follows."
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
