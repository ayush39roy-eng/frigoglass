import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

vi.mock('@/surfaces/project-workspace/api/workspace-api', () => ({
  askAgent: vi.fn(),
}));

import type { ProjectFilterRow } from '../api/types';
import { ProjectCardGrid } from './project-card-grid';

function row(id: string, overrides: Partial<ProjectFilterRow> = {}): ProjectFilterRow {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'A+',
    status: 'In Development',
    priority: 'P1',
    ...overrides,
  };
}

describe('ProjectCardGrid', () => {
  it('renders one feature card per row, linking into the Project Workspace', () => {
    renderWithProviders(
      <ProjectCardGrid
        rows={[row('a', { project_name: 'Alpha cooler refresh' }), row('b', { project_name: 'Beta chest freezer' })]}
      />,
    );

    expect(screen.getByRole('link', { name: /Alpha cooler refresh/ })).toHaveAttribute(
      'href',
      '/projects/a',
    );
    expect(screen.getByRole('link', { name: /Beta chest freezer/ })).toHaveAttribute(
      'href',
      '/projects/b',
    );
    expect(screen.getAllByRole('button', { name: 'Ask the agent' })).toHaveLength(2);
  });

  it("opens that card's Ask the agent dialog, scoped to its own project id", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectCardGrid rows={[row('a', { project_name: 'Alpha cooler refresh' })]} />);

    await user.click(screen.getByRole('button', { name: 'Ask the agent' }));

    expect(await screen.findByRole('dialog', { name: /Alpha cooler refresh/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Question for the agent')).toBeInTheDocument();
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(
      <ProjectCardGrid rows={[row('a'), row('b', { priority: null, category: null })]} />,
    );
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
