import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { ApiError } from '@/lib/api/client';

const api = { askAgent: vi.fn() };
vi.mock('../api/workspace-api', () => ({
  askAgent: (...a: unknown[]) => api.askAgent(...a),
}));

import { AskAgentPanel } from './ask-agent-panel';

beforeEach(() => {
  vi.clearAllMocks();
});

async function ask(user: ReturnType<typeof userEvent.setup>, question = 'Which stages are behind?') {
  await user.type(screen.getByLabelText('Question for the agent'), question);
  await user.click(screen.getByRole('button', { name: 'Ask the agent' }));
}

describe('AskAgentPanel (ADR 0014)', () => {
  it('asks a question and renders the plain-text answer', async () => {
    const user = userEvent.setup();
    api.askAgent.mockResolvedValue({ answer: 'Stage PDD-C is two weeks behind its planned finish.' });
    renderWithProviders(<AskAgentPanel projectId="proj-1" />);

    await ask(user);

    expect(api.askAgent).toHaveBeenCalledWith('proj-1', 'Which stages are behind?');
    expect(await screen.findByTestId('ask-agent-answer')).toHaveTextContent(
      'Stage PDD-C is two weeks behind its planned finish.',
    );
  });

  it('shows an explicit, non-generic message for 503 AGENT_UNAVAILABLE', async () => {
    const user = userEvent.setup();
    api.askAgent.mockRejectedValue(new ApiError(503, 'service unavailable'));
    renderWithProviders(<AskAgentPanel projectId="proj-1" />);

    await ask(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Ask the agent isn't configured for this environment.",
    );
  });

  it('shows a Retry-After-aware message for 429, distinct from the comment rate-limit copy', async () => {
    const user = userEvent.setup();
    api.askAgent.mockRejectedValue(new ApiError(429, 'too many requests', undefined, undefined, 12));
    renderWithProviders(<AskAgentPanel projectId="proj-1" />);

    await ask(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many questions. Try again in 12 s.');
    expect(alert).not.toHaveTextContent(/commenting/);
  });

  it('shows an explicit access-denied message for a 403', async () => {
    const user = userEvent.setup();
    api.askAgent.mockRejectedValue(new ApiError(403, 'forbidden'));
    renderWithProviders(<AskAgentPanel projectId="proj-1" />);

    await ask(user);

    expect(await screen.findByRole('alert')).toHaveTextContent("You don't have access to ask about this project.");
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<AskAgentPanel projectId="proj-1" />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
