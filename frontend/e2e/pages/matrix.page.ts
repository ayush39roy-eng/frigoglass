import type { Locator, Page } from '@playwright/test';

export class MatrixPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/matrix');
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
}
