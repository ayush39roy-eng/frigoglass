import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { MeResponse } from '@/lib/api/session';
import { useSessionStore } from '@/stores/session';

import { buildSimulateRequest } from '../import-rows';
import { DEFAULT_IMPORT_OPTIONS, useImportPlan } from '../import-store';
import { importParseResponseSchema, importSimulateResponseSchema, savedScenarioSchema } from '../import-schema';
import type { ImportParseResponse, ImportSimulateRequest, ImportSimulateResponse, PlanWeekChoice } from '../import-types';
import {
  bandHint,
  cutoffWeek,
  pickerChoices,
  planScope,
  savedWindowText,
  windowBlockedReason,
  windowOptionsOf,
} from '../plan-window';
import { optionsOf, savedBannerTitle, savedViewOf, storedEntryOf } from '../saved-scenarios';
import { mixedPlanFrom, mixedPlanUntil } from '../scenario-compare';
import { useImportScenarios } from '../scenarios-store';
import { P41_RESPONSE, p41Saved } from '../p41-fixtures';
import { PARSE_RESPONSE, ROWS, SIMULATE_RESPONSE } from '../test-fixtures';
import { importScale } from '../gantt-geometry';
import ImportPlanView from './import-plan-view';
import { IssueList } from './issue-list';
import { PlanWindowNotice } from './plan-window-notice';
import { ResultsExecutive } from './results-executive';
import { ResultsGantt } from './results-gantt';
import { ReviewStep } from './review-step';
import { ImportStepTimingDialog } from './step-timing-dialog';

/**
 * P50-T03 (ADR 0061, R49-1..R49-21, API_CONTRACT_P32 Part D, API_CONTRACT_P41 §F): the
 * "Plan from" / "Plan until" pickers, the request they make, the re-run flag, the served
 * window wording and the "band" priority source.
 */

const idle = { pending: false, error: null, token: 0 };

/** Server-made labels (synthetic): the browser shows them verbatim and derives no date. */
const CHOICES: PlanWeekChoice[] = Array.from({ length: 104 - 42 + 1 }, (_, i) => {
  const week = 42 + i;
  return { week, label: `Server label ${String(week)}` };
});

const PARSED: ImportParseResponse = { ...PARSE_RESPONSE, plan_from_min_week: 42, plan_week_choices: CHOICES };

const WINDOWED: ImportSimulateResponse = {
  ...SIMULATE_RESPONSE,
  plan_from_week: 53,
  plan_from_min_week: 42,
  plan_from_label: 'W1 2027 (4 Jan 2027)',
  plan_until_week: 72,
  plan_window_label: 'W1 2027 – W20 2027',
  plan_week_choices: CHOICES,
};

beforeEach(() => {
  useImportPlan.getState().reset();
  useImportScenarios.getState().clear();
  useSessionStore.setState({ me: { plan_year: 2026 } as MeResponse });
});
afterEach(() => {
  useSessionStore.setState({ me: null });
  vi.unstubAllGlobals();
});

describe('P50 request payload', () => {
  it('omits every window key at the defaults, so the body is the pre-P50 one', () => {
    const body = buildSimulateRequest(ROWS, DEFAULT_IMPORT_OPTIONS, {});
    expect(body).not.toHaveProperty('plan_from_week');
    expect(body).not.toHaveProperty('plan_until_week');
    expect(body).not.toHaveProperty('plan_window_rerun');
    const nulls = buildSimulateRequest(ROWS, { ...DEFAULT_IMPORT_OPTIONS, planFromWeek: null, planUntilWeek: null }, {});
    expect(JSON.stringify(nulls)).toBe(JSON.stringify(body));
  });

  it('sends plan_from_week / plan_until_week when chosen; u equal to the preset is the plan year (omitted)', () => {
    const body = buildSimulateRequest(ROWS, { ...DEFAULT_IMPORT_OPTIONS, planFromWeek: 53, planUntilWeek: 72 }, {});
    expect(body.plan_from_week).toBe(53);
    expect(body.plan_until_week).toBe(72);
    const preset = buildSimulateRequest(ROWS, { ...DEFAULT_IMPORT_OPTIONS, planUntilWeek: 104 }, {});
    expect(preset).not.toHaveProperty('plan_until_week');
  });

  it('sends plan_window_rerun: true only on a re-run', () => {
    expect(buildSimulateRequest(ROWS, { ...DEFAULT_IMPORT_OPTIONS, planWindowRerun: true }, {}).plan_window_rerun).toBe(
      true,
    );
    expect(buildSimulateRequest(ROWS, { ...DEFAULT_IMPORT_OPTIONS, planWindowRerun: false }, {})).not.toHaveProperty(
      'plan_window_rerun',
    );
  });

  it('keeps the served window fields through the zod schemas (parse, result, stored request)', () => {
    const parsed = importParseResponseSchema.parse(PARSED);
    expect(parsed.plan_from_min_week).toBe(42);
    expect(parsed.plan_week_choices?.[11]).toEqual({ week: 53, label: 'Server label 53' });
    const result = importSimulateResponseSchema.parse(WINDOWED);
    expect(result.plan_until_week).toBe(72);
    expect(result.plan_window_label).toBe('W1 2027 – W20 2027');
    const saved = p41Saved({ plan_from_week: 45, plan_until_week: 80 });
    const parsedSaved = savedScenarioSchema.parse({
      ...saved,
      request: { ...saved.request, plan_from_week: 45, plan_until_week: 80, plan_window_rerun: false },
    });
    expect(parsedSaved.request.plan_from_week).toBe(45);
    expect(parsedSaved.request.plan_until_week).toBe(80);
    expect(parsedSaved.plan_from_week).toBe(45);
    const band = importParseResponseSchema.parse({
      ...PARSED,
      rows: [{ ...ROWS[0]!, priority_source: 'band', file_band: 'P1' }],
    });
    expect(band.rows[0]?.priority_source).toBe('band');
    expect(band.rows[0]?.file_band).toBe('P1');
  });
});

describe('P50 picker logic', () => {
  it('Plan from = today..u, Plan until = f..104 without the preset week', () => {
    const p = pickerChoices(CHOICES, 42, { planYearEndWeek: 104, planFromWeek: 60, planUntilWeek: 80 });
    expect(p.fromWeek).toBe(60);
    expect(p.from[0]?.week).toBe(42);
    expect(p.from.at(-1)?.week).toBe(80);
    expect(p.until[0]?.week).toBe(60);
    expect(p.until.at(-1)?.week).toBe(103);
    const d = pickerChoices(CHOICES, 42, { planYearEndWeek: 52 });
    expect(d.fromWeek).toBe(42);
    expect(d.from.at(-1)?.week).toBe(52);
    expect(d.until.some((c) => c.week === 52)).toBe(false);
    expect(d.until.at(-1)?.week).toBe(104);
  });

  it('blocks a window the server would refuse (I56) unless it is a re-run', () => {
    expect(windowBlockedReason({ planYearEndWeek: 104 }, 42)).toBeNull();
    expect(windowBlockedReason({ planYearEndWeek: 52, planFromWeek: 60 }, 42)).toMatch(/end of the plan year/);
    expect(windowBlockedReason({ planYearEndWeek: 104, planFromWeek: 60, planUntilWeek: 55 }, 42)).toMatch(
      /after “Plan until”/,
    );
    expect(windowBlockedReason({ planYearEndWeek: 104, planFromWeek: 40 }, 42)).toMatch(/has passed/);
    expect(windowBlockedReason({ planYearEndWeek: 104, planFromWeek: 40, planWindowRerun: true }, 42)).toBeNull();
  });

  it('a re-run result settles to options (today = null, preset = null, flag off)', () => {
    expect(windowOptionsOf({ plan_from_week: 42, plan_from_min_week: 42, plan_until_week: 104, current_week: 42 }, 104)).toEqual({
      planFromWeek: null,
      planUntilWeek: null,
      planWindowRerun: false,
    });
    expect(windowOptionsOf({ plan_from_week: 53, plan_from_min_week: 42, plan_until_week: 72, current_week: 42 }, 104)).toEqual({
      planFromWeek: 53,
      planUntilWeek: 72,
      planWindowRerun: false,
    });
  });

  it('the cut-off reads served plan_until_week, falling back to plan_year_end_week', () => {
    expect(cutoffWeek(WINDOWED)).toBe(72);
    expect(cutoffWeek(SIMULATE_RESPONSE)).toBe(104);
    expect(planScope(SIMULATE_RESPONSE)).toMatchObject({ windowed: false, inPhrase: 'in 2027', name: '2027' });
    expect(planScope(WINDOWED)).toMatchObject({
      windowed: true,
      inPhrase: 'within the plan window',
      windowLabel: 'W1 2027 – W20 2027',
    });
    // A served u equal to the preset (no window label) keeps the plan-year wording.
    expect(planScope({ ...SIMULATE_RESPONSE, plan_until_week: 104, plan_window_label: null }).inPhrase).toBe('in 2027');
    // The Gantt axis runs past the served cut-off, not past the preset.
    const noProjects = { ...WINDOWED, projects: [] };
    expect(importScale(noProjects).horizonWeeks).toBe(72 + 4 - 42 + 1);
  });

  it('labels: band source, saved window and banner use week-of-year labels (never W53+)', () => {
    expect(bandHint(null)).toBe('From Must Do / band column');
    expect(bandHint(3)).toBe('From Must Do / band column · rank 3 in band');
    expect(savedWindowText({ plan_from_week: 47, plan_until_week: 72 })).toBe("Plan from W47 to W20 '27");
    expect(savedWindowText({})).toBeNull();
    expect(savedBannerTitle(57, 14)).toBe("Saved scenario — simulated W5 '27 against plan v14");
  });
});

describe('P50 Review step pickers', () => {
  it('shows the server labels, defaults Plan from to this week and sends the chosen window', async () => {
    useImportPlan.getState().setParsed(PARSED);
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <ReviewStep parsed={PARSED} simulation={idle} onCompute={() => {}} onRetry={() => {}} />,
    );
    const from = screen.getByRole('combobox', { name: 'Plan from' });
    const until = screen.getByRole('combobox', { name: 'Plan until (optional)' });
    expect(from).toHaveValue('42');
    expect(within(from).getByRole('option', { name: 'Server label 42 — this week' })).toBeInTheDocument();
    expect(within(from).getByRole('option', { name: 'Server label 53' })).toBeInTheDocument();
    expect(until).toHaveValue('');
    expect(within(until).getByRole('option', { name: 'End of the plan year — Server label 104' })).toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);

    await user.selectOptions(from, '53');
    expect(useImportPlan.getState().options.planFromWeek).toBe(53);
    // Plan until is bounded by the chosen Plan from.
    expect(within(until).queryByRole('option', { name: 'Server label 52' })).toBeNull();
    await user.selectOptions(until, '72');
    expect(useImportPlan.getState().options.planUntilWeek).toBe(72);
    let st = useImportPlan.getState();
    let body = buildSimulateRequest(st.rows, st.options, st.edits);
    expect(body.plan_from_week).toBe(53);
    expect(body.plan_until_week).toBe(72);

    // Back to the defaults: nothing is sent.
    await user.selectOptions(from, '42');
    await user.selectOptions(until, '');
    st = useImportPlan.getState();
    body = buildSimulateRequest(st.rows, st.options, st.edits);
    expect(body).not.toHaveProperty('plan_from_week');
    expect(body).not.toHaveProperty('plan_until_week');
  });

  it('a Plan from past the 2026 plan year blocks Compute until the window is valid', async () => {
    useImportPlan.getState().setParsed(PARSED);
    useImportPlan.getState().setOptions({ planFromWeek: 60 });
    const user = userEvent.setup();
    renderWithProviders(<ReviewStep parsed={PARSED} simulation={idle} onCompute={() => {}} onRetry={() => {}} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Plan year' }), '52');
    expect(screen.getByTestId('import-compute-hint')).toHaveTextContent('after the end of the plan year');
    expect(screen.getByRole('button', { name: 'Compute plan' })).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Plan until (optional)' }), '70');
    expect(screen.queryByTestId('import-compute-hint')).toBeNull();
  });

  it('no pickers when the parse serves no choices (pre-P50 server)', () => {
    useImportPlan.getState().setParsed(PARSE_RESPONSE);
    renderWithProviders(<ReviewStep parsed={PARSE_RESPONSE} simulation={idle} onCompute={() => {}} onRetry={() => {}} />);
    expect(screen.queryByRole('combobox', { name: 'Plan from' })).toBeNull();
  });

  it('a band-sourced row reads "From Must Do / band column" in the review table', () => {
    const rows = [{ ...ROWS[0]!, priority_source: 'band' as const, file_band: 'P1' as const, rank: null }, ...ROWS.slice(1)];
    const parsed = { ...PARSED, rows };
    useImportPlan.getState().setParsed(parsed);
    renderWithProviders(<ReviewStep parsed={parsed} simulation={idle} onCompute={() => {}} onRetry={() => {}} />);
    expect(screen.getAllByTestId('import-priority-hint')[0]).toHaveTextContent('From Must Do / band column');
  });

  it('the new issue codes get a short heading; the message stays the server’s', () => {
    renderWithProviders(
      <IssueList
        label="File issues"
        items={[
          { id: '1', severity: 'warning', code: 'PRIORITY_BAND_CONFLICT', message: 'Served message.', where: 'Row 4' },
        ]}
      />,
    );
    expect(screen.getByTestId('import-issue-title')).toHaveTextContent('Several band columns say Yes');
    expect(screen.getByTestId('import-issue')).toHaveTextContent('Served message.');
    expect(screen.getByTestId('import-issue')).toHaveTextContent('PRIORITY_BAND_CONFLICT');
  });
});

describe('P50 result wording', () => {
  it('the notice shows the served "file projects start from" and window labels; nothing at the defaults', () => {
    const { unmount } = renderWithProviders(<PlanWindowNotice result={WINDOWED} />);
    expect(screen.getByTestId('import-plan-from-line')).toHaveTextContent('File projects start from W1 2027 (4 Jan 2027)');
    expect(screen.getByTestId('import-plan-window-line')).toHaveTextContent('Plan window W1 2027 – W20 2027');
    unmount();
    renderWithProviders(
      <PlanWindowNotice
        result={{ ...SIMULATE_RESPONSE, plan_from_week: 42, plan_from_label: 'Label', plan_window_label: null }}
      />,
    );
    expect(screen.queryByTestId('import-plan-window-notice')).toBeNull();
  });

  it('KPI captions read "within the plan window" and the Gantt cut-off line is the served plan_until_week', async () => {
    useImportPlan.setState({ result: WINDOWED });
    const { unmount } = renderWithProviders(<ResultsExecutive result={WINDOWED} />);
    expect(await screen.findByTestId('import-kpi-within')).toHaveTextContent('Finish within the plan window');
    expect(screen.getByTestId('import-kpi-before-after')).toHaveTextContent('Plan within the plan window: before → after');
    unmount();
    renderWithProviders(<ResultsGantt result={WINDOWED} pending={false} />);
    const axis = await screen.findByTestId('import-gantt-axis');
    expect(axis).toHaveTextContent('End of the plan window');
  });
});

describe('P50 saved scenarios', () => {
  it('the view, the compare entry and the options carry the stored window', () => {
    const saved = p41Saved({ plan_from_week: 45, plan_until_week: 80 });
    saved.request = { ...saved.request, plan_from_week: 45, plan_until_week: 80 };
    const view = savedViewOf(saved);
    expect(view).toMatchObject({ plan_from_week: 45, plan_until_week: 80 });
    expect(storedEntryOf(saved).stored).toMatchObject({ planFromWeek: 45, planUntilWeek: 80 });
    expect(optionsOf(saved.request)).toMatchObject({ planFromWeek: 45, planUntilWeek: 80 });
    // A row saved before P50: f = simulated week, u = the preset.
    expect(savedViewOf(p41Saved())).toMatchObject({ plan_from_week: 40, plan_until_week: 104 });
  });

  it('Compare flags different Plan from / Plan until weeks', () => {
    const a = storedEntryOf(p41Saved({ plan_from_week: 40, plan_until_week: 104 }));
    const b = storedEntryOf(p41Saved({ id: 'b', plan_from_week: 45, plan_until_week: 104 }));
    const c = storedEntryOf(p41Saved({ id: 'c', plan_from_week: 40, plan_until_week: 80 }));
    expect(mixedPlanFrom([a, b])).toBe(true);
    expect(mixedPlanUntil([a, b])).toBe(false);
    expect(mixedPlanFrom([a, c])).toBe(false);
    expect(mixedPlanUntil([a, c])).toBe(true);
    // The served result's window wins over the stored meta.
    const served = { ...c, response: { ...c.response, plan_until_week: 104 } };
    expect(mixedPlanUntil([a, served])).toBe(false);
  });

  it('"Re-run on today\'s plan" sends plan_window_rerun: true with the stored window, then settles it', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const raised: ImportSimulateResponse = {
      ...P41_RESPONSE,
      plan_from_week: 42,
      plan_from_min_week: 42,
      plan_from_label: 'W42 2026 (12 Oct 2026)',
      plan_until_week: 104,
      plan_window_label: null,
      plan_week_choices: CHOICES,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const url = new URL(raw, 'http://localhost');
        calls.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : null });
        const res =
          url.pathname === '/whatif/import/simulate'
            ? raised
            : url.pathname === '/whatif/import/scenarios'
              ? { items: [], total: 0, limit: 200, offset: 0 }
              : { detail: 'not found' };
        return Promise.resolve(
          new Response(JSON.stringify(res), {
            status: url.pathname.startsWith('/whatif/import/s') ? 200 : 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );
    const saved = p41Saved({ plan_from_week: 40, plan_until_week: 104 });
    saved.request = { ...saved.request, plan_from_week: 40, plan_until_week: 104 };
    useImportPlan.setState({ step: 'results', savedBrowse: true });
    useImportPlan.getState().openView(savedViewOf(saved));
    const user = userEvent.setup();
    renderWithProviders(<ImportPlanView />);
    const banner = await screen.findByTestId('import-view-banner');
    expect(within(banner).getByTestId('import-view-window')).toHaveTextContent("Plan from W40 to W52 '27");

    await user.click(within(banner).getByRole('button', { name: "Re-run on today's plan" }));
    const simulates = () => calls.filter((c) => c.path === '/whatif/import/simulate');
    await waitFor(() => expect(simulates()).toHaveLength(1));
    const sent = simulates()[0]?.body as ImportSimulateRequest;
    expect(sent.plan_window_rerun).toBe(true);
    expect(sent.plan_from_week).toBe(40);
    expect(sent).not.toHaveProperty('plan_until_week'); // the preset: the plan year
    await waitFor(() => expect(useImportPlan.getState().options.planWindowRerun).toBe(false));
    expect(useImportPlan.getState().options.planFromWeek).toBeNull();
    // The settled options are the body just answered: no second simulate.
    await new Promise((r) => setTimeout(r, 500));
    expect(simulates()).toHaveLength(1);
  });
});

describe('P50 step timing dialog', () => {
  it('hint and error read week-of-year labels; the typed absolute week is what is saved', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ImportStepTimingDialog
        target={{
          ref: 'row-5',
          stepId: 'PDD-E',
          title: 'Synthetic step',
          editable: 'move_resize',
          hasPredecessors: false,
          current: { duration_weeks: null, start_not_before_week: null, overlap_weeks: null },
        }}
        baseYear={2026}
        currentWeek={42}
        horizonWeeks={130}
        onClose={() => {}}
        onSave={onSave}
      />,
    );
    const hint = screen.getByText("W42 '26 to W26 '28");
    expect(hint).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Earliest start (week no.)' });
    await user.type(input, '140');
    expect(screen.getByText("Between W42 '26 and W26 '28.")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '57');
    expect(screen.getByText("W5 '27")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply and recompute' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ start_not_before_week: 57 }));
  });
});
