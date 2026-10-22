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

  /** P27 (ADR 0038): the "Project nature" checkbox group inside the drawer. */
  projectNature(): Locator {
    return this.drawer().getByRole('group', { name: 'Project nature' });
  }

  /** One "Project nature" tag checkbox, by its label (e.g. "New Options"). */
  projectNatureTag(label: string): Locator {
    return this.projectNature().getByRole('checkbox', { name: label, exact: true });
  }

  searchBox() {
    return this.page.getByRole('searchbox', { name: 'Search' });
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

  /** P29 (ADR 0042 §7): the provisional-leader badge beside the Leader select in the drawer. */
  provisionalLeaderBadge(): Locator {
    return this.drawer().getByTestId('provisional-leader');
  }

  /** P29: a hub option of the drawer's Hub select, e.g. "OEM-HCK (Greece)". */
  hubOption(label: string): Locator {
    return this.page.getByRole('option', { name: label, exact: true });
  }
}
