import * as React from 'react';
import { FilterX, Plus, Search } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { StatStrip } from '@/components/ui/stat-variants';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { usePriorityMoveFlow } from '@/components/shared/priority-move/use-priority-move-flow';
import { applyFormPriorityMove } from '@/components/shared/priority-move/form-priority-move';
import { ApiError } from '@/lib/api/client';
import { useHubs } from '@/lib/api/reference';
import { formatInteger } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { SURFACES } from '@/app/nav';
import { usePermission } from '@/stores/session';
import { PROJECT_CATEGORIES, PROJECT_PRIORITIES, PROJECT_STATUSES, PROJECT_TYPES, PROJECT_TYPE_LABELS } from '@/types/enums';
import type { ProjectStatus } from '@/types/enums';

import { AccessNotice, WriteForbiddenNotice } from './components/access-notice';
import { ProjectFormDialog } from './components/project-form';
import { ProjectList, type ProjectRow } from './components/project-list';
import { useEngineerOptions, useProjectList, useCreateProject, useSubmitProject, useUpdateProject } from './hooks/use-registration';
import { useEditDeepLink } from './hooks/use-edit-deep-link';
import type { ProjectCreateRequest, ProjectRead } from './api/types';

const REGISTRATION_SURFACE = SURFACES.find((s) => s.path === '/register');
const ALL = '__all__';
/** P13-T17: the server caps `q` at 100 characters (API_CONTRACT_P13 §3). */
const SEARCH_MAX = 100;

function authKind(errors: unknown[]): 'forbidden' | 'unauthorized' | null {
  for (const err of errors) {
    if (err instanceof ApiError && err.isForbidden) return 'forbidden';
  }
  for (const err of errors) {
    if (err instanceof ApiError && err.isUnauthorized) return 'unauthorized';
  }
  return null;
}

export default function RegistrationPage(): React.JSX.Element {
  const [hubId, setHubId] = React.useState<string>(ALL);
  const [category, setCategory] = React.useState<string>(ALL);
  const [status, setStatus] = React.useState<string>(ALL);
  const [priority, setPriority] = React.useState<string>(ALL);
  const [type, setType] = React.useState<string>(ALL);
  // P13-T17: free-text search, debounced, filtered by the server (`q`).
  const [search, setSearch] = React.useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);
  const [formMode, setFormMode] = React.useState<'create' | 'edit'>('create');
  const [editProject, setEditProject] = React.useState<ProjectRead | null>(null);
  const [writeForbidden, setWriteForbidden] = React.useState(false);

  const hubsQuery = useHubs();
  // All-hubs engineer lookup for the list's leader id→name join. Hub-scoped
  // server-side (a Hub Planner only ever gets their own hub's engineers back
  // regardless of the omitted `hub_id`), so this is safe to call unfiltered.
  const engineersQuery = useEngineerOptions(undefined);
  const listQuery = useProjectList({
    hubId: hubId === ALL ? undefined : hubId,
    q: debouncedSearch === '' ? undefined : debouncedSearch,
    category: category === ALL ? undefined : category,
    status: status === ALL ? undefined : status,
    priority: priority === ALL ? undefined : priority,
    type: type === ALL ? undefined : type,
  });
  const createMut = useCreateProject();
  const updateMut = useUpdateProject();
  const submitMut = useSubmitProject();
  const moveFlow = usePriorityMoveFlow();

  const title = REGISTRATION_SURFACE?.title ?? 'Project Registration';
  const description =
    REGISTRATION_SURFACE?.summary ??
    'Create and edit projects with hard-gated required fields, validated by the API.';

  const denied = authKind([listQuery.error]);
  const isFiltered =
    hubId !== ALL ||
    category !== ALL ||
    status !== ALL ||
    priority !== ALL ||
    type !== ALL ||
    debouncedSearch !== '';

  const hubNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubsQuery.data ?? []) map.set(h.id, h.name);
    return map;
  }, [hubsQuery.data]);
  const engineerNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const e of engineersQuery.data ?? []) map.set(e.id, e.name);
    return map;
  }, [engineersQuery.data]);

  const rows = React.useMemo<ProjectRow[]>(
    () =>
      (listQuery.data ?? []).map((p) => ({
        ...p,
        hubName: hubNameById.get(p.hub_id) ?? p.hub_id,
        leaderName: p.leader_engineer_id ? (engineerNameById.get(p.leader_engineer_id) ?? null) : null,
      })),
    [listQuery.data, hubNameById, engineerNameById],
  );

  const handleNew = React.useCallback(() => {
    setFormMode('create');
    setEditProject(null);
    setFormOpen(true);
  }, []);

  const handleEdit = React.useCallback((row: ProjectRow) => {
    setFormMode('edit');
    setEditProject(row);
    setFormOpen(true);
  }, []);

  const handleFormSubmit = React.useCallback(
    async (body: ProjectCreateRequest) => {
      try {
        if (formMode === 'create') {
          await createMut.mutateAsync(body);
        } else if (editProject) {
          // P14 (ADR 0026): a changed priority goes through the preview dialog
          // first; Yes applies it, then the rest of the form is PATCHed as
          // before. No leaves the form open and saves nothing.
          const rest = await applyFormPriorityMove(
            moveFlow.api,
            {
              projectId: editProject.id,
              projectName: editProject.name,
              priority: editProject.priority,
              status: editProject.status,
            },
            body,
          );
          const result = await updateMut.mutateAsync({ projectId: editProject.id, body: rest });
          // P11 (ADR 0015): a priority change schedules by itself. The server
          // says what happened in the PATCH's X-Schedule-* headers; show the
          // same progress and "Timeline updated" panel as the Gantt dropdown.
          if (result?.recalc) {
            moveFlow.api.followPatch(
              {
                projectId: editProject.id,
                projectName: result.project.name,
                priority: editProject.priority,
                status: result.project.status,
              },
              result.recalc,
              editProject.priority,
              result.project.priority,
            );
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.isForbidden) {
          setWriteForbidden(true);
          setFormOpen(false);
        }
        throw err;
      }
    },
    [formMode, editProject, createMut, updateMut, moveFlow.api],
  );

  const handleGateSubmit = React.useCallback(
    async (projectId: string, targetStatus: ProjectStatus) => {
      try {
        await submitMut.mutateAsync({ projectId, body: { target_status: targetStatus } });
      } catch (err) {
        if (err instanceof ApiError && err.isForbidden) {
          setWriteForbidden(true);
        }
        throw err;
      }
    },
    [submitMut],
  );

  // Session table first (ADR 0010), server 403 second.
  const permission = usePermission('project_registration');
  const canEdit = permission.write && !writeForbidden;
  // P13 (ADR 0025 §5): the Dashboard register's "Edit" links to `?edit=<id>`.
  useEditDeepLink(permission.write, (project) => {
    setFormMode('edit');
    setEditProject(project);
    setFormOpen(true);
  });

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          canEdit ? (
            <Button type="button" size="sm" onClick={handleNew}>
              <Plus />
              New project
            </Button>
          ) : null
        }
      />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-s6">
          {listQuery.data ? (
            <StatStrip
              ariaLabel="Registration summary"
              segments={[
                { label: 'Projects shown', value: rows.length, accent: 'primary', hint: 'Matching the filters' },
                {
                  label: 'In development',
                  value: rows.filter((r) => r.status === 'In Development').length,
                  accent: 'success',
                },
                { label: 'In queue', value: rows.filter((r) => r.status === 'In Queue').length, accent: 'warning' },
                { label: 'Drafts', value: rows.filter((r) => r.status === 'Draft').length, accent: 'neutral' },
              ]}
            />
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Filters</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="registration-search" className="text-2xs text-text-muted">
                  Search
                </Label>
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-subtle"
                  />
                  <Input
                    id="registration-search"
                    type="search"
                    value={search}
                    maxLength={SEARCH_MAX}
                    placeholder="Name or code…"
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 w-56 pl-8"
                  />
                </div>
              </div>
              <FilterSelect
                label="Hub"
                value={hubId}
                onChange={setHubId}
                options={(hubsQuery.data ?? []).map((h) => ({ value: h.id, label: h.name }))}
              />
              <FilterSelect
                label="Category"
                value={category}
                onChange={setCategory}
                options={PROJECT_CATEGORIES.map((c) => ({ value: c, label: c }))}
              />
              <FilterSelect
                label="Status"
                value={status}
                onChange={setStatus}
                options={PROJECT_STATUSES.map((s) => ({ value: s, label: s }))}
              />
              <FilterSelect
                label="Priority"
                value={priority}
                onChange={setPriority}
                options={PROJECT_PRIORITIES.map((p) => ({ value: p, label: p }))}
              />
              <FilterSelect
                label="Type"
                value={type}
                onChange={setType}
                options={PROJECT_TYPES.map((t) => ({ value: t, label: PROJECT_TYPE_LABELS[t] }))}
              />
              {isFiltered ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setHubId(ALL);
                    setCategory(ALL);
                    setStatus(ALL);
                    setPriority(ALL);
                    setType(ALL);
                    setSearch('');
                  }}
                >
                  <FilterX />
                  Clear
                </Button>
              ) : null}
              <DownloadButton
                path="/exports/project-registration"
                filters={{
                  hub_id: hubId === ALL ? undefined : hubId,
                  // P13 follow-up: the export takes the same search (`q`, ≤ 100).
                  q: debouncedSearch === '' ? undefined : debouncedSearch,
                  category: category === ALL ? undefined : category,
                  status_: status === ALL ? undefined : status,
                  priority: priority === ALL ? undefined : priority,
                  type_: type === ALL ? undefined : type,
                }}
                fallbackFilename="project-registration-export"
                className="ml-auto"
              />
            </CardContent>
          </Card>

          <ReadOnlyNotice surface="project_registration" what="Creating or editing projects" />
          {writeForbidden ? <WriteForbiddenNotice /> : null}

          <SectionBoundary
            query={listQuery}
            title="Projects"
            errorDescription="The project list could not be loaded."
          >
            {() => (
              <Card>
                <CardHeader>
                  <CardTitle>Projects</CardTitle>
                  <span className="text-2xs text-text-muted" data-numeric="">
                    {formatInteger(rows.length)} {rows.length === 1 ? 'project' : 'projects'} shown
                  </span>
                </CardHeader>
                <CardContent>
                  {rows.length === 0 ? (
                    <EmptyState
                      title={isFiltered ? 'No projects match these filters' : 'No projects registered yet'}
                      description={
                        isFiltered
                          ? 'Try widening or clearing the filters.'
                          : 'Register your first project to get started.'
                      }
                      action={
                        canEdit && !isFiltered ? (
                          <Button type="button" size="sm" onClick={handleNew}>
                            <Plus />
                            New project
                          </Button>
                        ) : undefined
                      }
                    />
                  ) : (
                    <ProjectList
                      rows={rows}
                      expandedId={expandedId}
                      onToggleExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
                      onEdit={handleEdit}
                      onSubmit={handleGateSubmit}
                      canEdit={canEdit}
                    />
                  )}
                </CardContent>
              </Card>
            )}
          </SectionBoundary>
        </div>
      )}

      <ProjectFormDialog
        mode={formMode}
        project={editProject}
        open={formOpen}
        onOpenChange={setFormOpen}
        hubs={hubsQuery.data ?? []}
        onSubmit={handleFormSubmit}
      />
      {moveFlow.element}
    </>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-2xs text-text-muted">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-8 w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
