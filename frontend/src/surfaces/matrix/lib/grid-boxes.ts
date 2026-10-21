/** P21-T03: the scoring grid's visual boxes (identity, info, one per pillar,
 *  Score /100, actions) and the left line each column draws. Layout only. */

export type MatrixBoxKind = 'identity' | 'info' | 'pillar' | 'score' | 'actions';

export interface MatrixBox {
  id: string;
  kind: MatrixBoxKind;
  tint?: boolean;
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
