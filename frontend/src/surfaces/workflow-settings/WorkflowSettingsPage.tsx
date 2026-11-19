import * as React from 'react';
import { useSearchParams } from 'react-router-dom';

import { PageHeader } from '@/components/layout/page-header';
import { SURFACES } from '@/app/nav';
import { usePermission } from '@/stores/session';

import { AccessNotice } from './components/access-notice';
import { WorkflowTemplatesSection } from './components/workflow-templates-section';
import { SchedulingHorizonCard } from './components/scheduling-horizon/scheduling-horizon-card';

const SURFACE = SURFACES.find((s) => s.path === '/settings/workflow');

/**
 * The query parameters of the retired "Project step timing" tab (P32-R04,
 * removed at the owner's request 2026-11-16): `?tab=` picked the tab and
 * `?project=` expanded one project. Old deep links land on the templates.
 */
const RETIRED_PARAMS = ['tab', 'project'] as const;

/**
 * Workflow (P9-T04): the workflow templates — shown with `workflow_settings`
 * or `workflow_templates` read (P33, ADR 0045 §7). Admin and Super Admin edit
 * the category templates; Super Admin alone edits steps, calendars and
 * chambers. Per-project step timing is read on the Timeline (`/timeline`).
 */
export default function WorkflowSettingsPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const canSettings = usePermission('workflow_settings').read;
  const canCategoryTemplates = usePermission('workflow_templates').read;
  const canTemplates = canSettings || canCategoryTemplates;

  const hasRetired = RETIRED_PARAMS.some((p) => params.has(p));
  React.useEffect(() => {
    if (!hasRetired) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const p of RETIRED_PARAMS) next.delete(p);
        return next;
      },
      { replace: true },
    );
  }, [hasRetired, setParams]);

  return (
    <>
      <PageHeader
        title={SURFACE?.title ?? 'Workflow Settings'}
        description="The workflow templates every project follows: steps and precedence, lead times, category timelines, hub calendars and chambers."
      />
      {/* P53 (ADR 0063, R53-2): the scheduling search limit N (Admin setting). */}
      {canTemplates ? <SchedulingHorizonCard /> : null}
      {canTemplates ? <WorkflowTemplatesSection /> : <AccessNotice kind="forbidden" />}
    </>
  );
}
