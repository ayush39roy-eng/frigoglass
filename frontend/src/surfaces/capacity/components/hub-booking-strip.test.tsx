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
    renderWithProviders(<HubBookingStrip rows={all} horizon="year" />);
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

  it('follows the horizon', () => {
    renderWithProviders(<HubBookingStrip rows={[hubRow({ hub: 'PD-India' })]} horizon="remaining" />);
    expect(screen.getByTestId('booked-design-PD-India')).toHaveTextContent('326.56%');
    expect(screen.getByTestId('booked-lab-PD-India')).toHaveTextContent('374.72%');
    expect(screen.getByTestId('booked-strip-horizon')).toHaveTextContent(/Remaining year/);
  });

  it('a hub-scoped user sees only the served hubs, flagged', () => {
    renderWithProviders(<HubBookingStrip rows={[hubRow({ hub: 'PD-India' })]} horizon="year" />, {
      session: { hub_scope_all: false },
    });
    expect(screen.getByTestId('booked-hub-PD-India')).toBeInTheDocument();
    expect(screen.queryByTestId('booked-hub-R&D-Greece')).not.toBeInTheDocument();
    expect(screen.getByText('Your hubs only')).toBeInTheDocument();
  });

  it('renders nothing without rows', () => {
    renderWithProviders(<HubBookingStrip rows={[]} horizon="year" />);
    expect(screen.queryByTestId('hub-booking-strip')).not.toBeInTheDocument();
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<HubBookingStrip rows={all} horizon="year" />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
