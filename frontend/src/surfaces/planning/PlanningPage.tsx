import * as React from 'react';
import { Plus } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api/client';
import { useHubs } from '@/lib/api/reference';
import { SURFACES } from '@/app/nav';

import { AccessNotice, WriteForbiddenNotice } from './components/access-notice';
import { ApplyLogicCard } from './components/apply-logic-panel';
import { AutoAssignPlaceholder } from './components/auto-assign-placeholder';
import { ChamberFormDialog } from './components/chamber-form';
import { ChamberTable } from './components/chamber-table';
import { ConfirmDialog } from './components/confirm-dialog';
import { EngineerFormDialog } from './components/engineer-form';
import { EngineerTable } from './components/engineer-table';
import type { ChamberCreateRequest, ChamberRead, EngineerCreateRequest, EngineerRead } from './api/types';
import {
  useActiveScheduleRun,
  useApplyLogic,
  useChamberList,
  useCreateChamber,
  useCreateEngineer,
  useDeleteChamber,
  useDeleteEngineer,
  useEngineerList,
  useUpdateChamber,
  useUpdateEngineer,
} from './hooks/use-planning';

const PLANNING_SURFACE = SURFACES.find((s) => s.path === '/planning');
const ALL = '__all__';

function authKind(errors: unknown[]): 'forbidden' | 'unauthorized' | null {
  for (const err of errors) {
    if (err instanceof ApiError && err.isForbidden) return 'forbidden';
  }
  for (const err of errors) {
    if (err instanceof ApiError && err.isUnauthorized) return 'unauthorized';
  }
  return null;
}

export default function PlanningPage(): React.JSX.Element {
  const [hubId, setHubId] = React.useState<string>(ALL);
  const [writeForbidden, setWriteForbidden] = React.useState(false);

  // --- Engineers ---
  const [engineerFormOpen, setEngineerFormOpen] = React.useState(false);
  const [engineerFormMode, setEngineerFormMode] = React.useState<'create' | 'edit'>('create');
  const [editEngineer, setEditEngineer] = React.useState<EngineerRead | null>(null);
  const [deleteEngineerTarget, setDeleteEngineerTarget] = React.useState<EngineerRead | null>(null);

  // --- Chambers ---
  const [chamberFormOpen, setChamberFormOpen] = React.useState(false);
  const [chamberFormMode, setChamberFormMode] = React.useState<'create' | 'edit'>('create');
  const [editChamber, setEditChamber] = React.useState<ChamberRead | null>(null);
  const [deleteChamberTarget, setDeleteChamberTarget] = React.useState<ChamberRead | null>(null);

  // --- Apply Logic ---
  const [applyError, setApplyError] = React.useState<string | null>(null);

  const hubsQuery = useHubs();
  const engineerListQuery = useEngineerList(hubId === ALL ? undefined : hubId);
  const chamberListQuery = useChamberList();
  const activeRunQuery = useActiveScheduleRun(true);

  const createEngineerMut = useCreateEngineer();
  const updateEngineerMut = useUpdateEngineer();
  const deleteEngineerMut = useDeleteEngineer();
  const createChamberMut = useCreateChamber();
  const updateChamberMut = useUpdateChamber();
  const deleteChamberMut = useDeleteChamber();
  const applyLogicMut = useApplyLogic();

  const title = PLANNING_SURFACE?.title ?? 'Capacity Planning';
  const description =
    PLANNING_SURFACE?.summary ??
    'Engineer and chamber configuration, Apply Logic and Auto-assign.';

  const denied = authKind([engineerListQuery.error, chamberListQuery.error]);
  const canEdit = !writeForbidden;

  const hubNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubsQuery.data ?? []) map.set(h.id, h.name);
    return map;
  }, [hubsQuery.data]);

  const engineerRows = React.useMemo(
    () =>
      (engineerListQuery.data ?? []).map((e) => ({
        ...e,
        hubName: hubNameById.get(e.hub_id) ?? e.hub_id,
      })),
    [engineerListQuery.data, hubNameById],
  );

  const handleForbidden = React.useCallback(() => setWriteForbidden(true), []);

  const handleNewEngineer = React.useCallback(() => {
    setEngineerFormMode('create');
    setEditEngineer(null);
    setEngineerFormOpen(true);
  }, []);
  const handleEditEngineer = React.useCallback((row: EngineerRead) => {
    setEngineerFormMode('edit');
    setEditEngineer(row);
    setEngineerFormOpen(true);
  }, []);
  const handleEngineerSubmit = React.useCallback(
    async (body: EngineerCreateRequest) => {
      try {
        if (engineerFormMode === 'create') {
          await createEngineerMut.mutateAsync(body);
        } else if (editEngineer) {
          await updateEngineerMut.mutateAsync({ engineerId: editEngineer.id, body });
        }
      } catch (err) {
        if (err instanceof ApiError && err.isForbidden) {
          handleForbidden();
          setEngineerFormOpen(false);
        }
        throw err;
      }
    },
    [engineerFormMode, editEngineer, createEngineerMut, updateEngineerMut, handleForbidden],
  );
  const handleDeleteEngineerConfirm = React.useCallback(async () => {
    if (!deleteEngineerTarget) return;
    try {
      await deleteEngineerMut.mutateAsync(deleteEngineerTarget.id);
      setDeleteEngineerTarget(null);
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) handleForbidden();
      // Leave the dialog open on a 409 (still referenced) / other errors so
      // the message (surfaced via mutation state below) stays visible.
    }
  }, [deleteEngineerTarget, deleteEngineerMut, handleForbidden]);

  const handleNewChamber = React.useCallback(() => {
    setChamberFormMode('create');
    setEditChamber(null);
    setChamberFormOpen(true);
  }, []);
  const handleEditChamber = React.useCallback((row: ChamberRead) => {
    setChamberFormMode('edit');
    setEditChamber(row);
    setChamberFormOpen(true);
  }, []);
  const handleChamberSubmit = React.useCallback(
    async (body: ChamberCreateRequest) => {
      try {
        if (chamberFormMode === 'create') {
          await createChamberMut.mutateAsync(body);
        } else if (editChamber) {
          await updateChamberMut.mutateAsync({ chamberId: editChamber.id, body });
        }
      } catch (err) {
        if (err instanceof ApiError && err.isForbidden) {
          handleForbidden();
          setChamberFormOpen(false);
        }
        throw err;
      }
    },
    [chamberFormMode, editChamber, createChamberMut, updateChamberMut, handleForbidden],
  );
  const handleDeleteChamberConfirm = React.useCallback(async () => {
    if (!deleteChamberTarget) return;
    try {
      await deleteChamberMut.mutateAsync(deleteChamberTarget.id);
      setDeleteChamberTarget(null);
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) handleForbidden();
    }
  }, [deleteChamberTarget, deleteChamberMut, handleForbidden]);

  const handleApplyLogic = React.useCallback(async () => {
    setApplyError(null);
    try {
      await applyLogicMut.mutateAsync();
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) {
        handleForbidden();
        setApplyError('Your role cannot apply the scheduling logic. This action is limited to Admins.');
      } else if (err instanceof ApiError) {
        setApplyError(err.detail ?? 'The schedule could not be recomputed. Please try again.');
      } else {
        setApplyError('The schedule could not be recomputed. Please try again.');
      }
    }
  }, [applyLogicMut, handleForbidden]);

  const provenance = activeRunQuery.data
    ? { version: activeRunQuery.data.version, solverType: activeRunQuery.data.solver_type }
    : null;

  return (
    <>
      <PageHeader title={title} description={description} />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          {writeForbidden ? <WriteForbiddenNotice /> : null}

          <Tabs defaultValue="engineers">
            <TabsList>
              <TabsTrigger value="engineers">Engineers</TabsTrigger>
              <TabsTrigger value="chambers">Chambers</TabsTrigger>
              <TabsTrigger value="apply-logic">Apply Logic &amp; Auto-assign</TabsTrigger>
            </TabsList>

            <TabsContent value="engineers">
              <Card>
                <CardHeader>
                  <CardTitle>Engineers</CardTitle>
                  <div className="flex items-center gap-2">
                    <DownloadButton
                      path="/exports/capacity-planning"
                      filters={{
                        hub_id: hubId === ALL ? undefined : hubId,
                        entity: 'engineers',
                      }}
                      fallbackFilename="capacity-planning-engineers-export"
                    />
                    {canEdit ? (
                      <Button type="button" size="sm" onClick={handleNewEngineer}>
                        <Plus />
                        New engineer
                      </Button>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="planning-hub-filter" className="text-2xs text-text-muted">
                      Hub
                    </Label>
                    <Select value={hubId} onValueChange={setHubId}>
                      <SelectTrigger id="planning-hub-filter" className="h-8 w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ALL}>All hubs</SelectItem>
                        {(hubsQuery.data ?? []).map((h) => (
                          <SelectItem key={h.id} value={h.id}>
                            {h.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <SectionBoundary
                    query={engineerListQuery}
                    title="Engineers"
                    errorDescription="The engineer list could not be loaded."
                  >
                    {() =>
                      engineerRows.length === 0 ? (
                        <EmptyState
                          title="No engineers registered yet"
                          description="Add an engineer to make them available as a project leader and a design-step scheduling resource."
                          action={
                            canEdit ? (
                              <Button type="button" size="sm" onClick={handleNewEngineer}>
                                <Plus />
                                New engineer
                              </Button>
                            ) : undefined
                          }
                        />
                      ) : (
                        <EngineerTable
                          rows={engineerRows}
                          canEdit={canEdit}
                          onEdit={handleEditEngineer}
                          onDelete={setDeleteEngineerTarget}
                        />
                      )
                    }
                  </SectionBoundary>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="chambers">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle>Chambers</CardTitle>
                  <div className="flex items-center gap-2">
                    <DownloadButton
                      path="/exports/capacity-planning"
                      filters={{ entity: 'chambers' }}
                      fallbackFilename="capacity-planning-chambers-export"
                    />
                    {canEdit ? (
                      <Button type="button" size="sm" onClick={handleNewChamber}>
                        <Plus />
                        New chamber
                      </Button>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent>
                  <SectionBoundary
                    query={chamberListQuery}
                    title="Chambers"
                    errorDescription="The chamber list could not be loaded."
                  >
                    {(chambers) =>
                      chambers.length === 0 ? (
                        <EmptyState
                          title="No chambers registered yet"
                          description="Add a chamber to make it available as a lab-step scheduling resource."
                          action={
                            canEdit ? (
                              <Button type="button" size="sm" onClick={handleNewChamber}>
                                <Plus />
                                New chamber
                              </Button>
                            ) : undefined
                          }
                        />
                      ) : (
                        <ChamberTable
                          rows={chambers}
                          canEdit={canEdit}
                          onEdit={handleEditChamber}
                          onDelete={setDeleteChamberTarget}
                        />
                      )
                    }
                  </SectionBoundary>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="apply-logic" className="flex flex-col gap-4">
              <ApplyLogicCard
                canEdit={canEdit}
                provenance={provenance}
                onApply={handleApplyLogic}
                isApplying={applyLogicMut.isPending}
                lastResult={applyLogicMut.data ?? null}
                errorMessage={applyError}
              />
              <AutoAssignPlaceholder />
            </TabsContent>
          </Tabs>
        </div>
      )}

      <EngineerFormDialog
        mode={engineerFormMode}
        engineer={editEngineer}
        open={engineerFormOpen}
        onOpenChange={setEngineerFormOpen}
        hubs={hubsQuery.data ?? []}
        onSubmit={handleEngineerSubmit}
      />
      <ConfirmDialog
        open={deleteEngineerTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteEngineerTarget(null);
        }}
        title={`Delete ${deleteEngineerTarget?.name ?? 'this engineer'}?`}
        description="This cannot be undone. Deleting an engineer fails if they are still referenced by an existing project, workflow step or schedule-run snapshot."
        busy={deleteEngineerMut.isPending}
        onConfirm={() => void handleDeleteEngineerConfirm()}
      />

      <ChamberFormDialog
        mode={chamberFormMode}
        chamber={editChamber}
        open={chamberFormOpen}
        onOpenChange={setChamberFormOpen}
        onSubmit={handleChamberSubmit}
      />
      <ConfirmDialog
        open={deleteChamberTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteChamberTarget(null);
        }}
        title={`Delete ${deleteChamberTarget?.code ?? 'this chamber'}?`}
        description="This cannot be undone. Deleting a chamber fails if it is still referenced by existing schedule data."
        busy={deleteChamberMut.isPending}
        onConfirm={() => void handleDeleteChamberConfirm()}
      />
    </>
  );
}
