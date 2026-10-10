import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { areaRow } from '../test-fixtures';
import { AreaBookingStrip } from './area-booking-strip';

const europe = areaRow();
const india = areaRow({
  area: 'India',
  hubs: ['R&D-India', 'PD-India', 'OEM-HCK', 'OEM-Seltek'],
  lab_regions: ['India'],
  design_booked_pct_year: 90,
  design_booking_status_year: 'near_full',
  lab_booked_pct_year: 131.2,
  lab_booking_status_year: 'full',
  lab_booked_pct_remaining: null,
  lab_booking_status_remaining: 'full',
});

describe('AreaBookingStrip (ADR 0016)', () => {
  it('renders one card per served area with the served % and status for the full year', () => {
    renderWithProviders(<AreaBookingStrip areas={[europe, india]} horizon="year" />);
    expect(screen.getAllByTestId('capacity-area-card')).toHaveLength(2);
    expect(screen.getByTestId('area-strip-horizon')).toHaveTextContent('Full year');

    const euDesign = screen.getByTestId('area-Europe-design');
    expect(euDesign).toHaveTextContent('72.44 %');
    expect(within(euDesign).getByText('Available')).toBeInTheDocument();

    const inDesign = screen.getByTestId('area-India-design');
    expect(inDesign).toHaveTextContent('90 %');
    expect(within(inDesign).getByText('Near full')).toBeInTheDocument();
  });

  it('over 100 %: shows the served number, the Full chip and the over-booked hint', () => {
    renderWithProviders(<AreaBookingStrip areas={[india]} horizon="year" />);
    const lab = screen.getByTestId('area-India-lab');
    expect(lab).toHaveTextContent('131.2 %');
    expect(within(lab).getByText('Full')).toBeInTheDocument();
    expect(screen.getByTestId('area-India-lab-over')).toHaveTextContent(/Over-booked/);
  });

  it('follows the horizon: remaining-year picks the remaining fields, including a null %', () => {
    renderWithProviders(<AreaBookingStrip areas={[europe, india]} horizon="remaining" />);
    expect(screen.getByTestId('area-strip-horizon')).toHaveTextContent(/Remaining year/);
    const euDesign = screen.getByTestId('area-Europe-design');
    expect(euDesign).toHaveTextContent('108.7 %');
    expect(within(euDesign).getByText('Full')).toBeInTheDocument();
    // capacity 0 → null % → "—", and the SERVED status (Full) is still shown.
    const inLab = screen.getByTestId('area-India-lab');
    expect(inLab).toHaveTextContent('—');
    expect(within(inLab).getByText('Full')).toBeInTheDocument();
    expect(inLab).toHaveTextContent('No capacity in scope');
  });

  it('lists the hubs and lab regions each area covers', () => {
    renderWithProviders(<AreaBookingStrip areas={[europe, india]} horizon="year" />);
    expect(screen.getByTestId('area-Europe-coverage')).toHaveTextContent('R&D-Greece, PD-Romania');
    expect(screen.getByTestId('area-Europe-coverage')).toHaveTextContent('Greece, Romania');
    expect(screen.getByTestId('area-India-coverage')).toHaveTextContent('OEM-HCK');
  });

  it('marks a hub-scoped user\'s partial area as "Your hubs only"', () => {
    renderWithProviders(
      <AreaBookingStrip areas={[areaRow({ hubs: ['R&D-Greece'], lab_regions: ['Greece'] })]} horizon="year" />,
      { session: { hub_scope_all: false, hub_ids: ['hub-gr'] } },
    );
    expect(screen.getByText('Your hubs only')).toBeInTheDocument();
    expect(screen.getByTestId('area-Europe-coverage')).toHaveTextContent('R&D-Greece');
    expect(screen.getByTestId('area-Europe-coverage')).not.toHaveTextContent('PD-Romania');
  });

  it('a global user does not see the partial marker', () => {
    renderWithProviders(<AreaBookingStrip areas={[europe]} horizon="year" />);
    expect(screen.queryByText('Your hubs only')).not.toBeInTheDocument();
  });

  it('renders nothing when no area is served', () => {
    renderWithProviders(<AreaBookingStrip areas={[]} horizon="year" />);
    expect(screen.queryByTestId('area-booking-strip')).not.toBeInTheDocument();
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<AreaBookingStrip areas={[europe, india]} horizon="year" />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
