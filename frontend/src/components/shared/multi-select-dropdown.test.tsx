import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { seriousAxeViolations } from '@/test/axe';

import { summarizeSelection } from '@/lib/multi-select-summary';

import { MultiSelectDropdown, type MultiSelectOption } from './multi-select-dropdown';

const STATUSES: MultiSelectOption[] = [
  { value: 'In Queue', label: 'In Queue' },
  { value: 'In Development', label: 'In Development' },
  { value: 'On Hold', label: 'On Hold' },
];

function Harness({
  options = STATUSES,
  initial = [],
  onChange,
}: {
  options?: MultiSelectOption[];
  initial?: string[];
  onChange?: (next: string[]) => void;
}): React.JSX.Element {
  const [value, setValue] = React.useState<string[]>(initial);
  return (
    <MultiSelectDropdown
      label="Status"
      allLabel="All statuses"
      options={options}
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      data-testid="ms"
    />
  );
}

describe('summarizeSelection', () => {
  it('reads "All …" / the one label / "N <noun>"', () => {
    expect(summarizeSelection([], 'All statuses')).toBe('All statuses');
    expect(summarizeSelection([STATUSES[0]!], 'All statuses')).toBe('In Queue');
    expect(summarizeSelection(STATUSES, 'All statuses')).toBe('3 statuses');
    expect(summarizeSelection(STATUSES.slice(0, 2), 'All', 'selected')).toBe('2 selected');
  });
});

describe('<MultiSelectDropdown>', () => {
  it('the trigger is named by the label and described by the summary', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Status' });
    expect(trigger).toHaveAccessibleDescription('All statuses');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('picks several values (popover stays open), in OPTION order, and summarises them', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    const list = screen.getByRole('listbox', { name: 'Status' });
    expect(list).toHaveAttribute('aria-multiselectable', 'true');
    await userEvent.click(within(list).getByRole('option', { name: 'On Hold' }));
    await userEvent.click(within(list).getByRole('option', { name: 'In Queue' }));
    expect(onChange).toHaveBeenLastCalledWith(['In Queue', 'On Hold']);
    expect(within(list).getByRole('option', { name: 'In Queue' })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getByRole('option', { name: 'All statuses' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('ms-summary')).toHaveTextContent('2 statuses');
    // Un-pick one: the summary names the remaining value.
    await userEvent.click(within(list).getByRole('option', { name: 'On Hold' }));
    expect(screen.getByTestId('ms-summary')).toHaveTextContent('In Queue');
  });

  it('"All" clears the selection', async () => {
    const onChange = vi.fn();
    render(<Harness initial={['On Hold', 'In Queue']} onChange={onChange} />);
    expect(screen.getByTestId('ms-summary')).toHaveTextContent('2 statuses');
    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    await userEvent.click(screen.getByRole('option', { name: 'All statuses' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByTestId('ms-summary')).toHaveTextContent('All statuses');
  });

  it('is keyboard operable: ArrowDown opens, arrows move, Space toggles, Escape closes to the trigger', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Status' });
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    // Nothing selected: focus starts on "All".
    expect(screen.getByRole('option', { name: 'All statuses' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('option', { name: 'In Development' })).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(['In Development']);
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('option', { name: 'On Hold' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['In Development', 'On Hold']);
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('option', { name: 'All statuses' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('shows a search box only above 8 options; it narrows the rows and ArrowDown enters the list', async () => {
    const few = Array.from({ length: 8 }, (_, i) => ({ value: `v${String(i)}`, label: `Leader ${String(i)}` }));
    const { unmount } = render(<Harness options={few} />);
    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    unmount();

    const many = [...few, { value: 'v8', label: 'Maria Papadopoulou' }];
    render(<Harness options={many} />);
    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    const search = screen.getByRole('searchbox', { name: 'Search status' });
    expect(search).toHaveFocus();
    await userEvent.type(search, 'maria');
    const list = screen.getByRole('listbox');
    // "All" + the one match.
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['All statuses', 'Maria Papadopoulou']);
    await userEvent.keyboard('{ArrowDown}');
    expect(within(list).getByRole('option', { name: 'All statuses' })).toHaveFocus();
    await userEvent.type(search, 'zzz');
    expect(screen.getByRole('status')).toHaveTextContent('No matches');
  });

  it('renders group headings as labelled groups', async () => {
    const grouped: MultiSelectOption[] = [
      { value: 'region:India', label: 'India', group: 'Countries' },
      { value: 'hub:1', label: 'PD-India', group: 'Hubs' },
    ];
    render(<Harness options={grouped} />);
    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(within(screen.getByRole('group', { name: 'Countries' })).getByRole('option', { name: 'India' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Hubs' })).getByRole('option', { name: 'PD-India' })).toBeInTheDocument();
  });

  it('a selected value whose option has not loaded yet still counts in the summary', () => {
    render(<Harness options={[]} initial={['e-unknown']} />);
    expect(screen.getByTestId('ms-summary')).toHaveTextContent('Selected');
  });

  it('has no serious axe violations open or closed', async () => {
    const { container } = render(<Harness initial={['On Hold']} />);
    expect(await seriousAxeViolations(container)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(await seriousAxeViolations(document.body)).toEqual([]);
  });
});
