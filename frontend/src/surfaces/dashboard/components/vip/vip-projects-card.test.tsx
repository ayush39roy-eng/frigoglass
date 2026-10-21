import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import type { VipBoardArea, VipBoardResponse, VipItem, VipItemProject } from '@/lib/api/vip';
import { useHubFilterStore } from '@/stores/hub-filter';
import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';

const client = { apiGet: vi.fn(), apiSend: vi.fn() };
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (...a: unknown[]) => client.apiGet(...a),
    apiSend: (...a: unknown[]) => client.apiSend(...a),
  };
});

import { VipProjectsCard } from './vip-projects-card';

function project(id: string, overrides: Partial<VipItemProject> = {}): VipItemProject {
  return {
    id,
    name: `Project ${id}`,
    hub: 'OEM-Seltek',
    priority: 'P3',
    status: 'In Development',
    projected_end_week: 40,
    within_year: true,
    health: 'on_track',
    ...overrides,
  };
}

function item(id: string, overrides: Partial<VipItem> = {}): VipItem {
  return {
    id,
    pillar: 'INNOVATION',
    title: `Item ${id}`,
    status_tag: null,
    status_note: null,
    highlighted: false,
    sort_order: 1,
    children: [],
    projects: [],
    hidden_project_count: 0,
    ...overrides,
  };
}

const GREECE_ITEMS: VipItem[] = [
  item('fam', { title: 'Family Fridge for Commercial Appliances', highlighted: true, sort_order: 1, projects: [project('pf', { name: 'Family Fridge' })] }),
  item('monster', {
    title: 'Monster Range:',
    sort_order: 2,
    children: [item('twin', { title: 'Twin Reach R600a', sort_order: 1 }), item('slim', { title: 'Slim Counter Top R600a with GMC', sort_order: 2 })],
  }),
  item('beat', {
    pillar: 'MARKET_EXPANSION',
    title: 'Beat Box 3D Logo',
    highlighted: true,
    sort_order: 1,
    projects: [
      project('b1', { name: 'BEATBOX 3D LOGO FLEX60', priority: 'P2', projected_end_week: 30, health: 'at_risk' }),
      project('b2', { name: 'BEATBOX 3D LOGO PREMIUM SLIM 130', projected_end_week: 60, within_year: false }),
    ],
    hidden_project_count: 1,
  }),
  item('kz', { pillar: 'MARKET_EXPANSION', title: 'ERX 3.0 B rating development', sort_order: 2 }),
  item('ic2', {
    pillar: 'PERFORMANCE',
    title: 'IC2-40 Coke Certification',
    status_tag: 'HIGH_RISK',
    status_note: 'to meet Brau timelines',
    sort_order: 1,
  }),
];

function area(a: Partial<VipBoardArea> & Pick<VipBoardArea, 'area' | 'label'>): VipBoardArea {
  return {
    hubs: [],
    item_count: 0,
    highlighted_count: 0,
    high_risk_count: 0,
    linked_project_count: 0,
    vip_items: [],
    items: [],
    ...a,
  };
}

const BOARD: VipBoardResponse = {
  run_id: 'run-9',
  pillars: [
    { key: 'INNOVATION', number: '01', label: 'Innovation', headline: 'Refresh product aesthetics to strengthen differentiation', impact: ['Differentiation', 'Fresh Looks', 'value'] },
    { key: 'MARKET_EXPANSION', number: '02', label: 'Market Expansion', headline: 'Launch platforms and scale regional demand', impact: ['New Product', 'New customer', 'Plant Capacity'] },
    { key: 'PERFORMANCE', number: '03', label: 'Performance', headline: 'Deliver RM savings, compliance and continuity', impact: ['Savings', 'compliance', 'reliable delivery'] },
  ],
  areas: [
    area({
      area: 'Greece',
      label: 'Greece',
      hubs: ['R&D-Greece', 'OEM-HCK', 'OEM-Seltek'],
      item_count: 7,
      highlighted_count: 2,
      high_risk_count: 1,
      linked_project_count: 3,
      vip_items: [
        { id: 'fam', title: 'Family Fridge for Commercial Appliances' },
        { id: 'beat', title: 'Beat Box 3D Logo' },
      ],
      items: GREECE_ITEMS,
    }),
    area({ area: 'India', label: 'India', hubs: ['PD-India', 'R&D-India'], highlighted_count: 0 }),
    area({ area: 'Romania', label: 'Romania', hubs: ['PD-Romania'] }),
  ],
};

function renderCard(options?: Parameters<typeof renderWithProviders>[1]) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<VipProjectsCard />} />
      <Route path="/projects/:projectId" element={<p>Workspace page</p>} />
    </Routes>,
    options,
  );
}

function greeceTile(): HTMLElement {
  return screen.getAllByTestId('vip-area-tile').find((t) => t.getAttribute('data-area') === 'Greece')!;
}

async function openGreeceSlide(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await screen.findAllByTestId('vip-area-tile');
  await user.click(within(greeceTile()).getByRole('button', { name: 'View all VIP items for Greece' }));
  return screen.findByRole('dialog', { name: /VIP projects — Greece/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.setState({ hubId: null, region: null });
  client.apiGet.mockImplementation((path: string) => {
    if (path === '/vip-board') return Promise.resolve(BOARD);
    if (path === '/dashboard/projects') {
      return Promise.resolve({
        total_count: 1,
        rows: [{ project_id: 'p-new', project_name: 'Coffee and vending cooler combo', hub: 'R&D-Greece', region: 'Greece' }],
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  client.apiSend.mockResolvedValue({ id: 'new-item' });
});

describe('Dashboard VIP projects card (ADR 0027, OQ #39)', () => {
  it('renders one tile per served area — Greece, India, Romania — with hubs, served counts and VIP item names', async () => {
    renderCard();
    const tiles = await screen.findAllByTestId('vip-area-tile');
    expect(tiles.map((t) => t.getAttribute('data-area'))).toEqual(['Greece', 'India', 'Romania']);
    const g = greeceTile();
    expect(within(g).getByRole('heading', { name: 'Greece' })).toBeInTheDocument();
    expect(g).toHaveTextContent('R&D-Greece · OEM-HCK · OEM-Seltek');
    expect(within(g).getByTestId('vip-count-highlighted')).toHaveTextContent('2');
    expect(within(g).getByTestId('vip-count-high-risk')).toHaveTextContent('1');
    expect(within(g).getByTestId('vip-count-linked')).toHaveTextContent('3');
    const names = within(g).getAllByTestId('vip-tile-item').map((li) => li.querySelector('a,button,span:not([data-testid])')?.textContent);
    // P17-R08: the slim column shows the first VIP item; the rest sit behind "+N more" (the slide).
    expect(names).toEqual(['Family Fridge for Commercial Appliances']);
    expect(within(g).getByRole('button', { name: 'Show all 2 VIP items for Greece' })).toHaveTextContent('+1 more');
    expect(client.apiGet).toHaveBeenCalledWith('/vip-board', expect.objectContaining({ query: { hub_id: undefined, region: undefined } }));
  });

  it('sends the global hub / country filter', async () => {
    useHubFilterStore.setState({ hubId: null, region: 'India' });
    renderCard();
    await screen.findAllByTestId('vip-area-tile');
    expect(client.apiGet).toHaveBeenCalledWith('/vip-board', expect.objectContaining({ query: { hub_id: undefined, region: 'India' } }));
  });

  it('a VIP item with one project navigates straight to its Workspace', async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findAllByTestId('vip-area-tile');
    const link = within(greeceTile()).getByRole('link', { name: 'Family Fridge for Commercial Appliances' });
    expect(link).toHaveAttribute('href', '/projects/pf');
    await user.click(link);
    expect(await screen.findByText('Workspace page')).toBeInTheDocument();
  });

  it('a VIP item with several projects opens a picker (name, hub, priority, finish, health), then navigates', async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findAllByTestId('vip-area-tile');
    // P17-R08: the second VIP item is reached through "+1 more" (the slide), where the same picker lives.
    await user.click(within(greeceTile()).getByRole('button', { name: 'Show all 2 VIP items for Greece' }));
    const slide = await screen.findByRole('dialog', { name: /VIP projects — Greece/ });
    await user.click(within(slide).getByRole('button', { name: 'Beat Box 3D Logo: choose one of 2 projects' }));
    const picker = await screen.findByTestId('vip-item-picker');
    expect(picker).toHaveAccessibleName(/^Open a project/); // QA-P14-2
    const options = within(picker).getAllByTestId('vip-picker-project');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('BEATBOX 3D LOGO FLEX60');
    expect(options[0]).toHaveTextContent('OEM-Seltek');
    expect(options[0]).toHaveTextContent('P2');
    expect(options[0]).toHaveTextContent('W30');
    expect(within(options[0]!).getByTestId('finish-chip')).toHaveAttribute('data-within-year', 'true');
    expect(within(options[1]!).getByTestId('finish-chip')).toHaveAttribute('data-within-year', 'false');
    expect(picker).toHaveTextContent('+1 linked in hubs outside your scope');
    await user.click(options[1]!);
    expect(await screen.findByText('Workspace page')).toBeInTheDocument();
  });

  it('"View all" opens the slide: three pillar columns with impact footers, VIP emphasis, chips, indented sub-items', async () => {
    const user = userEvent.setup();
    renderCard();
    const dialog = await openGreeceSlide(user);
    const pillars = within(dialog).getAllByTestId('vip-pillar');
    expect(pillars.map((p) => p.getAttribute('data-pillar'))).toEqual(['INNOVATION', 'MARKET_EXPANSION', 'PERFORMANCE']);
    expect(pillars[0]).toHaveTextContent('01');
    expect(pillars[0]).toHaveTextContent('Refresh product aesthetics to strengthen differentiation');
    expect(within(pillars[0]!).getByTestId('vip-impact')).toHaveTextContent('Impact');
    expect(within(pillars[0]!).getByTestId('vip-impact')).toHaveTextContent('Differentiation • Fresh Looks • value');
    expect(pillars[0]!.className).toMatch(/border-vip-innovation/);
    expect(pillars[1]!.className).toMatch(/border-vip-market/);
    expect(pillars[2]!.className).toMatch(/border-vip-performance/);

    const items = within(dialog).getAllByTestId('vip-item');
    const fam = items.find((li) => li.textContent?.includes('Family Fridge'))!;
    expect(fam).toHaveAttribute('data-highlighted', 'true');
    expect(within(fam).getByTestId('vip-marker')).toHaveTextContent('VIP');
    expect(fam.firstElementChild!.className).toMatch(/bg-vip-innovation-subtle/);

    const twin = items.find((li) => li.textContent === 'Twin Reach R600a' || li.textContent?.startsWith('–Twin'))!;
    expect(twin).toHaveAttribute('data-depth', '1');
    expect(twin.className).toMatch(/ml-5/);
    // No linked project: plain text, not a link or a button.
    expect(within(twin).queryByRole('link')).not.toBeInTheDocument();
    expect(within(twin).queryByRole('button')).not.toBeInTheDocument();

    const tag = within(pillars[2]!).getByTestId('vip-status-tag');
    expect(tag).toHaveAttribute('data-tag', 'HIGH_RISK');
    expect(tag).toHaveTextContent('High risk');
    expect(tag.className).toMatch(/text-danger-subtle-fg/);
    expect(pillars[2]).toHaveTextContent('(to meet Brau timelines)');
  });

  it('the slide has no serious/critical axe violations', async () => {
    const user = userEvent.setup();
    renderCard();
    const dialog = await openGreeceSlide(user);
    expect(await seriousAxeViolations(dialog)).toEqual([]);
  });
});

describe('VIP edit mode (MATRIX WRITE only)', () => {
  it('is not offered without matrix write (Executive Viewer, Hub Planner)', async () => {
    const user = userEvent.setup();
    renderCard({ session: { permissions: ROLE_MATRIX['Executive Viewer'] } });
    const dialog = await openGreeceSlide(user);
    expect(within(dialog).queryByTestId('vip-edit-toggle')).not.toBeInTheDocument();
  });

  it('Hub Planner (matrix read only) gets no Edit either', async () => {
    const user = userEvent.setup();
    renderCard({ session: { permissions: ROLE_MATRIX['Hub Planner'] } });
    const dialog = await openGreeceSlide(user);
    expect(within(dialog).queryByTestId('vip-edit-toggle')).not.toBeInTheDocument();
  });

  it('Portfolio Manager: toggle VIP, reorder, delete with confirm', async () => {
    const user = userEvent.setup();
    renderCard({ session: { permissions: ROLE_MATRIX['Portfolio Manager'] } });
    const dialog = await openGreeceSlide(user);
    await user.click(within(dialog).getByTestId('vip-edit-toggle'));

    const famControls = within(dialog).getByRole('group', { name: 'Edit Family Fridge for Commercial Appliances' });
    await user.click(within(famControls).getByRole('button', { name: 'VIP' }));
    await waitFor(() => expect(client.apiSend).toHaveBeenCalledWith('PATCH', '/vip-items/fam', { highlighted: false }));

    client.apiSend.mockClear();
    await user.click(within(famControls).getByRole('button', { name: 'Move Family Fridge for Commercial Appliances down' }));
    await waitFor(() => expect(client.apiSend).toHaveBeenCalledTimes(2));
    expect(client.apiSend).toHaveBeenNthCalledWith(1, 'PATCH', '/vip-items/fam', { sort_order: 2 });
    expect(client.apiSend).toHaveBeenNthCalledWith(2, 'PATCH', '/vip-items/monster', { sort_order: 1 });
    expect(within(famControls).getByRole('button', { name: 'Move Family Fridge for Commercial Appliances up' })).toBeDisabled();

    client.apiSend.mockClear();
    await user.click(within(famControls).getByRole('button', { name: 'Delete Family Fridge for Commercial Appliances' }));
    expect(client.apiSend).not.toHaveBeenCalled();
    await user.click(within(famControls).getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(client.apiSend.mock.calls.map((c) => c.slice(0, 2))).toContainEqual(['DELETE', '/vip-items/fam']));
  });

  it('Portfolio Manager: add an item with tag, note, VIP and a project linked through the search', async () => {
    const user = userEvent.setup();
    renderCard({ session: { permissions: ROLE_MATRIX['Portfolio Manager'] } });
    const dialog = await openGreeceSlide(user);
    await user.click(within(dialog).getByTestId('vip-edit-toggle'));
    await user.click(within(dialog).getByRole('button', { name: 'Add item to Performance' }));

    const editor = await screen.findByRole('dialog', { name: 'Add VIP item' });
    await user.type(within(editor).getByLabelText('Title'), 'Coffee Combo');
    await user.selectOptions(within(editor).getByLabelText('Status tag'), 'HIGH_RISK');
    await user.type(within(editor).getByLabelText('Status note'), 'to meet Brau timelines');
    await user.click(within(editor).getByLabelText('VIP (highlighted on the slide)'));
    await user.type(within(editor).getByRole('searchbox', { name: 'Search projects in Greece to link' }), 'coffee');
    await user.click(await within(editor).findByRole('button', { name: 'Link Coffee and vending cooler combo (R&D-Greece)' }));
    expect(client.apiGet).toHaveBeenCalledWith('/dashboard/projects', expect.objectContaining({ query: expect.objectContaining({ q: 'coffee', region: 'Greece' }) }));
    expect(within(editor).getByRole('list', { name: 'Linked projects' })).toHaveTextContent('Coffee and vending cooler combo');

    await user.click(within(editor).getByRole('button', { name: 'Save item' }));
    await waitFor(() =>
      expect(client.apiSend).toHaveBeenCalledWith('POST', '/vip-items', {
        area: 'Greece',
        pillar: 'PERFORMANCE',
        parent_id: null,
        sort_order: 2,
        title: 'Coffee Combo',
        status_tag: 'HIGH_RISK',
        status_note: 'to meet Brau timelines',
        highlighted: true,
      }),
    );
    await waitFor(() => expect(client.apiSend).toHaveBeenCalledWith('PUT', '/vip-items/new-item/projects', { project_ids: ['p-new'] }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add VIP item' })).not.toBeInTheDocument());
  });
});
