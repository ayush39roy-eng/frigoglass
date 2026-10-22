import type { Locator, Page } from '@playwright/test';

export class CapacityPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/capacity');
  }

  heading() {
    return this.page.getByRole('heading', { name: 'RPD Capacity' });
  }

  /** P19-T06 renamed the merged table "Load vs. capacity by hub". */
  hubLoadPanel() {
    return this.page.getByRole('heading', { name: 'Load vs. capacity by hub' });
  }

  classBreakdownPanel() {
    return this.page.getByRole('heading', { name: 'Class breakdown — deliverable vs. left out' });
  }

  /** P19-T07: the class chart and the chamber utilization matrix were removed (owner);
   *  these locate them so specs can assert they stay gone. */
  removedDisclosures() {
    return this.page.getByRole('button', { name: /^(Show|Hide) (class chart|chamber utilization)$/ });
  }

  removedChamberMatrix() {
    return this.page.getByRole('heading', { name: 'Resource utilization matrix' });
  }

  /** P19: engineer utilization is collapsed and only fetched once opened (audited per read). */
  async openEngineerUtilization(): Promise<void> {
    await this.page.getByRole('button', { name: 'Show engineer utilization' }).click();
  }

  /** P19: open one hub's Details dialog from the summary table. */
  async openHubDetails(hub: string) {
    await this.page.getByRole('button', { name: `Details for ${hub}` }).click();
    return this.page.getByRole('dialog');
  }

  /** P29 (ADR 0042): a capacity-hub row of "Load vs. capacity by hub" (four rows; no OEM row). */
  hubRow(hub: string): Locator {
    return this.page.getByTestId(`hub-summary-row-${hub}`);
  }

  /** P29: every capacity-hub row (expected: R&D-Greece, R&D-India, PD-India, PD-Romania). */
  hubRows(): Locator {
    return this.page.getByTestId(/^hub-summary-row-/);
  }

  /** P29: the members disclosure under a capacity hub, e.g. "Includes OEM-HCK and OEM-Seitek". */
  membersToggle(hub: string): Locator {
    return this.hubRow(hub).getByRole('button', { name: /^Includes / });
  }

  /** P29: one served member sub-row (own hub or OEM member); `data-selected="true"` when filtered. */
  memberRow(member: string): Locator {
    return this.page.getByTestId(`hub-summary-member-${member}`);
  }

  /** P29: the engineer heatmap's marker on engineers not in the capacity roster. */
  notInRosterMarkers(): Locator {
    return this.page.getByTestId('not-in-capacity-roster');
  }
}
