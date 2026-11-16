/**
 * P40-T01 (owner ask 2026-11-17): ONE colour per workflow step on the Timeline,
 * keyed by step code. The palette is the client's old Charter tool's 14 colours
 * by step index (`Charter.jsx`), with its duplicate fixed (slot 14 was the same
 * green as slot 9; it is now lime). The colours themselves live in
 * `styles/tokens.css` ("WORKFLOW STEP PALETTE", `--step-N` / `--step-ink-N`, light
 * and dark), so this map only says which slot a step code uses.
 *
 * Pure presentation: a colour is chosen from the served step code, never from a
 * computed value.
 */

export const STEP_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'] as const;
export type StepLetter = (typeof STEP_LETTERS)[number];
export type StepCode = `PDD-${StepLetter}` | `OEM-${StepLetter}`;

/** The old tool's palette, in slot order, as it ships in `tokens.css` (light
 *  theme). Documentation and tests only; rendering reads the CSS variables. */
export const STEP_PALETTE_HEX = [
  '#1A6FE0',
  '#8B7FFF',
  '#0D9488',
  '#00C9A7',
  '#F59E0B',
  '#E11D48',
  '#7C3AED',
  '#2563EB',
  '#059669',
  '#D97706',
  '#DB2777',
  '#4F46E5',
  '#0891B2',
  '#65A30D', // was #059669 (a duplicate of slot 9) in the old tool
] as const;

export interface StepColor {
  /** 1..14: the `--step-N` slot. */
  slot: number;
  /** Bar fill, e.g. `hsl(var(--step-5))`. */
  fill: string;
  /** Label text on the fill (white or dark, AA 4.5:1). */
  ink: string;
  /** The step letter shown inside wide bars and in the legend. */
  letter: StepLetter;
}

function entry(letter: StepLetter, index: number): StepColor {
  const slot = index + 1;
  return {
    slot,
    fill: `hsl(var(--step-${String(slot)}))`,
    ink: `hsl(var(--step-ink-${String(slot)}))`,
    letter,
  };
}

/** THE token map: step code → colour. PDD and OEM step N share slot N. */
export const STEP_COLORS: Readonly<Record<StepCode, StepColor>> = Object.fromEntries(
  (['PDD', 'OEM'] as const).flatMap((wf) => STEP_LETTERS.map((l, i) => [`${wf}-${l}`, entry(l, i)] as const)),
) as Record<StepCode, StepColor>;

export function isStepCode(code: string): code is StepCode {
  return Object.prototype.hasOwnProperty.call(STEP_COLORS, code);
}

/**
 * The colour of a served step. A code outside the two templates (not expected)
 * falls back to its served `sequence_order` slot, so it still gets a colour.
 */
export function stepColor(code: string, sequenceOrder?: number): StepColor {
  if (isStepCode(code)) return STEP_COLORS[code];
  const index = Math.min(13, Math.max(0, (sequenceOrder ?? 1) - 1));
  return entry(STEP_LETTERS[index] ?? 'A', index);
}

/** `hsl(var(--step-N) / a)` — a tint of the step colour. */
export function stepTint(color: StepColor, alpha: number): string {
  return `hsl(var(--step-${String(color.slot)}) / ${String(alpha)})`;
}

/** The per-slot hatch pattern id for actual bars (`GanttHatchDefs`). */
export function stepHatchId(slot: number): string {
  return `gantt-hatch-step-${String(slot)}`;
}

/** Step slots whose actual weeks a project row draws (for its hatch defs). */
export function actualSlots(
  steps: readonly {
    step_id: string;
    sequence_order: number;
    skipped: boolean;
    actual_start_week: number | null;
    actual_end_week: number | null;
  }[],
): number[] {
  return steps
    .filter((s) => !s.skipped && s.actual_start_week != null && s.actual_end_week != null)
    .map((s) => stepColor(s.step_id, s.sequence_order).slot);
}
