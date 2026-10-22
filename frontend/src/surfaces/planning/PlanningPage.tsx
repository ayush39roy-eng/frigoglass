import * as React from 'react';
import { HardHat, Plus, Thermometer } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { ApiError } from '@/lib/api/client';
import { useHubs, useWorkflowStepTemplates } from '@/lib/api/reference';
import { hubPickerLabel } from '@/lib/hub-labels';
import { hubsInScope, regionsInScope } from '@/components/shared/hub-filter/hub-scope';
import { usePermission, useSession } from '@/stores/session';
import { HUB_NAMES, LAB_REGIONS, type LabRegion } from '@/types/enums';

import { AccessNotice, WriteForbiddenNotice } from './components/access-notice';
import { ApplyLogicCard } from './components/apply-logic-panel';
import { AutoAssignPlaceholder } from './components/auto-assign-placeholder';
import { ChamberFormDialog } from './components/chamber-form';
import { ChamberTable } from './components/chamber-table';
import { ConfirmDialog } from './components/confirm-dialog';
import { EngineerFormDialog } from './components/engineer-form';
import { EngineerTable, type EngineerTableRow } from './components/engineer-table';
import { WhatIfPlanner } from './whatif/components/whatif-planner';
import { CapacityTotalCards } from './components/overview/capacity-total-cards';
import { HubEngineerCard } from './components/overview/hub-engineer-card';
import { LabRegionCard } from './components/overview/lab-region-card';
import { PlanningToolbar } from './components/overview/planning-toolbar';
import { ResourceLoadSection } from './components/resource-load/resource-load-section';
import { stageChips } from './lib/chip-options';
import { groupRows } from './lib/group-rows';
import type { CapacityUnit } from './lib/figures';
import type {
  CapacityBasis,
  ChamberCreateRequest,
  ChamberRead,
  ChamberUpdateRequest,
  EngineerCreateRequest,
  EngineerRead,
  EngineerUpdateRequest,
} from './api/types';
import {
  useActiveScheduleRun,
  useApplyLogic,
  useCapacitySummary,
  useChamberList,
  useCreateChamber,
  useCreateEngineer,
  useDeleteChamber,
  useDeleteEngineer,
  useEngineerList,
  useUpdateChamber,
  useUpdateEngineer,
} from './hooks/use-planning';

const ALL = '__all__';
const TITLE = 'Capacity Planning';
const DESCRIPTION = 'Configure resource mapping, availability, and capacity logic for the year.';

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

  // --- Apply Logic / Auto-assign (P19-T04: header buttons opening dialogs) ---
  const [applyError, setApplyError] = React.useState<string | null>(null);
  const [applyOpen, setApplyOpen] = React.useState(false);
  const [autoAssignOpen, setAutoAssignOpen] = React.useState(false);

  // --- P19-T04 Overview: basis (YTD = remaining, the default) and unit ---
  const [basis, setBasis] = React.useState<CapacityBasis>('remaining');
  const [unit, setUnit] = React.useState<CapacityUnit>('weeks');
  const [defaultHubId, setDefaultHubId] = React.useState<string | undefined>(undefined);
  const [defaultRegion, setDefaultRegion] = React.useState<LabRegion | undefined>(undefined);

  const hubsQuery = useHubs();
  const engineerListQuery = useEngineerList(hubId === ALL ? undefined : hubId);
  // The Overview always lists every visible engineer (same key as "All hubs").
  const allEngineersQuery = useEngineerList(undefined);
  const chamberListQuery = useChamberList();
  const activeRunQuery = useActiveScheduleRun(true);
  const summaryQuery = useCapacitySummary();
  const templatesQuery = useWorkflowStepTemplates();
  const { me } = useSession();

  const createEngineerMut = useCreateEngineer();
  const updateEngineerMut = useUpdateEngineer();
  const deleteEngineerMut = useDeleteEngineer();
  const createChamberMut = useCreateChamber();
  const updateChamberMut = useUpdateChamber();
  const deleteChamberMut = useDeleteChamber();
  const applyLogicMut = useApplyLogic();

  const denied = authKind([engineerListQuery.error, chamberListQuery.error]);
  // Session table first (ADR 0010), server 403 second.
  const permission = usePermission('capacity_planning');
  const canEdit = permission.write && !writeForbidden;

  const hubById = React.useMemo(() => {
    const map = new Map<string, { name: string; lab_region: LabRegion }>();
    for (const h of hubsQuery.data ?? []) map.set(h.id, { name: h.name, lab_region: h.lab_region });
    return map;
  }, [hubsQuery.data]);

  // P13-T17: the hub's served lab region feeds the group header's flag.
  const engineerRows = React.useMemo<EngineerTableRow[]>(
    () =>
      (engineerListQuery.data ?? []).map((e) => ({
        ...e,
        hubName: hubById.get(e.hub_id)?.name ?? e.hub_id,
        hubRegion: hubById.get(e.hub_id)?.lab_region,
      })),
    [engineerListQuery.data, hubById],
  );

  const handleForbidden = React.useCallback(() => setWriteForbidden(true), []);

  const handleNewEngineer = React.useCallback((hub?: string) => {
    setDefaultHubId(typeof hub === 'string' ? hub : undefined);
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

  const handleNewChamber = React.useCallback((region?: LabRegion) => {
    setDefaultRegion(typeof region === 'string' ? region : undefined);
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

  // P19-T04 inline edits: the same PATCH endpoints, validation and audit as the
  // forms; a 403 downgrades the page to read-only like every other write.
  const handleInlineEngineer = React.useCallback(
    async (engineerId: string, body: EngineerUpdateRequest) => {
      try {
        return await updateEngineerMut.mutateAsync({ engineerId, body });
      } catch (err) {
        if (err instanceof ApiError && err.isForbidden) handleForbidden();
        throw err;
      }
    },
    [updateEngineerMut, handleForbidden],
  );
  const handleInlineChamber = React.useCallback(
    async (chamberId: string, body: ChamberUpdateRequest) => {
      try {
        return await updateChamberMut.mutateAsync({ chamberId, body });
      } catch (err) {
        if (err instanceof ApiError && err.isForbidden) handleForbidden();
        throw err;
      }
    },
    [updateChamberMut, handleForbidden],
  );

  // Which cards the caller may edit: write permission AND the hub (or a hub of
  // the lab region) in their scope. A narrowing of the UI only; the server
  // decides (403 on anything else).
  const scopedHubs = React.useMemo(() => hubsInScope(me, hubsQuery.data), [me, hubsQuery.data]);
  const editableHubIds = React.useMemo(() => new Set((scopedHubs ?? []).map((h) => h.id)), [scopedHubs]);
  const editableRegions = React.useMemo(() => new Set(regionsInScope(scopedHubs) ?? []), [scopedHubs]);

  const hubIdByName = React.useMemo(() => {
    const map = new Map<string, { id: string; lab_region: LabRegion }>();
    for (const h of hubsQuery.data ?? []) map.set(h.name, { id: h.id, lab_region: h.lab_region });
    return map;
  }, [hubsQuery.data]);

  const engineerGroups = React.useMemo(() => {
    const engineers = allEngineersQuery.data ?? [];
    const groups = groupRows(engineers, (e) => hubById.get(e.hub_id)?.name ?? e.hub_id, HUB_NAMES);
    const byName = new Map(groups.map((g) => [g.key, g.rows]));
    for (const h of summaryQuery.data?.design.hubs ?? []) if (!byName.has(h.hub)) byName.set(h.hub, []);
    const rank = (k: string) => {
      const i = (HUB_NAMES as readonly string[]).indexOf(k);
      return i === -1 ? HUB_NAMES.length : i;
    };
    return [...byName.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  }, [allEngineersQuery.data, hubById, summaryQuery.data]);

  const chamberGroups = React.useMemo(() => {
    const chambers = chamberListQuery.data ?? [];
    const groups = groupRows(chambers, (c) => c.lab_region, LAB_REGIONS);
    const byRegion = new Map<string, ChamberRead[]>(groups.map((g) => [g.key, g.rows]));
    for (const r of summaryQuery.data?.lab.regions ?? []) if (!byRegion.has(r.lab_region)) byRegion.set(r.lab_region, []);
    const rank = (k: string) => {
      const i = (LAB_REGIONS as readonly string[]).indexOf(k);
      return i === -1 ? LAB_REGIONS.length : i;
    };
    return [...byRegion.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  }, [chamberListQuery.data, summaryQuery.data]);

  const stages = React.useMemo(
    () => stageChips(templatesQuery.data, (chamberListQuery.data ?? []).map((c) => c.allowed_stages)),
    [templatesQuery.data, chamberListQuery.data],
  );

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
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={
          denied ? undefined : (
            <PlanningToolbar
              basis={basis}
              onBasisChange={setBasis}
              unit={unit}
              onUnitChange={setUnit}
              onApplyLogic={() => setApplyOpen(true)}
              onAutoAssign={() => setAutoAssignOpen(true)}
            />
          )
        }
      />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          <ReadOnlyNotice surface="capacity_planning" what="Creating, editing or applying changes" />
          {writeForbidden ? <WriteForbiddenNotice /> : null}

          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="engineers">Engineers</TabsTrigger>
              <TabsTrigger value="chambers">Chambers</TabsTrigger>
              <TabsTrigger value="what-if">What-if planner</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="flex flex-col gap-4">
              <CapacityTotalCards summary={summaryQuery.data} basis={basis} unit={unit} />
              {summaryQuery.isError ? (
                <p role="status" className="text-2xs text-text-muted">
                  The capacity summary could not be loaded, so hub and region totals show &ldquo;—&rdquo;.
                </p>
              ) : null}

              <div className="grid items-start gap-4 xl:grid-cols-2">
                <section aria-labelledby="design-resources-heading" className="flex min-w-0 flex-col gap-3">
                  <h2 id="design-resources-heading" className="flex items-center gap-2 font-display text-base font-bold text-text">
                    <HardHat aria-hidden="true" className="size-4 text-primary" />
                    Design resources (engineers)
                  </h2>
                  <SectionBoundary
                    query={allEngineersQuery}
                    title="Engineers"
                    errorDescription="The engineer list could not be loaded."
                  >
                    {() =>
                      engineerGroups.length === 0 ? (
                        <EmptyState
                          title="No engineers registered yet"
                          description="Add an engineer to make them available as a project leader and a design-step scheduling resource."
                          action={
                            canEdit ? (
                              <Button type="button" size="sm" onClick={() => handleNewEngineer()}>
                                <Plus />
                                New engineer
                              </Button>
                            ) : undefined
                          }
                        />
                      ) : (
                        <div className="flex flex-col gap-3">
                          {engineerGroups.map(([hubName, rows]) => {
                            const hub = hubIdByName.get(hubName);
                            return (
                              <HubEngineerCard
                                key={hubName}
                                hubName={hubName}
                                hubId={hub?.id}
                                region={hub?.lab_region}
                                summary={summaryQuery.data?.design.hubs.find((h) => h.hub === hubName)}
                                engineers={rows}
                                basis={basis}
                                unit={unit}
                                canEdit={canEdit && hub !== undefined && editableHubIds.has(hub.id)}
                                onUpdate={handleInlineEngineer}
                                onEdit={handleEditEngineer}
                                onDelete={setDeleteEngineerTarget}
                                onAdd={handleNewEngineer}
                              />
                            );
                          })}
                        </div>
                      )
                    }
                  </SectionBoundary>
                </section>

                <section aria-labelledby="lab-resources-heading" className="flex min-w-0 flex-col gap-3">
                  <h2 id="lab-resources-heading" className="flex items-center gap-2 font-display text-base font-bold text-text">
                    <Thermometer aria-hidden="true" className="size-4 text-success" />
                    Lab &amp; chamber capacities
                  </h2>
                  <SectionBoundary
                    query={chamberListQuery}
                    title="Chambers"
                    errorDescription="The chamber list could not be loaded."
                  >
                    {() =>
                      chamberGroups.length === 0 ? (
                        <EmptyState
                          title="No chambers registered yet"
                          description="Add a chamber to make it available as a lab-step scheduling resource."
                          action={
                            canEdit ? (
                              <Button type="button" size="sm" onClick={() => handleNewChamber()}>
                                <Plus />
                                New chamber
                              </Button>
                            ) : undefined
                          }
                        />
                      ) : (
                        <div className="flex flex-col gap-3">
                          {chamberGroups.map(([region, rows]) => (
                            <LabRegionCard
                              key={region}
                              region={region}
                              summary={summaryQuery.data?.lab.regions.find((r) => r.lab_region === region)}
                              chambers={rows}
                              stages={stages}
                              basis={basis}
                              unit={unit}
                              canEdit={canEdit && editableRegions.has(region as LabRegion)}
                              onUpdate={handleInlineChamber}
                              onEdit={handleEditChamber}
                              onDelete={setDeleteChamberTarget}
                              onAdd={() => handleNewChamber(region as LabRegion)}
                            />
                          ))}
                        </div>
                      )
                    }
                  </SectionBoundary>
                </section>
              </div>

              <ResourceLoadSection
                basis={basis}
                unit={unit}
                hubs={scopedHubs ?? hubsQuery.data ?? []}
                armed={allEngineersQuery.data !== undefined && chamberListQuery.data !== undefined}
              />
            </TabsContent>

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
                      <Button type="button" size="sm" onClick={() => handleNewEngineer()}>
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
                            {hubPickerLabel(h, hubsQuery.data)}
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
                              <Button type="button" size="sm" onClick={() => handleNewEngineer()}>
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
                      <Button type="button" size="sm" onClick={() => handleNewChamber()}>
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
                              <Button type="button" size="sm" onClick={() => handleNewChamber()}>
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

            {/* P18-T03: a read-only calculation (no write permission needed). Kept
                mounted while hidden so a half-built scenario, its results and the
                chat transcript survive a switch to another tab. */}
            <TabsContent value="what-if" forceMount className="data-[state=inactive]:hidden">
              <WhatIfPlanner chambers={chamberListQuery.data ?? []} />
            </TabsContent>
          </Tabs>
        </div>
      )}

      <Dialog open={applyOpen} onOpenChange={setApplyOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Apply logic</DialogTitle>
            <DialogDescription>Recompute the schedule with the current engineer and chamber configuration.</DialogDescription>
          </DialogHeader>
          <ApplyLogicCard
            bare
            canEdit={canEdit}
            provenance={provenance}
            onApply={handleApplyLogic}
            isApplying={applyLogicMut.isPending}
            lastResult={applyLogicMut.data ?? null}
            errorMessage={applyError}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={autoAssignOpen} onOpenChange={setAutoAssignOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Auto-assign projects</DialogTitle>
            <DialogDescription>Bulk resource assignment by the optimizer.</DialogDescription>
          </DialogHeader>
          <AutoAssignPlaceholder />
        </DialogContent>
      </Dialog>

      <EngineerFormDialog
        defaultHubId={engineerFormMode === 'create' ? defaultHubId : undefined}
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
        defaultRegion={chamberFormMode === 'create' ? defaultRegion : undefined}
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
