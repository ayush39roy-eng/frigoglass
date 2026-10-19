import * as React from 'react';

import { useScoringDimensions } from './hooks/use-matrix';
import { DIMENSIONS, type DimensionField, type ScoringDimension, type ScoringDimensionTable } from './api/types';

/**
 * The SERVED scoring-dimension table (P16, ADR 0029). The server owns weights,
 * scaled weights and `total_weight`; the browser only displays them (I9). When
 * no served table has been provided yet, the static `DIMENSIONS` copy supplies
 * labels/pillars/weights and `scaled_weight` / `total_weight` are null (shown
 * as an em dash, never computed).
 */
export interface ScoringModelEntry extends Omit<ScoringDimension, 'scaled_weight' | 'key'> {
  key: DimensionField;
  short: string;
  scaled_weight: number | null;
}

export interface ScoringModel {
  dimensions: readonly ScoringModelEntry[];
  total_weight: number | null;
}

export function buildScoringModel(table: ScoringDimensionTable | null | undefined): ScoringModel {
  return {
    total_weight: table ? table.total_weight : null,
    dimensions: DIMENSIONS.map((d) => {
      const served = table?.dimensions.find((s) => s.key === d.field);
      return {
        key: d.field,
        short: d.short,
        label: served?.label ?? d.label,
        pillar: served?.pillar ?? d.pillar,
        weight: served?.weight ?? d.weight,
        scaled_weight: served ? served.scaled_weight : null,
      };
    }),
  };
}

const ScoringModelContext = React.createContext<ScoringModel>(buildScoringModel(null));

export function ScoringModelProvider({
  table,
  children,
}: {
  table: ScoringDimensionTable | null | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = React.useMemo(() => buildScoringModel(table), [table]);
  return <ScoringModelContext.Provider value={value}>{children}</ScoringModelContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useScoringModel(): ScoringModel {
  return React.useContext(ScoringModelContext);
}

/** "25 (8.5 of 100)" style text from served figures; scaled omitted when not served. */
export function formatWeight(weight: number, scaled: number | null): string {
  return scaled === null ? String(weight) : `${String(weight)} (${scaled.toFixed(1)} of 100)`;
}

/** Fetches the served table and provides it; on error the static fallback stays. */
export function FetchedScoringModelProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { data } = useScoringDimensions();
  return <ScoringModelProvider table={data}>{children}</ScoringModelProvider>;
}

/** "Total: 100 (scaled from 295)" — total_weight is the served figure. */
export function ScoringTotalLine(): React.JSX.Element | null {
  const { total_weight: total } = useScoringModel();
  if (total === null) return null;
  return (
    <span className="text-2xs text-text-muted" data-testid="scoring-total-line">
      Total: 100 (scaled from {total})
    </span>
  );
}
