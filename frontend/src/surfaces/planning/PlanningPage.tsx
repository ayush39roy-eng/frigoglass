import * as React from 'react';
import { HardHat, Plus, Thermometer } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MultiSelectDropdown } from '@/components/shared/multi-select-dropdown';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
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
import { DeactivateEngineerDialog } from './components/deactivate-engineer-dialog';
import { DeactivationResultPanel } from './components/deactivation-result-panel';
import { EngineerStatusFilterControl } from './components/engineer-status-filter';
import { WhatIfPlanner } from './whatif/components/whatif-planner';
import { CapacityTotalCards } from './components/overview/capacity-total-cards';
import { HubEngineerCard } from './components/overview/hub-engineer-card';
import { LabRegionCard } from './components/overview/lab-region-card';
import { useCardEditStore } from './components/overview/card-edit-store';
import { OverviewLeaveGuard } from './components/overview/overview-leave-guard';
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
  EngineerStatusFilter,
  EngineerUpdateRequest,
} from './api/types';
import { DEACTIVATION_COPY } from './lib/deactivation';
import { useDeactivationResult } from './hooks/use-deactivation-result';
import {
  useActiveScheduleRun,
  useApplyLogic,
  useCapacitySummary,
  useChamberList,
  useCreateChamber,
  useCreateEngineer,
  useDeleteChamber,
  useEngineerList,
  useReactivateEngineer,
  useUpdateChamber,
  useUpdateEngineer,
} from './hooks/use-planning';

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
  const [hubIds, setHubIds] = React.useState<string[]>([]);
  const [writeForbidden, setWriteForbidden] = React.useState(false);

  // --- Engineers ---
  const [engineerFormOpen, setEngineerFormOpen] = React.useState(false);
  const [engineerFormMode, setEngineerFormMode] = React.useState<'create' | 'edit'>('create');
  const [editEngineer, setEditEngineer] = React.useState<EngineerRead | null>(null);
  // P38 (ADR 0053): Delete is retired; Deactivate / Reactivate replace it.
  const [engineerStatus, setEngineerStatus] = React.useState<EngineerStatusFilter>('active');
  const [deactivateTarget, setDeactivateTarget] = React.useState<EngineerRead | null>(null);
  const [reactivateTarget, setReactivateTarget] = React.useState<EngineerRead | null>(null);
  const [reactivateError, setReactivateError] = React.useState<string | null>(null);

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
  const engineerListQuery = useEngineerList(hubIds, engineerStatus);
  // The Overview always lists every visible engineer (same key as "All hubs"),
  // narrowed by the same Show filter (P38: active by default).
  const allEngineersQuery = useEngineerList(undefined, engineerStatus);
  const chamberListQuery = useChamberList();
  const activeRunQuery = useActiveScheduleRun(true);
  const summaryQuery = useCapacitySummary();
  const templatesQuery = useWorkflowStepTemplates();
  const { me } = useSession();

  const createEngineerMut = useCreateEngineer();
  const updateEngineerMut = useUpdateEngineer();
  const reactivateEngineerMut = useReactivateEngineer();
  const deactivation = useDeactivationResult();
  const createChamberMut = useCreateChamber();
  const updateChamberMut = useUpdateChamber();
  const deleteChamberMut = useDeleteChamber();
  const applyLogicMut = useApplyLogic();

  const denied = authKind([engineerListQuery.error, chamberListQuery.error]);
  // Session table first (ADR 0010), server 403 second.
  const permission = usePermission('capacity_planning');
  const canEdit = permission.write && !writeForbidden;
  // P38 (ADR 0053 §1, OQ #93): Admin / Super Admin only, by role, as with
  // `counts_in_capacity`. A narrowing of the UI; the server answers 403.
  const isAdmin = me?.roles.some((r) => r === 'Admin' || r === 'Super Admin') ?? false;
  const canChangeStatus = canEdit && isAdmin;

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
    async (body: EngineerCreateRequest | EngineerUpdateRequest) => {
      try {
        if (engineerFormMode === 'create') {
          await createEngineerMut.mutateAsync(body as EngineerCreateRequest);
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
  const handleReactivateConfirm = React.useCallback(async () => {
    if (!reactivateTarget) return;
    setReactivateError(null);
    try {
      await reactivateEngineerMut.mutateAsync(reactivateTarget.id);
      setReactivateTarget(null);
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) {
        handleForbidden();
        setReactivateError(DEACTIVATION_COPY.adminOnly);
      } else if (err instanceof ApiError && err.code === 'ENGINEER_ALREADY_ACTIVE') {
        setReactivateError(DEACTIVATION_COPY.alreadyActive);
      } else if (err instanceof ApiError && err.status === 503) {
        setReactivateError(DEACTIVATION_COPY.busy);
      } else {
        setReactivateError(apiErrorMessage(err, 'The engineer could not be reactivated. Nothing was changed. Please try again.'));
      }
    }
  }, [reactivateTarget, reactivateEngineerMut, handleForbidden]);
  const openReactivate = React.useCallback((row: EngineerRead) => {
    setReactivateError(null);
    setReactivateTarget(row);
  }, []);
  const closeDeactivate = React.useCallback(() => setDeactivateTarget(null), []);
  const { show: showDeactivation } = deactivation;
  const handleDeactivated = React.useCallback(
    (result: Parameters<typeof showDeactivation>[0], name: string) => {
      setDeactivateTarget(null);
      showDeactivation(result, name);
    },
    [showDeactivation],
  );

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

  // Owner ask 2026-11-17: card drafts live in a store that outlives the
  // Overview tab; leaving the page drops them (the guard asks first).
  React.useEffect(() => () => useCardEditStore.getState().reset(), []);

  const provenance = activeRunQuery.data
    ? { version: activeRunQuery.data.version, solverType: activeRunQuery.data.solver_type }
    : null;

  return (
    <>
      <OverviewLeaveGuard />
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
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 id="design-resources-heading" className="flex items-center gap-2 font-display text-base font-bold text-text">
                      <HardHat aria-hidden="true" className="size-4 text-primary" />
                      Design resources (engineers)
                    </h2>
                    <EngineerStatusFilterControl value={engineerStatus} onChange={setEngineerStatus} idSuffix="overview" />
                  </div>
                  <SectionBoundary
                    query={allEngineersQuery}
                    title="Engineers"
                    errorDescription="The engineer list could not be loaded."
                  >
                    {() =>
                      engineerGroups.length === 0 && engineerStatus === 'inactive' ? (
                        <EmptyState title="No inactive engineers" description="Every engineer you can see is active." />
                      ) : engineerGroups.length === 0 ? (
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
                                canChangeStatus={canChangeStatus}
                                onDeactivate={setDeactivateTarget}
                                onReactivate={openReactivate}
                                onAdd={handleNewEngineer}
                                emptyLabel={engineerStatus === 'inactive' ? 'No inactive engineers in this hub.' : undefined}
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
                        hub_id: hubIds.length > 0 ? [...hubIds].sort() : undefined,
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
                  <div className="flex flex-wrap items-center gap-3">
                  <MultiSelectDropdown
                    id="planning-hub-filter"
                    label="Hub"
                    allLabel="All hubs"
                    value={hubIds}
                    onChange={setHubIds}
                    options={(hubsQuery.data ?? []).map((h) => ({ value: h.id, label: hubPickerLabel(h, hubsQuery.data) }))}
                    triggerClassName="h-8 w-48"
                    data-testid="planning-hub-filter"
                  />
                  <EngineerStatusFilterControl value={engineerStatus} onChange={setEngineerStatus} idSuffix="engineers" />
                  </div>
                  <SectionBoundary
                    query={engineerListQuery}
                    title="Engineers"
                    errorDescription="The engineer list could not be loaded."
                  >
                    {() =>
                      engineerRows.length === 0 && engineerStatus === 'inactive' ? (
                        <EmptyState title="No inactive engineers" description="Every engineer you can see is active." />
                      ) : engineerRows.length === 0 ? (
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
                          canChangeStatus={canChangeStatus}
                          onEdit={handleEditEngineer}
                          onDeactivate={setDeactivateTarget}
                          onReactivate={openReactivate}
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
      <DeactivateEngineerDialog
        engineer={deactivateTarget}
        onClose={closeDeactivate}
        onDeactivated={handleDeactivated}
        onForbidden={handleForbidden}
      />
      <ConfirmDialog
        open={reactivateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReactivateTarget(null);
        }}
        title={`Reactivate ${reactivateTarget?.name ?? 'this engineer'}?`}
        description={DEACTIVATION_COPY.reactivateBody}
        confirmLabel="Reactivate"
        busyLabel="Reactivating…"
        tone="primary"
        error={reactivateError}
        busy={reactivateEngineerMut.isPending}
        onConfirm={() => void handleReactivateConfirm()}
      />
      <DeactivationResultPanel
        state={deactivation.state}
        runState={deactivation.runState}
        watchingFollowUp={deactivation.watchingFollowUp}
        onClose={deactivation.close}
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
