import * as React from 'react';
import { Pencil } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useHubs } from '@/lib/api/reference';
import { formatCurrency, formatDecimal, formatWeek } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { PROJECT_TYPE_LABELS } from '@/types/enums';
import { updateProject } from '@/surfaces/registration/api/registration-api';
import type { ProjectCreateRequest } from '@/surfaces/registration/api/types';
import { ProjectForm } from '@/surfaces/registration/components/project-form';

import type { WorkspaceResponse } from '../api/types';
import { RESTRICTED } from '../lib/people';
import { ScoringSection } from './scoring-section';

/**
 * Details (docs/PROJECT_AND_STACK.md §2): every Project Registration field,
 * including the P9 planning fields, editable in place through the SAME form
 * Registration uses (`ProjectForm variant="inline"` — one schema, one submit
 * path, one PATCH /projects/{id}). Financial fields are shown to roles that can
 * read them and never logged or put in a URL. The 13 scoring dimensions follow.
 */
export function DetailsPanel({
  data,
  canEditDetails,
  canEditScores,
  financialsVisible,
}: {
  data: WorkspaceResponse;
  canEditDetails: boolean;
  canEditScores: boolean;
  /** `project_registration.read`. Without it the server nulls customer, TCOGS,
   *  selling price and gross margin — shown as "Restricted", not "—". */
  financialsVisible: boolean;
}): React.JSX.Element {
  const p = data.project;
  const money = (v: string): string => (financialsVisible ? v : RESTRICTED);
  const [editing, setEditing] = React.useState(false);
  const queryClient = useQueryClient();
  const hubsQuery = useHubs();
  const update = useMutation({
    mutationFn: (body: ProjectCreateRequest) => updateProject(p.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectWorkspace(p.id) });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  return (
    <Card data-testid="details-panel">
      <CardHeader>
        <CardTitle>Details</CardTitle>
        {canEditDetails && !editing ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil />
            Edit details
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        {editing ? (
          <ProjectForm
            variant="inline"
            mode="edit"
            project={p}
            hubs={hubsQuery.data ?? []}
            onOpenChange={(open) => setEditing(open)}
            onSubmit={(body) => update.mutateAsync(body)}
          />
        ) : (
          // P9-R03 (qa Q-F2): a <dl> may only contain dt/dd groups (or a div wrapping
          // exactly one dt + dd). The "Financial" sub-heading therefore sits BETWEEN
          // two lists as a real heading, not inside the <dl> as a div > span.
          <div className="space-y-2 text-xs" data-testid="details-read">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3" aria-label="Project details">
              <Field label="Status" value={<ProjectStatusBadge status={p.status} />} />
              <Field label="Hub" value={p.hub} />
              <Field label="Workflow" value={p.workflow_id} />
              <Field label="Category" value={p.category ?? '—'} />
              <Field label="Type" value={p.type ? PROJECT_TYPE_LABELS[p.type] : '—'} />
              <Field label="Priority" value={p.priority ?? '—'} />
              <Field label="Actual start week" value={p.actual_start_week === null ? '—' : formatWeek(p.actual_start_week)} />
              <Field label="Delay (weeks)" value={String(p.delay_weeks)} />
              <Field label="Expected completion (week)" value={p.target_end_week === null ? 'Process-derived' : formatWeek(p.target_end_week)} />
              <Field label="Certification testing" value={p.certification_testing_required ? 'Required' : 'Not required — lab steps skipped'} />
              <Field label="Estimated design weeks" value={p.estimated_design_weeks === null ? '—' : formatDecimal(p.estimated_design_weeks)} />
              <Field label="Estimated lab weeks" value={p.estimated_lab_weeks === null ? '—' : formatDecimal(p.estimated_lab_weeks)} />
              <Field label="Registration year" value={p.reg_year === null ? '—' : String(p.reg_year)} />
              <Field label="Carried over" value={p.carry_over ? 'Yes' : 'No'} />
              <Field label="External code" value={p.external_code ?? '—'} />
              {p.comments ? <Field label="Comments" value={p.comments} wide /> : null}
            </dl>
            <h3 id="details-financial-heading" className="label-caps mt-1 border-t border-border pt-2 text-text-muted">
              Financial — commercially sensitive
            </h3>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3" aria-labelledby="details-financial-heading">
              <Field label="Customer" value={money(p.customer_name ?? '—')} />
              <Field label="TCOGS" value={money(p.tcogs_eur === null ? '—' : formatCurrency(p.tcogs_eur, 'EUR'))} />
              <Field label="Selling price" value={money(p.selling_price_eur === null ? '—' : formatCurrency(p.selling_price_eur, 'EUR'))} />
              <Field label="Gross margin" value={money(p.gross_margin_pct === null ? '—' : `${formatDecimal(p.gross_margin_pct)}%`)} />
              <Field label="CAPEX (kEUR)" value={p.capex_keur === null ? '—' : formatDecimal(p.capex_keur)} />
              <Field label="RM savings (kEUR)" value={p.rm_savings_keur === null ? '—' : formatDecimal(p.rm_savings_keur)} />
            </dl>
          </div>
        )}
        <ScoringSection key={JSON.stringify(data.priority_score)} projectId={p.id} score={data.priority_score} canWrite={canEditScores} />
      </CardContent>
    </Card>
  );
}

function Field({ label, value, wide }: { label: string; value: React.ReactNode; wide?: boolean }): React.JSX.Element {
  return (
    <div className={wide ? 'col-span-full' : undefined}>
      <dt className="text-2xs text-text-subtle">{label}</dt>
      <dd className="text-text">{value}</dd>
    </div>
  );
}
