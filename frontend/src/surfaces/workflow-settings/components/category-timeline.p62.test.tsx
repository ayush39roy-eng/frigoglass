import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { timelineFixture } from '../test-fixtures';
import type { SavedCell } from '../lib/template-drafts';
import { CategoryTimelineList, ControlledCategoryTimeline, ROOM_FULL_NOTE, ROOM_SET_NOTE } from './category-timeline';

/**
 * P62 (ADR 0071): A+ with PDD-J made a 3-week lab step (fixture start 36)
 * holding its LAST week (served `room_weeks` 1 at `room_start_week` 38), and
 * PDD-L a lab step with no room (served `room_weeks` 0).
 */
function roomTimeline() {
  return timelineFixture(
    'A+',
    {
      'PDD-J': { resource_kind: 'lab', duration_weeks: 3, lab_hold_weeks: 1, room_weeks: 1, room_start_week: 38 },
      'PDD-L': { resource_kind: 'lab', lab_hold_weeks: 0, room_weeks: 0, room_start_week: null },
    },
    { lab_weeks: 13, lab_length_weeks: 18 },
  );
}

const SAVED: Record<string, SavedCell> = {
  'PDD-F': { weeks: 6, gap_weeks: 0, lab_hold_weeks: null },
  'PDD-J': { weeks: 3, gap_weeks: 0, lab_hold_weeks: 1 },
  'PDD-L': { weeks: 3, gap_weeks: 0, lab_hold_weeks: 0 },
};

describe('Category timeline room weeks (P62)', () => {
  it('header: Lab room = served lab_weeks, lab length = served lab_length_weeks', () => {
    renderWithProviders(<CategoryTimelineList timelines={[roomTimeline()]} />);
    const pill = screen.getByTestId('lab-weeks-pill');
    expect(pill).toHaveTextContent('Lab room 13w');
    expect(pill).toHaveTextContent('lab length 18w');
  });

  it('draws the served room weeks solid inside the lab bar; 0 room weeks reads "no room"', () => {
    renderWithProviders(<CategoryTimelineList timelines={[roomTimeline()]} />);
    const j = screen.getByTestId('step-PDD-J');
    const room = within(j).getByTestId('room-PDD-J');
    // J: start 36, 3 weeks; room from 38 → the last third of the bar.
    expect(parseFloat(room.style.left)).toBeCloseTo(66.667, 2);
    expect(parseFloat(room.style.width)).toBeCloseTo(33.333, 2);
    expect(j).toHaveTextContent('room booked for the last 1 week, from W38');
    const l = screen.getByTestId('step-PDD-L');
    expect(within(l).queryByTestId('room-PDD-L')).not.toBeInTheDocument();
    expect(l).toHaveTextContent('no room');
    // A full-room lab step (PoC) is solid over its whole length.
    expect(within(screen.getByTestId('step-PDD-F')).getByTestId('room-PDD-F').style.width).toBe('100%');
    expect(screen.getByTestId('legend-lab-room')).toHaveTextContent('Lab — room booked (chamber)');
    expect(screen.getByTestId('legend-lab-no-room')).toHaveTextContent('Lab — no room booked');
  });

  it('Room − / + / Full on lab steps only, next to Length; clicks go to the one draft set', async () => {
    const user = userEvent.setup();
    const onHold = vi.fn();
    const { container } = renderWithProviders(
      <ControlledCategoryTimeline
        timeline={roomTimeline()}
        drafts={{}}
        saved={SAVED}
        canWrite
        disabled={false}
        defaultOpen
        onNudge={vi.fn()}
        onHold={onHold}
        onResetStep={vi.fn()}
      />,
    );
    const jRoom = screen.getByRole('group', { name: 'Room weeks of PDD-J' });
    expect(within(jRoom).getByTestId('room-value-PDD-J')).toHaveTextContent('1w');
    expect(within(screen.getByRole('group', { name: 'Room weeks of PDD-F' })).getByTestId('room-value-PDD-F')).toHaveTextContent(
      'Full',
    );
    // Design steps have no room control.
    expect(within(screen.getByRole('group', { name: 'Room weeks of PDD-E' })).queryByRole('button')).not.toBeInTheDocument();

    await user.click(within(jRoom).getByRole('button', { name: 'One room week more for PDD-J' }));
    expect(onHold).toHaveBeenLastCalledWith('PDD-J', 1, 3);
    await user.click(within(jRoom).getByRole('button', { name: 'Room weeks of PDD-J: Full (the whole length)' }));
    expect(onHold).toHaveBeenLastCalledWith('PDD-J', 'full', 3);
    const fFull = screen.getByRole('button', { name: 'Room weeks of PDD-F: Full (the whole length)' });
    expect(fFull).toHaveAttribute('aria-pressed', 'true');
    expect(fFull).toBeDisabled();
    expect(screen.getByRole('button', { name: 'One room week more for PDD-F' })).toBeDisabled();
    // Keyboard: the − button is reachable and works with Enter.
    const fMinus = screen.getByRole('button', { name: 'One room week fewer for PDD-F' });
    fMinus.focus();
    await user.keyboard('{Enter}');
    expect(onHold).toHaveBeenLastCalledWith('PDD-F', -1, 6);

    // Help text (contract §8) on a lab step with a value.
    expect(screen.getByTestId('flag-PDD-J-room-set')).toHaveTextContent(ROOM_SET_NOTE);
    expect(screen.queryByTestId('flag-PDD-F-room-set')).not.toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('a value drafted back to Full says what Full means', () => {
    renderWithProviders(
      <ControlledCategoryTimeline
        timeline={roomTimeline()}
        drafts={{ 'PDD-J': { lab_hold_weeks: null } }}
        saved={SAVED}
        canWrite={false}
        disabled={false}
        defaultOpen
        onNudge={vi.fn()}
        onHold={vi.fn()}
        onResetStep={vi.fn()}
      />,
    );
    // Readers get no controls and no editor notes.
    expect(screen.queryByRole('group', { name: 'Room weeks of PDD-J' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('flag-PDD-J-room-full')).not.toBeInTheDocument();
  });

  it('editor: a drafted Full on a saved value shows the Full note', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderWithProviders(
      <ControlledCategoryTimeline
        timeline={roomTimeline()}
        drafts={{ 'PDD-J': { lab_hold_weeks: null } }}
        saved={SAVED}
        canWrite
        disabled={false}
        defaultOpen
        onNudge={vi.fn()}
        onHold={vi.fn()}
        onResetStep={vi.fn()}
      />,
    );
    expect(screen.getByTestId('flag-PDD-J-room-full')).toHaveTextContent(ROOM_FULL_NOTE);
    expect(screen.getByTestId('room-value-PDD-J')).toHaveTextContent('Full');
    vi.unstubAllGlobals();
  });
});
