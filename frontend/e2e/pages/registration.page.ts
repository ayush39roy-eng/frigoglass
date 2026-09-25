import type { Locator, Page } from '@playwright/test';

export class RegistrationPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/register');
  }

  heading() {
    return this.page.getByRole('heading', { name: 'Project Registration' });
  }

  newProjectButton() {
    return this.page.getByRole('button', { name: 'New project' });
  }

  formDialog() {
    return this.page.getByRole('dialog');
  }

  rowByName(name: string): Locator {
    return this.page.getByRole('row').filter({ hasText: name });
  }

  expandButtonFor(name: string): Locator {
    return this.page.getByRole('button', { name: `Expand ${name}` });
  }

  editButtonFor(name: string): Locator {
    return this.page.getByRole('button', { name: `Edit ${name}` });
  }
}
