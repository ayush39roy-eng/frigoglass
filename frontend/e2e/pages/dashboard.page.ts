import type { Page } from '@playwright/test';

export class DashboardPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  heading() {
    return this.page.getByRole('heading', { name: 'Global RPD Dashboard' });
  }

  withinYearSection() {
    return this.page.getByRole('heading', { name: 'Completing within the year' });
  }

  /** The "Completion outcome" donut was removed (2026-10-22); the profile replaces it. */
  completionProfileSection() {
    return this.page.getByRole('heading', { name: 'Completion profile' });
  }

  /** P23-T03: the Dashboard "Capacity booked" card was removed (it lives on RPD Capacity, per hub). */
  capacityBookedHeading() {
    return this.page.getByRole('heading', { name: 'Capacity booked' });
  }

  statusOverviewSection() {
    return this.page.getByRole('heading', { name: 'Status overview' });
  }

  /** P17-R08: the pipeline summary table (the Hub × type bar chart is gone). */
  hubTypePipelineSection() {
    return this.page.getByRole('heading', { name: 'Project pipeline summary: Hub × Type' });
  }

  completingHubTypeSection() {
    return this.page.getByRole('heading', { name: 'Completing within year: Hub × Type' });
  }

  /** A clickable Hub × Type figure, by its aria-label ("View 3 New Model projects in PD-India"). */
  drillCell(name: string | RegExp) {
    return this.page.getByRole('button', { name });
  }

  drilldownDialog() {
    return this.page.getByTestId('hub-type-drilldown');
  }

  // ---- P28 Executive view (ADR 0039) ----

  /** Deep link straight into the Executive view. */
  async gotoExecutive(): Promise<void> {
    await this.page.goto('/?view=executive');
  }

  /** The header's Executive | Detailed radiogroup. */
  viewToggle() {
    return this.page.getByTestId('dashboard-view-toggle');
  }

  viewToggleOption(view: 'executive' | 'detailed') {
    return this.page.getByTestId(`dashboard-view-${view}`);
  }

  executiveView() {
    return this.page.getByTestId('executive-view');
  }

  /** One KPI tile: scheduled | within-year | spillover | left-out | blocked | vip | pipeline. */
  executiveKpi(tile: 'scheduled' | 'within-year' | 'spillover' | 'left-out' | 'blocked' | 'vip' | 'pipeline') {
    return this.page.getByTestId(`exec-kpi-${tile}`);
  }

  pipelineDonut() {
    return this.page.getByTestId('exec-pipeline-donut');
  }

  statusDonut() {
    return this.page.getByTestId('exec-status-donut');
  }

  /** The "Projects by type" bar list. */
  projectsByTypeChart() {
    return this.page.getByTestId('exec-type-chart');
  }

  priorityDeliveryChart() {
    return this.page.getByTestId('exec-priority-delivery');
  }

  risksCard() {
    return this.page.getByTestId('exec-risks-card');
  }

  riskRows() {
    return this.page.getByTestId('exec-risk-row');
  }

  hubsGlance() {
    return this.page.getByTestId('exec-hubs-card');
  }
}
