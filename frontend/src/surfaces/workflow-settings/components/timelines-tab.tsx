import * as React from 'react';
import { Plus } from 'lucide-react';

import { SectionBoundary } from '@/components/shared/section-boundary';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Category } from '@/lib/category-catalog';
import { WORKFLOW_IDS, type WorkflowId } from '@/types/enums';

import { useBEquivalent, useCategoryTimelines } from '../hooks/use-workflow-settings';
import { TEMPLATE_COPY } from '../lib/template-copy';
import { AddCategoryDialog } from './add-category-dialog';
import { BEquivalentPanel } from './b-equivalent-panel';
import { CategoryTimelineList, type TemplateEditing } from './category-timeline';

/**
 * "Timeline previews" tab (P13-T16; the category template editor since
 * P33-T16, "+ Add category" since P33-T18): per-category mini-Gantts and the
 * B-equivalent panel for one workflow at a time, all served (API_CONTRACT_P33
 * C2 / D). With `workflow_templates.write` every step row has Move / Length
 * buttons and the header has "+ Add category"; other roles read.
 */
export function TimelinesTab({
  editing,
  categories,
}: {
  editing?: TemplateEditing | undefined;
  /** Every category in rank order (C1), for "+ Add category". */
  categories?: readonly Category[] | undefined;
}): React.JSX.Element {
  const [workflow, setWorkflow] = React.useState<WorkflowId>('PDD');
  const [openCategory, setOpenCategory] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const timelines = useCategoryTimelines(workflow);
  const bEquivalent = useBEquivalent(workflow);
  const toggleId = React.useId();
  const canWrite = editing?.canWrite ?? false;

  return (
    <div className="space-y-4">
      <div className="space-y-s2">
        {/* Header row: the workflow switch on the left, the tab's primary
            action ("+ Add category", owner 2026-11-16: standard-size primary,
            not a small outline pill) on the right. */}
        <div className="flex flex-wrap items-center justify-between gap-s3">
          <div className="flex flex-wrap items-center gap-s3">
            <Label htmlFor={toggleId} className="text-2xs text-text-muted">
              Workflow
            </Label>
            <ToggleGroup
              id={toggleId}
              type="single"
              size="sm"
              value={workflow}
              aria-label="Workflow"
              onValueChange={(next) => {
                if ((WORKFLOW_IDS as readonly string[]).includes(next)) setWorkflow(next as WorkflowId);
              }}
            >
              <ToggleGroupItem value="PDD">Standard PDD</ToggleGroupItem>
              <ToggleGroupItem value="OEM">OEM</ToggleGroupItem>
            </ToggleGroup>
          </div>
          {canWrite && categories ? (
            <Button
              type="button"
              variant="primary"
              size="md"
              data-testid="add-category-button"
              aria-haspopup="dialog"
              onClick={() => setAdding(true)}
            >
              <Plus aria-hidden="true" />
              Add category
            </Button>
          ) : null}
        </div>
        <p className="text-2xs text-text-subtle">
          Earliest start of every step over the precedence graph, from the category template only: capacity is not
          applied. Week 0 is the project start.{canWrite ? ` ${TEMPLATE_COPY.editorIntro}` : ''}
        </p>
      </div>
      <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <section aria-labelledby={`${toggleId}-timelines`} className="min-w-0 space-y-s3">
          <h2 id={`${toggleId}-timelines`} className="text-2xs font-bold uppercase tracking-wider text-text-subtle">
            Per-category timelines
          </h2>
          <SectionBoundary
            query={timelines}
            title="Per-category timelines"
            errorDescription="The category timelines could not be loaded."
          >
            {(data) => <CategoryTimelineList timelines={data} editing={editing} openCategory={openCategory} />}
          </SectionBoundary>
        </section>
        <div className="min-w-0">
          <SectionBoundary
            query={bEquivalent}
            title="B-equivalent workload"
            errorDescription="The B-equivalent workload could not be loaded."
          >
            {(rows) => <BEquivalentPanel workflow={workflow} rows={rows} />}
          </SectionBoundary>
        </div>
      </div>
      {canWrite && categories ? (
        <AddCategoryDialog
          open={adding}
          onOpenChange={setAdding}
          categories={categories}
          defaultWorkflow={workflow}
          onCreated={(c) => {
            // Open the new category's timeline once the refreshed list arrives.
            setWorkflow(c.workflow_id);
            setOpenCategory(c.code);
          }}
        />
      ) : null}
    </div>
  );
}
