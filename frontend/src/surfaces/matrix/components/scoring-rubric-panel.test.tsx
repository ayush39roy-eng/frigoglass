import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() };
});

import { ApiError, apiGet, apiSend } from '@/lib/api/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { seriousAxeViolations } from '@/test/axe';

import type { ScoringRubric, ScoringRubricPreview, ScoringRubricUpdateRequest } from '../api/types';
import { INITIAL_TEST_DIMENSIONS, testRubric } from '../test-fixtures';
import { ScoringRubricPanel } from './scoring-rubric-panel';

const mockGet = vi.mocked(apiGet);
const mockSend = vi.mocked(apiSend);

/** The test plays the server's rubric endpoints. */
let current: ScoringRubric;
let versions: ScoringRubric[];
let nextGet: ScoringRubric | null;

const PREVIEW: ScoringRubricPreview = {
  current_version: 1,
  current_total_weight: 295,
  proposed_total_weight: 325,
  dimensions: [],
  scored_projects: 4,
  score_band_change_count: 2,
  suggested_band_change_count: 1,
  band_changes: [
    { from_band: 'P2', to_band: 'P1', count: 1 },
    { from_band: 'P3', to_band: 'P4', count: 1 },
  ],
  projects: [
    { project_id: 'a', project_name: 'Alpha', hub: 'R&D-Greece', old_normalized_pct: 63, new_normalized_pct: 71, old_score_band: 'P2', new_score_band: 'P1', old_suggested_band: 'P2', new_suggested_band: 'P1', new_capacity_fill: false, score_band_changed: true, suggested_band_changed: true, missing_dimension_keys: ['sustainability_esg'] },
    { project_id: 'b', project_name: 'Beta', hub: 'PD-India', old_normalized_pct: 41, new_normalized_pct: 37, old_score_band: 'P3', new_score_band: 'P4', old_suggested_band: 'P3', new_suggested_band: 'P4', new_capacity_fill: false, score_band_changed: true, suggested_band_changed: false, missing_dimension_keys: ['sustainability_esg'] },
    { project_id: 'c', project_name: 'Calm', hub: 'PD-India', old_normalized_pct: 50, new_normalized_pct: 50, old_score_band: 'P3', new_score_band: 'P3', old_suggested_band: 'P3', new_suggested_band: 'P3', new_capacity_fill: false, score_band_changed: false, suggested_band_changed: false, missing_dimension_keys: [] },
  ],
};

let client: QueryClient;
function renderPanel() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const utils = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ScoringRubricPanel />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...utils, invalidate };
}

const card = () => screen.getByTestId('scoring-rubric-card');

/** Click "Edit rubric" and wait for the inline editor (in the card, not a dialog). */
async function enterEdit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Edit rubric' }));
  const c = card();
  await within(c).findAllByTestId('rubric-row');
  return c;
}

const rowOf = (name: string) =>
  screen.getAllByTestId('rubric-row').find((r) => within(r).queryByRole('textbox', { name: `Label of ${name}` })) as HTMLElement;
const rowKeys = () => screen.getAllByTestId('rubric-row').map((r) => r.getAttribute('data-uid'));

beforeEach(() => {
  vi.clearAllMocks();
  current = testRubric({ can_edit: true });
  versions = [current];
  nextGet = null;
  mockGet.mockImplementation((path: string) => {
    if (path === '/scoring-rubric') {
      if (nextGet) current = nextGet;
      return Promise.resolve(current);
    }
    if (path === '/scoring-rubric/versions') return Promise.resolve({ versions });
    return Promise.reject(new ApiError(404, 'not found'));
  });
  mockSend.mockImplementation((method: string, path: string, body?: unknown) => {
    if (method === 'POST' && path === '/scoring-rubric/preview') return Promise.resolve(PREVIEW);
    if (method === 'PUT' && path === '/scoring-rubric') {
      const b = body as ScoringRubricUpdateRequest;
      if (b.version !== current.version) {
        return Promise.reject(new ApiError(409, 'conflict', 'The rubric was changed by someone else (now version 2, you edited version 1).', 'RUBRIC_VERSION_CONFLICT'));
      }
      current = testRubric(
        { version: current.version + 1, reason: b.reason, can_edit: true, changed_by_name: 'Ada Admin' },
        b.dimensions.map((d) => ({ key: d.key ?? 'sustainability_esg', label: d.label, pillar: d.pillar, weight: d.weight })),
        b.dimensions.filter((d) => d.active === false).map((d) => d.key ?? ''),
      );
      return Promise.resolve(current);
    }
    return Promise.reject(new ApiError(405, 'unmocked'));
  });
});

// Long user-event flows: a generous timeout so they hold under a loaded full-suite run.
describe('Scoring scale and dimensions card (P26-T03)', { timeout: 30_000 }, () => {
  it('is always expanded (no Show / Hide rubric): scale, the active dimensions grouped by pillar with served weights and the total', async () => {
    current = testRubric({ can_edit: false }, INITIAL_TEST_DIMENSIONS, ['new_models']);
    renderPanel();
    const c = card();
    expect(within(c).queryByRole('button', { name: /Show rubric|Hide rubric/ })).not.toBeInTheDocument();
    expect(within(c).getByLabelText('Score scale')).toHaveTextContent('0');
    const rows = await within(c).findAllByTestId('rubric-dimension-row');
    expect(rows).toHaveLength(12); // 13 minus the inactive New Models
    // Pillar is the FIRST column.
    expect(within(c).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Pillar', 'Dimension', 'Weight', '1 — Negligible', '5 — Exceptional']);
    // One group (tbody) per pillar, in order of first appearance; the pillar cell spans its rows.
    const groups = within(c).getAllByTestId('rubric-pillar-group');
    expect(groups.map((g) => g.getAttribute('data-pillar'))).toEqual(['Strategic Alignment', 'Regulatory & Quality', 'Financial Return', 'Investment & Feasibility', 'Market & Volume']);
    expect(groups.map((g) => g.tagName)).toEqual(Array(5).fill('TBODY'));
    const cells = within(c).getAllByTestId('rubric-pillar-cell');
    expect(cells.map((x) => x.getAttribute('rowspan'))).toEqual(['3', '2', '3', '2', '2']);
    expect(cells[0]).toHaveAttribute('scope', 'rowgroup');
    // The same alternating tint as the grid's pillar boxes (every second pillar).
    expect(groups.map((g) => g.getAttribute('data-tint'))).toEqual(['false', 'true', 'false', 'true', 'false']);
    // Pillar summary from the served weights: count · weight (scaled of 100).
    expect(cells[0]).toHaveTextContent('Strategic Alignment');
    expect(cells[0]).toHaveTextContent('3 · 75 (26.8 of 100)');
    expect(cells[4]).toHaveTextContent('2 · 40 (14.3 of 100)'); // Market & Volume without New Models
    // A dimension row: its label is the row header, then the served weight.
    expect(within(rows[0]!).getByRole('rowheader', { name: 'Strategic Project' })).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('25 (8.9 of 100)');
    expect(within(groups[0]!).getAllByTestId('rubric-dimension-row')).toHaveLength(3);
    expect(within(c).getByTestId('rubric-total-line')).toHaveTextContent('Active weights total 280, shown scaled to 100.');
    expect(within(c).getByTestId('rubric-inactive-list')).toHaveTextContent('New Models');
    expect(within(c).getByTestId('rubric-card-summary')).toHaveTextContent('Version 1 · total weight 280');
    // The table body scrolls inside the card (focusable named region).
    expect(within(c).getByRole('region', { name: 'Scoring dimensions' })).toHaveAttribute('tabindex', '0');
  });

  it('on a phone each pillar is a boxed section with a header and its dimensions stacked inside', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 639px)' || query === '(max-width: 767px)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      current = testRubric({ can_edit: false });
      renderPanel();
      const c = card();
      const stack = await within(c).findByTestId('rubric-dimensions-stacked');
      expect(within(c).queryByTestId('rubric-dimensions-table')).not.toBeInTheDocument();
      const sections = await within(stack).findAllByTestId('rubric-pillar-group');
      expect(sections.map((x) => x.tagName)).toEqual(Array(5).fill('SECTION'));
      expect(within(stack).getByRole('heading', { name: /Strategic Alignment/ })).toBeInTheDocument();
      expect(within(sections[0]!).getAllByTestId('rubric-dimension-row')).toHaveLength(3);
      expect(sections.map((x) => x.getAttribute('data-tint'))).toEqual(['false', 'true', 'false', 'true', 'false']);
      await act(async () => {
        expect(await seriousAxeViolations(c)).toEqual([]);
      });
    } finally {
      window.matchMedia = original;
    }
  });

  it('read-only users see "Read-only · managed by Admins" and no Edit button', async () => {
    current = testRubric({ can_edit: false });
    renderPanel();
    expect(await within(card()).findByTestId('rubric-readonly-note')).toHaveTextContent('Read-only · managed by Admins');
    expect(within(card()).queryByRole('button', { name: 'Edit rubric' })).not.toBeInTheDocument();
    expect(within(card()).queryAllByRole('textbox')).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Edit rubric appears only for the served can_edit and turns the table into an inline editor in the same card', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(await within(card()).findByRole('button', { name: 'Edit rubric' })).toBeInTheDocument();
    expect(within(card()).queryByTestId('rubric-readonly-note')).not.toBeInTheDocument();
    const c = await enterEdit(user);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(c).queryByTestId('rubric-dimensions-table')).not.toBeInTheDocument();
    expect(within(c).getAllByTestId('rubric-row')).toHaveLength(13);
    await waitFor(() => expect(within(c).getByRole('region', { name: 'Editing the rubric (version 1)' })).toHaveFocus());
    expect(within(c).queryByRole('button', { name: 'Edit rubric' })).not.toBeInTheDocument();
    expect(within(c).getByTestId('rubric-editing-badge')).toHaveTextContent('Editing');
    const footer = within(within(c).getByTestId('rubric-footer'));
    expect(footer.getByLabelText(/Reason for this change/)).toBeInTheDocument();
    expect(footer.getByTestId('rubric-totals')).toHaveTextContent('Current total weight 295');
    for (const name of ['Preview impact', 'Save new version', 'Cancel']) {
      expect(footer.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('adds a dimension in a new pillar: live current vs proposed total, focus on the new row', async () => {
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    const form = within(within(c).getByTestId('rubric-add-form'));
    await user.type(form.getByLabelText('Label'), 'Sustainability & ESG');
    await user.selectOptions(form.getByLabelText('Pillar'), 'New pillar…');
    await user.type(form.getByRole('textbox', { name: 'New pillar name' }), 'Sustainability');
    await user.type(form.getByLabelText('Weight'), '30');
    expect(within(c).getByTestId('rubric-add-totals')).toHaveTextContent('Total weight: current 295 → proposed 325 with this dimension');
    await user.click(form.getByRole('button', { name: 'Add dimension' }));

    const label = within(c).getByRole('textbox', { name: 'Label of Sustainability & ESG' });
    await waitFor(() => expect(label).toHaveFocus());
    expect(within(c).getAllByTestId('rubric-pillar').at(-1)).toHaveTextContent('Sustainability');
    expect(within(c).getByTestId('rubric-proposed-total')).toHaveTextContent('Proposed (draft) 325');
    expect(within(c).getByTestId('rubric-row-new')).toBeInTheDocument();
    expect(within(c).getByTestId('rubric-announce')).toHaveTextContent('Sustainability & ESG added to Sustainability.');
    expect(within(c).getByTestId('rubric-editing-badge')).toHaveTextContent('Editing · unsaved changes');
  });

  it('the add form validates label, unique label and weight like the server', async () => {
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    const form = within(within(c).getByTestId('rubric-add-form'));
    await user.click(form.getByRole('button', { name: 'Add dimension' }));
    expect(form.getByText('A label is required')).toBeInTheDocument();
    expect(form.getByText('Enter a whole number from 1 to 100')).toBeInTheDocument();
    await user.type(form.getByLabelText('Label'), 'roi');
    await user.type(form.getByLabelText('Weight'), '101');
    await user.click(form.getByRole('button', { name: 'Add dimension' }));
    expect(form.getByText('Another dimension has this label (labels must be unique)')).toBeInTheDocument();
    expect(within(c).getAllByTestId('rubric-row')).toHaveLength(13);
  });

  it('deactivates a dimension (greyed, "scores are kept", out of the total) and reactivates it', async () => {
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    await user.click(within(c).getByRole('checkbox', { name: 'Active: New Models' }));
    const row = rowOf('New Models');
    expect(row).toHaveAttribute('data-active', 'false');
    expect(within(row).getByTestId('rubric-inactive-note')).toHaveTextContent('Not in the score; scores are kept.');
    expect(within(c).getByTestId('rubric-proposed-total')).toHaveTextContent('280');
    await user.click(within(row).getByRole('button', { name: 'Reactivate New Models' }));
    expect(rowOf('New Models')).toHaveAttribute('data-active', 'true');
    expect(within(c).queryByTestId('rubric-proposed-total')).not.toBeInTheDocument();
  });

  it('reorders with the keyboard (Move up / down keep focus and announce) and by drag, within and across pillars', async () => {
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    expect(rowKeys().slice(0, 3)).toEqual(['strategic_project', 'new_customer', 'new_options']);
    within(c).getByRole('button', { name: 'Move Strategic Project down' }).focus();
    await user.keyboard('{Enter}');
    expect(rowKeys().slice(0, 3)).toEqual(['new_customer', 'strategic_project', 'new_options']);
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Move Strategic Project down' })).toHaveFocus());
    expect(within(c).getByTestId('rubric-announce')).toHaveTextContent('Strategic Project moved down: position 2 of 3 in Strategic Alignment.');
    const up = within(c).getByRole('button', { name: 'Move New Customer up' });
    expect(up).toHaveAttribute('aria-disabled', 'true');
    await user.click(up);
    expect(rowKeys()[0]).toBe('new_customer');

    const handle = within(rowOf('New Options')).getByTestId('rubric-drag-handle');
    const data = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '' };
    fireEvent.dragStart(handle, { dataTransfer: data });
    fireEvent.dragOver(rowOf('New Customer'), { dataTransfer: data });
    fireEvent.drop(rowOf('New Customer'), { dataTransfer: data });
    expect(rowKeys().slice(0, 3)).toEqual(['new_options', 'new_customer', 'strategic_project']);
    // P26-T03: a drop on another pillar's dimension moves it into that pillar, before the target.
    fireEvent.dragStart(within(rowOf('New Options')).getByTestId('rubric-drag-handle'), { dataTransfer: data });
    fireEvent.drop(rowOf('RM Savings'), { dataTransfer: data });
    const keys = rowKeys();
    expect(keys[keys.indexOf('rm_savings') - 1]).toBe('new_options');
    expect(within(c).getAllByTestId('rubric-pillar').find((p) => p.getAttribute('data-pillar') === 'Financial Return')).toContainElement(rowOf('New Options'));
    // Keyboard: Move up at the top of a pillar crosses into the previous pillar (its last row).
    within(c).getByRole('button', { name: 'Move New Options up' }).focus();
    await user.keyboard('{Enter}');
    expect(within(c).getAllByTestId('rubric-pillar').find((p) => p.getAttribute('data-pillar') === 'Regulatory & Quality')).toContainElement(rowOf('New Options'));
    expect(within(c).getByTestId('rubric-announce')).toHaveTextContent('New Options moved up into Regulatory & Quality: position 3 of 3 in Regulatory & Quality.');
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Move New Options up' })).toHaveFocus());
    // Edit mode keeps the grouping: tinted alternation per pillar section, as in the read table.
    expect(within(c).getAllByTestId('rubric-pillar').map((p) => p.getAttribute('data-tint'))).toEqual(['false', 'true', 'false', 'true', 'false']);
    expect(within(c).getAllByTestId('rubric-pillar-draft-summary')[1]).toHaveTextContent('3 dimensions · weight 75 (draft)');

    await user.click(within(c).getByRole('button', { name: 'Move pillar Regulatory & Quality up' }));
    expect(rowKeys()[0]).toBe('regulatory_compliance');
    // A pillar change moves the row into that group; "New pillar…" creates a new group with the next tint.
    await user.selectOptions(within(rowOf('ROI')).getByLabelText(/Pillar/), 'New pillar…');
    await user.type(within(c).getByRole('textbox', { name: 'New pillar name for ROI' }), 'Sustainability{Enter}');
    const sections = within(c).getAllByTestId('rubric-pillar');
    expect(sections.at(-1)).toHaveAttribute('data-pillar', 'Sustainability');
    expect(sections.at(-1)).toHaveAttribute('data-tint', 'true'); // 6th pillar
    expect(sections.at(-1)).toContainElement(rowOf('ROI'));
  });

  it('validation mirrors the server: label required, duplicate label, weight range, no active dimension; nothing is sent', async () => {
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    const stratLabel = within(c).getByRole('textbox', { name: 'Label of Strategic Project' });
    await user.clear(stratLabel);
    expect(within(rowOf('Strategic Project')).getByTestId('rubric-error-label')).toHaveTextContent('A label is required');
    expect(stratLabel).toHaveAttribute('aria-invalid', 'true');
    await user.type(stratLabel, 'new customer');
    expect(within(rowOf('New Customer')).getByTestId('rubric-error-label')).toHaveTextContent('labels must be unique');
    await user.clear(stratLabel);
    await user.type(stratLabel, 'Strategic Fit');
    const weight = within(c).getByRole('spinbutton', { name: 'Weight of ROI' });
    await user.clear(weight);
    await user.type(weight, '150');
    expect(within(rowOf('ROI')).getByTestId('rubric-error-weight')).toHaveTextContent('Enter a whole number from 1 to 100');
    await user.clear(weight);
    await user.type(weight, '25');
    for (const d of INITIAL_TEST_DIMENSIONS) {
      await user.click(within(c).getByRole('checkbox', { name: `Active: ${d.label}` }));
    }
    expect(within(c).getByTestId('rubric-form-errors')).toHaveTextContent('At least one dimension must be active.');
    await user.type(within(c).getByTestId('rubric-reason'), 'try');
    await user.click(within(c).getByRole('button', { name: 'Save new version' }));
    await user.click(within(c).getByRole('button', { name: 'Preview impact' }));
    expect(mockSend).not.toHaveBeenCalled();
    expect(within(c).getByTestId('rubric-status')).toHaveTextContent('Fix the highlighted fields');
  }, 30_000);

  it('Preview impact shows the served summary and the changed projects in an expandable panel inside the card', async () => {
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    const w = within(c).getByRole('spinbutton', { name: 'Weight of Strategic Project' });
    await user.clear(w);
    await user.type(w, '55');
    await user.click(within(c).getByRole('button', { name: 'Preview impact' }));
    expect(mockSend).toHaveBeenCalledWith('POST', '/scoring-rubric/preview', {
      dimensions: expect.arrayContaining([
        { key: 'strategic_project', label: 'Strategic Project', pillar: 'Strategic Alignment', weight: 55, inverted: false, active: true },
      ]) as unknown,
    });
    const preview = within(await within(c).findByTestId('rubric-preview'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(preview.getByTestId('rubric-preview-total')).toHaveTextContent('295 → 325');
    expect(preview.getByTestId('rubric-preview-score-band-count')).toHaveTextContent('2');
    expect(preview.getByTestId('rubric-band-changes')).toHaveTextContent('1 P2 → P1');
    let rows = preview.getAllByTestId('rubric-preview-row');
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['Alpha', 'Beta']);
    expect(rows[0]).toHaveTextContent('incomplete (1)');
    await user.click(preview.getByRole('button', { name: 'New' }));
    rows = preview.getAllByTestId('rubric-preview-row');
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['Beta', 'Alpha']);
    expect(preview.getByRole('columnheader', { name: 'New' })).toHaveAttribute('aria-sort', 'ascending');

    // Expandable: collapse and reopen.
    const toggle = within(c).getByRole('button', { name: 'Hide impact preview' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(within(c).queryByTestId('rubric-preview')).not.toBeInTheDocument();
    await user.click(within(c).getByRole('button', { name: 'Show impact preview' }));
    expect(within(c).getByTestId('rubric-preview')).toBeInTheDocument();
    // A later edit marks it out of date.
    await user.type(w, '1');
    expect(within(c).getByTestId('rubric-preview-stale')).toBeInTheDocument();
  });

  it('Save sends the full list with version and reason, invalidates every score reader and leaves edit mode', async () => {
    const user = userEvent.setup();
    const { invalidate } = renderPanel();
    const c = await enterEdit(user);
    const w = within(c).getByRole('spinbutton', { name: 'Weight of New Models' });
    await user.clear(w);
    await user.type(w, '30');
    const form = within(within(c).getByTestId('rubric-add-form'));
    await user.type(form.getByLabelText('Label'), 'Sustainability & ESG');
    await user.selectOptions(form.getByLabelText('Pillar'), 'New pillar…');
    await user.type(form.getByRole('textbox', { name: 'New pillar name' }), 'Sustainability');
    await user.type(form.getByLabelText('Weight'), '30');
    await user.click(form.getByRole('button', { name: 'Add dimension' }));

    await user.click(within(c).getByRole('button', { name: 'Save new version' }));
    expect(within(c).getByTestId('rubric-reason-error')).toHaveTextContent('A reason is required');
    expect(mockSend).not.toHaveBeenCalled();

    await user.type(within(c).getByTestId('rubric-reason'), '  Raise New Models, add ESG  ');
    await user.click(within(c).getByRole('button', { name: 'Save new version' }));
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [method, path, body] = mockSend.mock.calls[0] as [string, string, ScoringRubricUpdateRequest];
    expect(method).toBe('PUT');
    expect(path).toBe('/scoring-rubric');
    expect(body.version).toBe(1);
    expect(body.reason).toBe('Raise New Models, add ESG');
    expect(body.dimensions).toHaveLength(14);
    expect(body.dimensions.find((d) => d.key === 'new_models')?.weight).toBe(30);
    expect(body.dimensions.at(-1)).toEqual({ label: 'Sustainability & ESG', pillar: 'Sustainability', weight: 30, inverted: false, active: true });

    expect(await within(c).findByTestId('rubric-card-notice')).toHaveTextContent('Saved as version 2');
    for (const key of [['priority-matrix'], ['scoring-rubric'], ['priority-board'], ['vip-board'], ['projects', 'workspace']]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    }
    // Back to the table, on the new version; focus returns to Edit rubric.
    expect(within(c).queryByTestId('rubric-editor')).not.toBeInTheDocument();
    await waitFor(() => expect(within(c).getByTestId('rubric-card-summary')).toHaveTextContent('Version 2 · total weight 340'));
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Edit rubric' })).toHaveFocus());
    expect(within(c).getAllByTestId('rubric-dimension-row')).toHaveLength(14);
  });

  it('a 409 says someone else changed it; Reload keeps the draft for comparison and can re-apply it on the latest version', async () => {
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    const theirs = testRubric({ version: 2, can_edit: true }, [
      ...INITIAL_TEST_DIMENSIONS,
      { key: 'safety', label: 'Safety', pillar: 'Regulatory & Quality', weight: 20 },
    ]);
    current = theirs;
    const w = within(c).getByRole('spinbutton', { name: 'Weight of Strategic Project' });
    await user.clear(w);
    await user.type(w, '40');
    await user.type(within(c).getByTestId('rubric-reason'), 'More strategy');
    await user.click(within(c).getByRole('button', { name: 'Save new version' }));
    const conflict = await within(c).findByTestId('rubric-conflict');
    expect(conflict).toHaveTextContent('Someone else changed the rubric; reload and re-apply.');

    nextGet = theirs;
    await user.click(within(conflict).getByRole('button', { name: /Reload latest version/ }));
    const comparison = await within(c).findByTestId('rubric-comparison');
    expect(comparison).toHaveTextContent('Your previous draft, compared with version 2');
    expect(within(comparison).getByTestId('rubric-rebase-applied')).toHaveTextContent('Strategic Project · weight 25 → 40');
    expect(within(comparison).queryByTestId('rubric-rebase-conflicts')).not.toBeInTheDocument();
    expect(within(c).getByRole('spinbutton', { name: 'Weight of Strategic Project' })).toHaveValue(25);
    expect(within(c).getByRole('textbox', { name: 'Label of Safety' })).toBeInTheDocument();
    expect(within(c).getByTestId('rubric-card-summary')).toHaveTextContent('Version 2');

    await user.click(within(comparison).getByRole('button', { name: 'Re-apply my draft on version 2' }));
    expect(within(c).getByRole('spinbutton', { name: 'Weight of Strategic Project' })).toHaveValue(40);
    mockSend.mockClear();
    await user.click(within(c).getByRole('button', { name: 'Save new version' }));
    const [, , body] = mockSend.mock.calls[0] as [string, string, ScoringRubricUpdateRequest];
    expect(body.version).toBe(2);
    expect(body.dimensions.map((d) => d.key)).toContain('safety');
  });

  it('QA-F26-1: re-apply keeps the other Admin\'s change (disjoint edits) and asks per field on a conflict, defaulting to the server value', async () => {
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    // Tab A saved New Customer 30 meanwhile.
    const theirs = testRubric(
      { version: 2, can_edit: true },
      INITIAL_TEST_DIMENSIONS.map((d) => (d.key === 'new_customer' ? { ...d, weight: 30 } : d.key === 'rm_savings' ? { ...d, weight: 30 } : d)),
    );
    current = theirs;
    // Tab B (this one) edits New Options (disjoint) and RM Savings (same field as tab A).
    const no = within(c).getByRole('spinbutton', { name: 'Weight of New Options' });
    await user.clear(no);
    await user.type(no, '30');
    const rm = within(c).getByRole('spinbutton', { name: 'Weight of RM Savings' });
    await user.clear(rm);
    await user.type(rm, '40');
    await user.type(within(c).getByTestId('rubric-reason'), 'Tab B');
    await user.click(within(c).getByRole('button', { name: 'Save new version' }));
    const conflict = await within(c).findByTestId('rubric-conflict');
    nextGet = theirs;
    await user.click(within(conflict).getByRole('button', { name: /Reload latest version/ }));
    const comparison = await within(c).findByTestId('rubric-comparison');
    expect(within(comparison).getByTestId('rubric-conflict-count')).toHaveTextContent('1 conflict');
    expect(within(comparison).getByTestId('rubric-rebase-applied')).toHaveTextContent('New Options · weight 25 → 30');
    expect(within(comparison).getByTestId('rubric-rebase-applied')).not.toHaveTextContent('New Customer');
    const field = within(comparison).getByRole('group', { name: 'RM Savings · weight' });
    expect(within(field).getByTestId('rubric-rebase-values')).toHaveTextContent('Your value 40 · Current 30');
    expect(within(field).getByRole('radio', { name: 'Keep current (30)' })).toBeChecked();
    expect(await seriousAxeViolations(c)).toEqual([]);

    // Default: the server value is kept for the conflict; my disjoint edit applies; theirs is not reverted.
    await user.click(within(comparison).getByRole('button', { name: 'Re-apply my draft on version 2' }));
    expect(within(c).getByRole('spinbutton', { name: 'Weight of New Customer' })).toHaveValue(30);
    expect(within(c).getByRole('spinbutton', { name: 'Weight of New Options' })).toHaveValue(30);
    expect(within(c).getByRole('spinbutton', { name: 'Weight of RM Savings' })).toHaveValue(30);
    expect(within(c).getByTestId('rubric-status')).toHaveTextContent('1 conflict keeps the current value');
    mockSend.mockClear();
    await user.click(within(c).getByRole('button', { name: 'Save new version' }));
    await waitFor(() => expect(mockSend).toHaveBeenCalled());
    const [, , body] = mockSend.mock.calls[0] as [string, string, ScoringRubricUpdateRequest];
    expect(body.version).toBe(2);
    const w = (k: string) => body.dimensions.find((d) => d.key === k)?.weight;
    expect([w('new_customer'), w('new_options'), w('rm_savings')]).toEqual([30, 30, 30]);
  });

  it('QA-F26-1: choosing "Use mine" on a conflict re-applies my value', async () => {
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    const theirs = testRubric(
      { version: 2, can_edit: true },
      INITIAL_TEST_DIMENSIONS.map((d) => (d.key === 'rm_savings' ? { ...d, weight: 30 } : d)),
    );
    current = theirs;
    const rm = within(c).getByRole('spinbutton', { name: 'Weight of RM Savings' });
    await user.clear(rm);
    await user.type(rm, '40');
    await user.type(within(c).getByTestId('rubric-reason'), 'Tab B');
    await user.click(within(c).getByRole('button', { name: 'Save new version' }));
    const conflict = await within(c).findByTestId('rubric-conflict');
    nextGet = theirs;
    await user.click(within(conflict).getByRole('button', { name: /Reload latest version/ }));
    const comparison = await within(c).findByTestId('rubric-comparison');
    await user.click(within(comparison).getByRole('radio', { name: 'Use mine (40)' }));
    expect(within(comparison).getByRole('radio', { name: 'Use mine (40)' })).toBeChecked();
    await user.click(within(comparison).getByRole('button', { name: 'Re-apply my draft on version 2' }));
    expect(within(c).getByRole('spinbutton', { name: 'Weight of RM Savings' })).toHaveValue(40);
    expect(within(c).getByTestId('rubric-status')).not.toHaveTextContent('keeps the current value');
  });

  it('maps a field-level 422 from the server onto the field', async () => {
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    mockSend.mockRejectedValueOnce(
      new ApiError(422, 'invalid', JSON.stringify([{ loc: ['body', 'dimensions', 0, 'label'], msg: 'String should have at most 80 characters', type: 'x' }])),
    );
    await user.type(within(c).getByTestId('rubric-reason'), 'why');
    await user.click(within(c).getByRole('button', { name: 'Save new version' }));
    expect(await within(rowOf('Strategic Project')).findByTestId('rubric-error-label')).toHaveTextContent('String should have at most 80 characters');
  });

  it('Cancel without changes leaves edit mode at once; with changes it asks, Keep editing keeps the draft, Discard drops it', async () => {
    const user = userEvent.setup();
    renderPanel();
    let c = await enterEdit(user);
    await user.click(within(c).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(within(c).queryByTestId('rubric-editor')).not.toBeInTheDocument();
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Edit rubric' })).toHaveFocus());

    c = await enterEdit(user);
    const w = within(c).getByRole('spinbutton', { name: 'Weight of ROI' });
    await user.clear(w);
    await user.type(w, '45');
    await user.click(within(c).getByRole('button', { name: 'Cancel' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Discard your rubric changes?' });
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(within(c).getByRole('spinbutton', { name: 'Weight of ROI' })).toHaveValue(45);
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Cancel' })).toHaveFocus());

    await user.click(within(c).getByRole('button', { name: 'Cancel' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    expect(within(c).queryByTestId('rubric-editor')).not.toBeInTheDocument();
    expect(within(c).getByTestId('rubric-card-notice')).toHaveTextContent('Changes discarded');
    await waitFor(() => expect(within(c).getByRole('button', { name: 'Edit rubric' })).toHaveFocus());
    expect(mockSend).not.toHaveBeenCalled();
    // Editing again starts from the served rubric.
    c = await enterEdit(user);
    expect(within(c).getByRole('spinbutton', { name: 'Weight of ROI' })).not.toHaveValue(45);
  });

  it('warns before unloading the page only while there are unsaved changes', async () => {
    const user = userEvent.setup();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    renderPanel();
    const c = await enterEdit(user);
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(0);
    await user.click(within(c).getByRole('checkbox', { name: 'Active: New Models' }));
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(1);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await user.click(within(c).getByRole('button', { name: 'Cancel' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    expect(remove.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });

  it('blocks an in-app link while there are unsaved changes and asks (data router)', async () => {
    const user = userEvent.setup();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        {
          path: '/matrix',
          element: (
            <>
              <Link to="/gantt">Go to Gantt</Link>
              <ScoringRubricPanel />
            </>
          ),
        },
        { path: '/gantt', element: <p>Gantt page</p> },
      ],
      { initialEntries: ['/matrix'] },
    );
    render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const c = await enterEdit(user);
    await user.click(within(c).getByRole('checkbox', { name: 'Active: New Models' }));
    await user.click(screen.getByRole('link', { name: 'Go to Gantt' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Leave with unsaved rubric changes?' });
    await user.click(within(ask).getByRole('button', { name: 'Stay on this page' }));
    expect(screen.queryByText('Gantt page')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Go to Gantt' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave and discard' }));
    expect(await screen.findByText('Gantt page')).toBeInTheDocument();
  });

  it('Version history (for everyone, read-only too) lists who, when, why and total weight with each version\'s diff', async () => {
    const v1 = testRubric({ can_edit: false, reason: 'Initial rubric' });
    const v2 = testRubric({ version: 2, can_edit: false, reason: 'Raise New Models', changed_by_name: 'Ada Admin', changed_at: '2026-10-22T09:30:00Z' }, [
      ...INITIAL_TEST_DIMENSIONS.map((d) => (d.key === 'new_models' ? { ...d, weight: 30 } : d)),
      { key: 'sustainability_esg', label: 'Sustainability & ESG', pillar: 'Sustainability', weight: 30 },
    ]);
    current = v2;
    versions = [v2, v1];
    const user = userEvent.setup();
    renderPanel();
    await within(card()).findByTestId('rubric-readonly-note');
    expect(mockGet.mock.calls.some(([p]) => p === '/scoring-rubric/versions')).toBe(false);
    const trigger = within(card()).getByRole('button', { name: 'Rubric version history' });
    expect(trigger).toHaveTextContent('Version history');
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Rubric version history' });
    const items = await within(dialog).findAllByTestId('rubric-version');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Version 2');
    expect(items[0]).toHaveTextContent('Current');
    expect(items[0]).toHaveTextContent('Ada Admin');
    expect(items[0]).toHaveTextContent('Raise New Models');
    expect(items[0]).toHaveTextContent('Total weight 340 (was 295)');
    expect(items[1]).toHaveTextContent('system (migration)');
    await user.click(within(items[0]!).getByRole('button', { name: 'Show changes' }));
    const changes = within(items[0]!).getAllByTestId('rubric-version-change');
    expect(changes.map((x) => x.textContent)).toEqual([
      expect.stringContaining('New Models weight: 15 → 30'),
      expect.stringContaining('Sustainability & ESG added'),
    ]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('has no serious or critical axe violations (read-only table; editor with a preview)', async () => {
    current = testRubric({ can_edit: false });
    const first = renderPanel();
    await within(card()).findAllByTestId('rubric-dimension-row');
    await act(async () => {
      expect(await seriousAxeViolations(card())).toEqual([]);
    });
    first.unmount();

    current = testRubric({ can_edit: true });
    const user = userEvent.setup();
    renderPanel();
    const c = await enterEdit(user);
    await user.click(within(c).getByRole('checkbox', { name: 'Active: New Models' }));
    await user.click(within(c).getByRole('button', { name: 'Preview impact' }));
    await within(c).findByTestId('rubric-preview');
    await act(async () => {
      expect(await seriousAxeViolations(c)).toEqual([]);
    });
  }, 30_000);
});
