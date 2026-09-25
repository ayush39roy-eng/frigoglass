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

  async toggleCurrency(code: 'EUR' | 'USD' | 'INR'): Promise<void> {
    await this.page.getByRole('radio', { name: code, exact: true }).click();
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
