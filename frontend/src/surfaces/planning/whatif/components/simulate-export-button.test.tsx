import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { ChamberRead } from '../../api/types';
import type { ScenarioRequest } from '../../api/whatif-types';
import { simulateFixture } from '../test-fixtures';
import { useWhatIfScenario } from '../scenario-store';

/**
 * P43-T03 (ADR 0057 D3, API_CONTRACT_P43 §3/§6): "Export to Excel" on the What-if
 * Simulate result. The JSON fetchers are mocked; the export goes through the real
 * `apiDownload` against a stubbed `fetch`, so the request body, method, path and the
 * `Content-Disposition` filename are all exercised.
 */

vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
import { saveBlob } from '@/lib/download';

const api = {
  postEstimate: vi.fn(),
  postSimulate: vi.fn(),
  postSolve: vi.fn(),
  postAsk: vi.fn(),
};
vi.mock('../../api/whatif-api', () => ({
  postEstimate: async (b: unknown) => api.postEstimate(b) as unknown,
  postSimulate: async (b: unknown) => api.postSimulate(b) as unknown,
  postSolve: async (b: unknown) => api.postSolve(b) as unknown,
  postAsk: async (b: unknown) => api.postAsk(b) as unknown,
}));

import { SimulateExportButton } from './simulate-export-button';
import { WhatIfPlanner } from './whatif-planner';

const CHAMBERS = [
  { id: 'ch-1', code: 'IN-1', lab_region: 'India' },
  { id: 'ch-2', code: 'RO-1', lab_region: 'Romania' },
] as unknown as ChamberRead[];

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function xlsxResponse(filename = 'whatif-scenario.xlsx'): Response {
  return new Response('PK-bytes', {
    status: 200,
    headers: { 'content-type': XLSX, 'content-disposition': `attachment; filename="${filename}"` },
  });
}

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type FetchInput = string | URL | Request;
const fetchMock = vi.fn<(input: FetchInput, init?: RequestInit) => Promise<Response>>();

/** The export request (the planner page may also fire unrelated reads through `fetch`). */
function lastCall(): { url: URL; init: RequestInit } {
  const call = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/whatif/export.xlsx')).at(-1);
  if (!call) throw new Error('the export was not requested');
  return { url: new URL(String(call[0])), init: call[1] ?? {} };
}

const SCENARIO: ScenarioRequest = {
  add_projects: [
    {
      hub: 'PD-India',
      category: 'A',
      count: 2,
      project_type: null,
      status: 'In Queue',
      priority: null,
      score: null,
      workflow_id: null,
      certification_testing_required: true,
    },
  ],
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  useWhatIfScenario.getState().reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function addProjectAndSimulate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Add project line' }));
  const g = screen.getByRole('group', { name: /Added projects, line 1/ });
  await user.clear(within(g).getByLabelText('Count'));
  await user.type(within(g).getByLabelText('Count'), '5');
  await user.click(screen.getByRole('button', { name: 'Simulate' }));
  await screen.findByTestId('whatif-simulate');
}

describe('What-if planner: Export to Excel', () => {
  it('is disabled, with a reason, until Simulate has a computed result', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await user.click(screen.getByRole('tab', { name: 'Simulate' }));
    const btn = screen.getByRole('button', { name: 'Export to Excel' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription('Run Simulate first, then export its result.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the simulated scenario to /whatif/export.xlsx and saves under the Content-Disposition name', async () => {
    const user = userEvent.setup();
    api.postSimulate.mockResolvedValue(simulateFixture());
    // A fresh Response per call: only the export answers with a workbook.
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        String(input).includes('/whatif/export.xlsx')
          ? xlsxResponse('whatif-scenario.xlsx')
          : errorResponse(404, { detail: 'not in this test' }),
      ),
    );
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await addProjectAndSimulate(user);

    const btn = screen.getByRole('button', { name: 'Export to Excel' });
    expect(btn).toBeEnabled();
    await user.click(btn);

    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    const { url, init } = lastCall();
    expect(url.pathname).toBe('/whatif/export.xlsx');
    expect(init.method).toBe('POST');
    const simulated = (api.postSimulate.mock.calls[0]?.[0] as { scenario: ScenarioRequest }).scenario;
    // Exactly the strict body: the scenario that produced the result, no name, no result.
    expect(JSON.parse(String(init.body))).toEqual({ scenario: simulated });
    const [blob, filename] = vi.mocked(saveBlob).mock.calls[0] ?? [];
    expect(filename).toBe('whatif-scenario.xlsx');
    expect(await (blob as Blob).text()).toBe('PK-bytes');
  });

  it('shows a pending state while the workbook is built', async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    );
    render(<SimulateExportButton scenario={SCENARIO} />);
    await user.click(screen.getByRole('button', { name: 'Export to Excel' }));
    const pending = await screen.findByRole('button', { name: 'Exporting…' });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute('aria-busy', 'true');
    release(xlsxResponse());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export to Excel' })).toBeEnabled());
    expect(saveBlob).toHaveBeenCalledTimes(1);
  });

  it('sends a trimmed name when the view has one, and falls back to the server default filename', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(new Response('PK', { status: 200, headers: { 'content-type': XLSX } }));
    render(<SimulateExportButton scenario={SCENARIO} name={`  ${'x'.repeat(130)}  `} />);
    await user.click(screen.getByRole('button', { name: 'Export to Excel' }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ scenario: SCENARIO, name: 'x'.repeat(120) });
    expect(vi.mocked(saveBlob).mock.calls[0]?.[1]).toBe('whatif-scenario.xlsx');
  });

  it('omits a blank name', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(xlsxResponse());
    render(<SimulateExportButton scenario={SCENARIO} name="   " />);
    await user.click(screen.getByRole('button', { name: 'Export to Excel' }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ scenario: SCENARIO });
  });

  it.each([
    [403, { detail: 'forbidden' }, {}, 'forbidden', 'Your role cannot use the What-if planner.'],
    [403, { detail: 'x', code: 'SCENARIO_OUT_OF_SCOPE' }, {}, 'out_of_scope', 'outside the hubs you plan for'],
    [
      422,
      {
        detail: [{ loc: ['body', 'scenario'], type: 'scenario_limit', msg: 'at most 200 projects can be added in one scenario (got 201)' }],
        code: 'INVALID_SCENARIO',
      },
      {},
      'invalid',
      'at most 200 projects can be added in one scenario (got 201).',
    ],
    [503, { detail: 'x', code: 'WHATIF_TIMEOUT' }, {}, 'timeout', 'This took too long; try a smaller scenario.'],
  ] as const)('maps %i like simulate (%s)', async (status, body, headers, kind, text) => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(errorResponse(status, body, headers));
    render(<SimulateExportButton scenario={SCENARIO} />);
    await user.click(screen.getByRole('button', { name: 'Export to Excel' }));
    const notice = await screen.findByTestId('whatif-error');
    expect(notice).toHaveAttribute('data-error-kind', kind);
    expect(notice).toHaveTextContent(text);
    expect(saveBlob).not.toHaveBeenCalled();
    // The button itself is usable again.
    expect(screen.getByRole('button', { name: 'Export to Excel' })).toBeEnabled();
  });

  it('429: shows the Retry-After countdown, keeps the retry disabled, then exports on retry', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(errorResponse(429, { detail: 'Too many requests' }, { 'Retry-After': '1' }));
    render(<SimulateExportButton scenario={SCENARIO} />);
    await user.click(screen.getByRole('button', { name: 'Export to Excel' }));
    const notice = await screen.findByTestId('whatif-error');
    expect(notice).toHaveAttribute('data-error-kind', 'rate_limited');
    expect(notice).toHaveTextContent('You can try again in 1 s.');
    expect(screen.getByTestId('whatif-countdown')).toHaveTextContent('1 s');
    const retry = within(notice).getByRole('button', { name: 'Export again' });
    expect(retry).toBeDisabled();

    fetchMock.mockResolvedValueOnce(xlsxResponse('Plan B.xlsx'));
    await waitFor(() => expect(within(notice).getByRole('button', { name: 'Export again' })).toBeEnabled(), {
      timeout: 2500,
    });
    await user.click(within(notice).getByRole('button', { name: 'Export again' }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveBlob).mock.calls[0]?.[1]).toBe('Plan B.xlsx');
    expect(screen.queryByTestId('whatif-error')).not.toBeInTheDocument();
  });

  it('has no serious axe violations, idle, ready and failed', async () => {
    const user = userEvent.setup();
    const idle = render(<SimulateExportButton scenario={null} />);
    expect(await seriousAxeViolations(idle.container)).toEqual([]);
    idle.unmount();

    fetchMock.mockResolvedValue(errorResponse(503, { detail: 'x', code: 'WHATIF_TIMEOUT' }));
    const ready = render(<SimulateExportButton scenario={SCENARIO} />);
    expect(await seriousAxeViolations(ready.container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Export to Excel' }));
    await screen.findByTestId('whatif-error');
    expect(await seriousAxeViolations(ready.container)).toEqual([]);
  });
});
