import type { Locator, Page } from '@playwright/test';

export class MatrixPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/matrix');
  }

  /** P21-T05: the page's two tabs; `?view=board` selects the Priority board. */
  async gotoBoard(): Promise<void> {
    await this.page.goto('/matrix?view=board');
  }

  tab(name: 'Scoring grid' | 'Priority board'): Locator {
    return this.page.getByRole('tablist', { name: 'Prioritization views' }).getByRole('tab', { name });
  }

  boardColumns(): Locator {
    return this.page.getByTestId('board-column');
  }

  /** P21-T04: a Compare dialog score menu, e.g. ("Strategic Project", "Cooler A"). */
  compareScoreSelect(dimension: string, projectName: string): Locator {
    return this.page.getByRole('combobox', { name: `${dimension} score for ${projectName}` });
  }

  /** P26-T03: the "Scoring scale and dimensions" card, the only place the rubric is read and edited. */
  rubricCard(): Locator {
    return this.page.getByTestId('scoring-rubric-card');
  }

  /** Shown only for the served `can_edit` (Admin / Super Admin). */
  rubricEditButton(): Locator {
    return this.rubricCard().getByRole('button', { name: 'Edit rubric' });
  }

  rubricHistoryButton(): Locator {
    return this.rubricCard().getByRole('button', { name: 'Rubric version history' });
  }

  rubricHistoryDialog(): Locator {
    return this.page.getByRole('dialog', { name: 'Rubric version history' });
  }

  heading() {
    return this.page.getByRole('heading', { name: 'Prioritization Matrix' });
  }

  currencyToggleGroup() {
    return this.page.getByRole('radiogroup', { name: 'Display currency' });
  }

  /** P21: options are labelled "USD · US dollar"; match on the code prefix. */
  currencyOption(code: 'EUR' | 'USD' | 'INR' | 'EGP' | 'ZAR' | 'IDR'): Locator {
    return this.currencyToggleGroup().getByRole('radio', { name: new RegExp(`^${code} · `) });
  }

  async toggleCurrency(code: 'EUR' | 'USD' | 'INR' | 'EGP' | 'ZAR' | 'IDR'): Promise<void> {
    await this.currencyOption(code).click();
  }

  /** P21 sticky View panel (`data-stuck` flips when it sticks). */
  viewPanel(): Locator {
    return this.page.getByTestId('matrix-view-panel');
  }

  gridRegion(): Locator {
    return this.page.getByRole('region', { name: /Scoring grid table/ });
  }

  compareCheckbox(projectName: string): Locator {
    return this.page.getByRole('checkbox', { name: `Select ${projectName} to compare` });
  }

  compareCheckboxes(): Locator {
    return this.page.getByRole('checkbox', { name: /^Select .* to compare$/ });
  }

  compareBar(): Locator {
    return this.page.getByTestId('compare-bar');
  }

  compareDialog(): Locator {
    return this.page.getByRole('dialog', { name: /^Compare projects/ });
  }

  bandLegend(band: 'P1' | 'P2' | 'P3' | 'P4' | 'Q' | 'Unscored'): Locator {
    return this.page.getByTestId(`band-legend-${band}`);
  }

  rateCaption() {
    return this.page.getByTestId('currency-rate-caption');
  }

  editButtonFor(projectName: string): Locator {
    return this.page.getByRole('button', { name: `Edit prioritization score for ${projectName}` });
  }

  firstEditButton(): Locator {
    return this.page.getByRole('button', { name: /^Edit prioritization score for / }).first();
  }

  scoreEditDialog() {
    return this.page.getByRole('dialog', { name: 'Edit prioritization score' });
  }

  /** P27 (ADR 0038): "from registration" marks on tag-filled score chips in the grid. */
  fromRegistrationMarks(): Locator {
    return this.page.getByTestId('from-registration-mark');
  }
}
