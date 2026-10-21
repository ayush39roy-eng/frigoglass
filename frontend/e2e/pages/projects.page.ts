import type { Locator, Page } from '@playwright/test';

/**
 * P22-T01: the merged Projects page (all projects + Project Registration).
 * Registration is a drawer opened by "Register project" or a row's
 * "Edit registration"; `/register` redirects here.
 */
export class ProjectsPage {
  constructor(private readonly page: Page) {}

  async goto(query = ''): Promise<void> {
    await this.page.goto(`/projects${query}`);
  }

  heading() {
    return this.page.getByRole('heading', { level: 1, name: 'Projects' });
  }

  registerButton() {
    return this.page.getByRole('button', { name: 'Register project' }).first();
  }

  /** The registration drawer (create or edit). */
  drawer() {
    return this.page.getByTestId('registration-drawer');
  }

  searchBox() {
    return this.page.getByRole('searchbox', { name: 'Search' });
  }

  draftsChip() {
    return this.page.getByRole('button', { name: 'Drafts' });
  }

  exportButton() {
    return this.page.getByRole('button', { name: 'Export' });
  }

  rowByName(name: string): Locator {
    return this.page.getByRole('row').filter({ hasText: name });
  }

  editButtonFor(name: string): Locator {
    return this.page.getByRole('button', { name: `Edit registration of ${name}` });
  }
}
