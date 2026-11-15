import * as React from 'react';
import { Check } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { HardGateReason } from '@/types/enums';

import type { DimensionScoreValue } from '../api/types';
import { parseScoreInput } from '../lib/grid-edit';

/**
 * P34-T02: the scoring grid's edit-mode cells. A dimension score is a compact
 * one-character 0–5 input (empty = "not scored", which clears it, as the old
 * edit dialog allowed); a hard gate is a checkbox. Keyboard: Tab / Shift+Tab
 * walk the cells, arrow keys move left / right / up / down between edit cells,
 * Enter moves down, 0–5 replace the value, Backspace / Delete clear it.
 */

/** Short header text per hard gate (the full reason is the tooltip and the accessible name). */
const HARD_GATE_SHORT: Record<HardGateReason, string> = {
  'Regulatory deadline within 6 months': 'Reg. deadline',
  'Customer certification at risk (Coke/Pepsi)': 'Cert. at risk',
  'Active safety non-compliance': 'Safety',
};

const EDIT_CELL = '[data-edit-cell]';

/** Move focus to the edit cell `dRow` rows / `dCol` cells away (virtualised
 *  rows within the overscan are in the DOM; the target scrolls into view). */
function moveFocus(from: HTMLElement, dRow: number, dCol: number): boolean {
  const rowEl = from.closest<HTMLElement>('[role="row"]');
  if (!rowEl) return false;
  const cells = Array.from(rowEl.querySelectorAll<HTMLElement>(EDIT_CELL));
  const col = cells.indexOf(from);
  let target: HTMLElement | undefined;
  if (dRow === 0) {
    target = cells[col + dCol];
  } else {
    const index = Number(rowEl.dataset.index ?? '-1') + dRow;
    const nextRow = rowEl.parentElement?.querySelector<HTMLElement>(`[role="row"][data-index="${String(index)}"]`);
    target = nextRow ? Array.from(nextRow.querySelectorAll<HTMLElement>(EDIT_CELL))[col] : undefined;
  }
  if (!target) return false;
  target.focus();
  target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  return true;
}

function navKey(event: React.KeyboardEvent<HTMLElement>): boolean {
  const el = event.currentTarget;
  const moves: Record<string, [number, number] | undefined> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
    Enter: [1, 0],
  };
  const move = moves[event.key];
  if (!move) return false;
  event.preventDefault();
  moveFocus(el, move[0], move[1]);
  return true;
}

export function ScoreInput({
  value,
  changed,
  label,
  onChange,
}: {
  value: DimensionScoreValue;
  changed: boolean;
  /** "Strategic Project for Cooler A". */
  label: string;
  onChange: (next: DimensionScoreValue) => void;
}): React.JSX.Element {
  return (
    <input
      type="text"
      inputMode="numeric"
      maxLength={1}
      autoComplete="off"
      className="mg-edit-input"
      aria-label={`${label}, score 0 to 5, empty for not scored`}
      value={value === null ? '' : String(value)}
      data-edit-cell=""
      data-changed={changed ? 'true' : undefined}
      data-testid="score-input"
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (navKey(e)) return;
        if (/^[0-5]$/.test(e.key)) {
          e.preventDefault();
          onChange(Number(e.key));
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          onChange(null);
        }
      }}
      onChange={(e) => {
        // Paste / IME / assistive input: accept only a valid 0–5 or empty.
        const parsed = parseScoreInput(e.currentTarget.value);
        if (parsed !== undefined) onChange(parsed);
      }}
    />
  );
}

export function GateCheckbox({
  checked,
  changed,
  label,
  onChange,
}: {
  checked: boolean;
  changed: boolean;
  label: string;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <span className="mg-gate-cell" data-changed={changed ? 'true' : undefined}>
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        aria-label={label}
        data-edit-cell=""
        data-testid="gate-checkbox"
        onKeyDown={(e) => {
          navKey(e);
        }}
      />
    </span>
  );
}

/** Read-only gate cell: a check mark when the served `hard_gates` lists it. */
export function GateMark({ on, label }: { on: boolean; label: string }): React.JSX.Element {
  return on ? (
    <span className="inline-flex text-danger" title={label} data-testid="gate-mark">
      <Check className="size-4" aria-hidden="true" />
      <span className="sr-only">{label}: yes</span>
    </span>
  ) : (
    <span className="text-text-subtle" aria-hidden="true">
      ·
    </span>
  );
}

export function GateHeader({ gate }: { gate: HardGateReason }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="mg-dim-head cursor-help rounded-sm text-center leading-tight underline decoration-dotted underline-offset-2"
          aria-label={`Hard gate: ${gate} (overrides the band, forces P1)`}
          data-testid="gate-head"
        >
          {HARD_GATE_SHORT[gate]}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">
        <span className="block font-semibold">{gate}</span>
        <span className="block">A hard gate overrides the score band and forces P1 (DOMAIN_RULES.md).</span>
      </TooltipContent>
    </Tooltip>
  );
}
