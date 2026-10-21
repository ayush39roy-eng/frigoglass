import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { askFixture, solveFixture } from '../test-fixtures';

const postAsk = vi.fn();
vi.mock('../../api/whatif-api', () => ({
  postAsk: async (body: unknown) => postAsk(body) as unknown,
  postEstimate: vi.fn(),
  postSimulate: vi.fn(),
  postSolve: vi.fn(),
}));

import { ChatPanel } from './chat-panel';
import { EXAMPLE_PROMPTS } from './chat-prompts';

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText('Your question'), text);
  await user.click(screen.getByRole('button', { name: 'Ask' }));
}

describe('ChatPanel', () => {
  beforeEach(() => {
    postAsk.mockReset();
  });

  it('starts with an empty state and the two example prompts, which only fill the box', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    expect(screen.getByText('No questions yet')).toBeInTheDocument();
    for (const p of EXAMPLE_PROMPTS) expect(screen.getByRole('button', { name: p })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: EXAMPLE_PROMPTS[1] }));
    expect(screen.getByLabelText('Your question')).toHaveValue(EXAMPLE_PROMPTS[1]);
    expect(postAsk).not.toHaveBeenCalled();
  });

  it('shows the answer, the scenario it built, the engine results, and loads the scenario into the builder', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    postAsk.mockResolvedValue(askFixture());
    const { container } = renderWithProviders(<ChatPanel onEditInBuilder={onEdit} />);
    await ask(user, EXAMPLE_PROMPTS[0]);

    expect(postAsk).toHaveBeenCalledWith({ question: EXAMPLE_PROMPTS[0] });
    expect(await screen.findByTestId('chat-answer-text')).toHaveTextContent('You need 3 more designers and 1 more chamber.');
    const scenario = screen.getByTestId('chat-scenario');
    expect(scenario).toHaveTextContent('Add projects: 5 x category A in PD-India, In Queue');
    const result = screen.getByTestId('chat-tool-result');
    expect(result).toHaveTextContent('Engine result: Estimate');
    expect(within(result).getByTestId('est-designers')).toHaveTextContent('3 more');
    expect(screen.queryByTestId('chat-ungrounded')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-truncated')).not.toBeInTheDocument();

    await user.click(within(scenario).getByRole('button', { name: 'Edit in builder' }));
    expect(onEdit).toHaveBeenCalledWith(askFixture().scenario);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('sends the previous scenario with a follow-up so it can be refined', async () => {
    const user = userEvent.setup();
    postAsk.mockResolvedValue(askFixture());
    renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    await ask(user, 'first');
    await screen.findByTestId('chat-answer');
    await ask(user, 'and with two more chambers');
    await waitFor(() => expect(postAsk).toHaveBeenCalledTimes(2));
    expect(postAsk.mock.calls[1]?.[0]).toEqual({
      question: 'and with two more chambers',
      prior_scenario: askFixture().scenario,
    });
  });

  it('renders model text as plain text, never as HTML', async () => {
    const user = userEvent.setup();
    postAsk.mockResolvedValue(
      askFixture({ answer: '<img src=x onerror="alert(1)"><script>alert(2)</script> **bold**', scenario: null, results: [] }),
    );
    const { container } = renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    await ask(user, 'hello');
    const text = await screen.findByTestId('chat-answer-text');
    expect(text.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
  });

  it('shows an ungrounded notice and a truncated notice plainly', async () => {
    const user = userEvent.setup();
    postAsk.mockResolvedValue(askFixture({ grounded: false, ungrounded_numbers: ['42'], truncated: true }));
    renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    await ask(user, 'hello');
    expect(await screen.findByTestId('chat-ungrounded')).toHaveTextContent('Not verified');
    expect(screen.getByTestId('chat-ungrounded')).toHaveTextContent('42');
    expect(screen.getByTestId('chat-truncated')).toHaveTextContent('step limit');
    // The engine figures are still there.
    expect(screen.getByTestId('est-designers')).toBeInTheDocument();
  });

  it('shows a refusal, a tool error note, and a solve result inside the chat', async () => {
    const user = userEvent.setup();
    postAsk.mockResolvedValue(
      askFixture({
        refused: true,
        results: [
          { tool: 'find_minimum_additions', scenario: null, error: null, result: solveFixture() },
          { tool: 'simulate_scenario', scenario: null, error: 'unknown chamber id', result: null },
        ],
      }),
    );
    renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    await ask(user, 'hello');
    expect(await screen.findByTestId('chat-refused')).toBeInTheDocument();
    expect(screen.getByTestId('whatif-solve')).toBeInTheDocument();
    expect(screen.getByTestId('chat-tool-error')).toHaveTextContent('Could not run: unknown chamber id');
  });

  it('503 AGENT_UNAVAILABLE hides the chat input and says to use the forms', async () => {
    const user = userEvent.setup();
    postAsk.mockImplementation(() => {
      throw new ApiError(503, 'Request failed (503)');
    });
    renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    await ask(user, 'hello');
    expect(await screen.findByTestId('chat-unavailable')).toHaveTextContent('Chat is not configured; use the forms.');
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-turn')).not.toBeInTheDocument();
  });

  it('502 offers a retry that sends the same question again', async () => {
    const user = userEvent.setup();
    postAsk.mockRejectedValueOnce(new ApiError(502, 'Request failed (502)')).mockResolvedValueOnce(askFixture());
    renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    await ask(user, 'will fail once');
    const notice = await screen.findByTestId('whatif-error');
    expect(notice).toHaveAttribute('data-error-kind', 'upstream');
    await user.click(within(notice).getByRole('button', { name: 'Retry this question' }));
    expect(await screen.findByTestId('chat-answer')).toBeInTheDocument();
    expect(postAsk).toHaveBeenCalledTimes(2);
    expect(postAsk.mock.calls[1]?.[0]).toEqual(postAsk.mock.calls[0]?.[0]);
    expect(screen.getAllByTestId('chat-turn')).toHaveLength(1);
  });

  it('504 offers a retry as well', async () => {
    const user = userEvent.setup();
    postAsk.mockImplementation(() => {
      throw new ApiError(504, 'Request failed (504)', undefined, 'AGENT_TIMEOUT');
    });
    renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    await ask(user, 'slow');
    const notice = await screen.findByTestId('whatif-error');
    expect(notice).toHaveAttribute('data-error-kind', 'agent_timeout');
    expect(within(notice).getByRole('button', { name: 'Retry this question' })).toBeEnabled();
  });
});

describe('ChatPanel rate limit', () => {
  beforeEach(() => {
    postAsk.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it('429 counts down the Retry-After seconds and enables retry at zero', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    postAsk.mockImplementation(() => {
      throw new ApiError(429, 'Request failed (429)', undefined, undefined, 3);
    });
    renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    await ask(user, 'too fast');

    const notice = await screen.findByTestId('whatif-error');
    expect(notice).toHaveAttribute('data-error-kind', 'rate_limited');
    expect(notice).toHaveTextContent('You can try again in 3 s');
    const retry = within(notice).getByRole('button', { name: 'Retry this question' });
    expect(retry).toBeDisabled();
    expect(screen.getByTestId('whatif-countdown')).toHaveTextContent('3 s');

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('whatif-countdown')).toHaveTextContent('2 s');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByTestId('whatif-countdown')).not.toBeInTheDocument();
    expect(retry).toBeEnabled();
  });
});

describe('ChatPanel egress hint and tool errors', () => {
  it('shows the fixed "do not type names" hint under the input, linked to it', () => {
    renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    const hint = screen.getByTestId('chat-egress-hint');
    expect(hint).toHaveTextContent(
      'Do not type names, customers or prices — questions are sent to the AI provider (see settings)',
    );
    expect(screen.getByLabelText('Your question')).toHaveAttribute('aria-describedby', expect.stringContaining('whatif-chat-egress'));
  });

  it('renders a chat tool-error 429 text as the small "could not run" note', async () => {
    const user = userEvent.setup();
    const busy =
      'A what-if calculation of yours is still running. Please wait for it to finish before starting another.';
    postAsk.mockResolvedValue({
      answer: 'I could not run that just now.',
      refused: false,
      grounded: true,
      ungrounded_numbers: [],
      scenario: null,
      results: [{ tool: 'simulate_scenario', scenario: null, error: busy, result: null }],
      workings: [],
      rounds_used: 1,
      truncated: false,
    });
    renderWithProviders(<ChatPanel onEditInBuilder={vi.fn()} />);
    await ask(user, 'simulate');
    expect(await screen.findByTestId('chat-tool-error')).toHaveTextContent(`Could not run: ${busy}`);
  });
});
