import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { hubRow } from '../test-fixtures';
import { HubBookingStrip } from './hub-booking-strip';

const greeceLab = { lab_region: 'Greece' as const, lab_booked_pct_year: 100.5, lab_booking_status_year: 'full' as const };
const all = [
  hubRow({ hub: 'R&D-Greece', ...greeceLab, design_booked_pct_year: 100.9 }),
  hubRow({ hub: 'R&D-India', design_booked_pct_year: 60.01, design_booking_status_year: 'available' }),
  hubRow({ hub: 'PD-India' }),
  hubRow({ hub: 'PD-Romania', lab_region: 'Romania', lab_booked_pct_year: 51, lab_booking_status_year: 'available' }),
  hubRow({ hub: 'OEM-HCK', ...greeceLab, design_booked_pct_year: 12.5, design_booking_status_year: 'available' }),
  hubRow({ hub: 'OEM-Seltek', ...greeceLab, design_booked_pct_year: 99, design_booking_status_year: 'near_full' }),
];

describe('HubBookingStrip (P19-T02: hubs only, no Europe / India areas)', () => {
  it('shows one tile per hub with its design booked % and its lab region booked %, labelled by region', () => {
    renderWithProviders(<HubBookingStrip rows={all} view={{ horizon: 'year', unit: 'weeks' }} />);
    expect(screen.getAllByTestId(/^booked-hub-/)).toHaveLength(6);
    expect(screen.getByTestId('booked-design-OEM-HCK')).toHaveTextContent('12.5%');
    expect(within(screen.getByTestId('booked-design-OEM-HCK')).getByText('Available')).toBeInTheDocument();
    expect(within(screen.getByTestId('booked-design-OEM-Seltek')).getByText('Near full')).toBeInTheDocument();
    const hckLab = screen.getByTestId('booked-lab-OEM-HCK');
    expect(hckLab).toHaveTextContent('Lab (Greece region)');
    expect(hckLab).toHaveTextContent('100.5%');
    expect(screen.getByTestId('booked-lab-PD-Romania')).toHaveTextContent('Lab (Romania region)');
    expect(screen.getByTestId('booked-lab-PD-Romania')).toHaveTextContent('51%');
    expect(screen.getByTestId('booked-lab-PD-India')).toHaveTextContent('Lab (India region)');
    // no area concept, no separate lab-region tiles
    expect(screen.queryByText(/Europe/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('capacity-area-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('booked-lab-Greece')).not.toBeInTheDocument();
  });

  it('P19-T06: groups the tiles into one labelled box per hub family (R&D, PD, OEM), with no served family total', () => {
    // served order deliberately mixed: the boxes follow the family order, tiles the served order
    const mixed = [all[4], all[2], all[0], all[5], all[3], all[1]].filter((r) => r !== undefined);
    renderWithProviders(<HubBookingStrip rows={mixed} view={{ horizon: 'year', unit: 'weeks' }} />);
    const boxes = within(screen.getByTestId('booked-families')).getAllByRole('region');
    expect(boxes.map((b) => b.getAttribute('data-testid'))).toEqual(['booked-family-rd', 'booked-family-pd', 'booked-family-oem']);
    expect(screen.getByRole('region', { name: 'R&D' })).toBe(boxes[0]);
    expect(screen.getByRole('region', { name: 'PD (Product Development)' })).toBe(boxes[1]);
    expect(screen.getByRole('region', { name: 'OEM' })).toBe(boxes[2]);
    const hubsIn = (key: string): (string | null)[] =>
      within(screen.getByTestId(`booked-family-${key}`))
        .getAllByTestId(/^booked-hub-/)
        .map((t) => t.getAttribute('data-testid'));
    expect(hubsIn('rd')).toEqual(['booked-hub-R&D-Greece', 'booked-hub-R&D-India']);
    expect(hubsIn('pd')).toEqual(['booked-hub-PD-India', 'booked-hub-PD-Romania']);
    expect(hubsIn('oem')).toEqual(['booked-hub-OEM-HCK', 'booked-hub-OEM-Seltek']);
    // each family header is the name only: nothing summed in the browser
    expect(within(boxes[2] as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent(/^OEM$/);
    // tile content kept
    expect(within(screen.getByTestId('booked-family-oem')).getByTestId('booked-lab-OEM-HCK')).toHaveTextContent('100.5%');
    // wide 3 / medium 2 / narrow 1 boxes per row
    expect(screen.getByTestId('booked-families')).toHaveClass('md:grid-cols-2', 'xl:grid-cols-3');
  });

  it('P19-T06: a Hub Planner sees only their own family box and hub tiles, with no empty boxes', () => {
    renderWithProviders(
      <HubBookingStrip rows={[hubRow({ hub: 'OEM-HCK', ...greeceLab }), hubRow({ hub: 'OEM-Seltek', ...greeceLab })]} view={{ horizon: 'year', unit: 'weeks' }} />,
      { session: { hub_scope_all: false } },
    );
    expect(within(screen.getByTestId('booked-families')).getAllByRole('region')).toHaveLength(1);
    expect(screen.getByTestId('booked-family-oem')).toBeInTheDocument();
    expect(screen.queryByTestId('booked-family-rd')).not.toBeInTheDocument();
    expect(screen.queryByTestId('booked-family-pd')).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^booked-hub-/)).toHaveLength(2);
    expect(screen.getByText('Your hubs only')).toBeInTheDocument();
  });

  it('follows the horizon', () => {
    renderWithProviders(<HubBookingStrip rows={[hubRow({ hub: 'PD-India' })]} view={{ horizon: 'remaining', unit: 'weeks' }} />);
    expect(screen.getByTestId('booked-design-PD-India')).toHaveTextContent('326.56%');
    expect(screen.getByTestId('booked-lab-PD-India')).toHaveTextContent('374.72%');
    expect(screen.getByTestId('booked-strip-horizon')).toHaveTextContent(/Remaining year/);
  });

  it('a hub-scoped user sees only the served hubs, flagged', () => {
    renderWithProviders(<HubBookingStrip rows={[hubRow({ hub: 'PD-India' })]} view={{ horizon: 'year', unit: 'weeks' }} />, {
      session: { hub_scope_all: false },
    });
    expect(screen.getByTestId('booked-hub-PD-India')).toBeInTheDocument();
    expect(screen.queryByTestId('booked-hub-R&D-Greece')).not.toBeInTheDocument();
    expect(screen.getByTestId('booked-family-pd')).toBeInTheDocument();
    expect(screen.queryByTestId('booked-family-rd')).not.toBeInTheDocument();
    expect(screen.getByText('Your hubs only')).toBeInTheDocument();
  });

  it('renders nothing without rows', () => {
    renderWithProviders(<HubBookingStrip rows={[]} view={{ horizon: 'year', unit: 'weeks' }} />);
    expect(screen.queryByTestId('hub-booking-strip')).not.toBeInTheDocument();
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<HubBookingStrip rows={all} view={{ horizon: 'year', unit: 'weeks' }} />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
