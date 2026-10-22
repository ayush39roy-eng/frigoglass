/** P21-T03: the scoring grid's visual boxes (identity, info, one per pillar,
 *  Score /100, actions) and the left line each column draws. Layout only. */

export type MatrixBoxKind = 'identity' | 'info' | 'pillar' | 'score' | 'actions';

export interface MatrixBox {
  id: string;
  kind: MatrixBoxKind;
  tint?: boolean;
}

/**
 * P21-T03: every second pillar (0-based odd index, in display order) carries the
 * faint tint. Shared by the scoring grid and the rubric card (P26-T03) so the two
 * read as one system.
 */
export function pillarTinted(pillarIndex: number): boolean {
  return pillarIndex % 2 === 1;
}

/** The left line a column draws (`data-line`), from its box and its neighbour's. */
export type MatrixLine = 'none' | 'inner' | 'pillar' | 'block';

export function columnLines(columns: readonly { box?: MatrixBox | undefined }[]): MatrixLine[] {
  return columns.map((col, i) => {
    if (i === 0) return 'none';
    const prev = columns[i - 1]?.box;
    const box = col.box;
    if (!box || !prev) return 'none';
    if (prev.id === box.id) return box.kind === 'pillar' ? 'inner' : 'none';
    return prev.kind === 'pillar' && box.kind === 'pillar' ? 'pillar' : 'block';
  });
}

/**
 * P26: dimension columns carry served labels of any length, so each column is
 * sized from its own label (layout only): wide enough for the label's longest
 * word at the header type size, within [min, 112] px. A pillar band is then
 * widened, spread evenly over its columns, until its own longest word fits.
 */
const HEADER_CHAR_PX = 6.8;
const BAND_CHAR_PX = 7.6;
const longestWord = (text: string) => Math.max(0, ...text.split(/\s+/).map((w) => w.length));

export function dimensionColumnWidth(label: string, min: number): number {
  return Math.min(112, Math.max(min, Math.ceil(longestWord(label) * HEADER_CHAR_PX) + 16));
}

export function widenForBand(widths: readonly number[], pillar: string): number[] {
  const need = Math.ceil(longestWord(pillar.toUpperCase()) * BAND_CHAR_PX) + 24;
  const have = widths.reduce((a, w) => a + w, 0);
  if (have >= need || widths.length === 0) return [...widths];
  const extra = Math.ceil((need - have) / widths.length);
  return widths.map((w) => w + extra);
}
