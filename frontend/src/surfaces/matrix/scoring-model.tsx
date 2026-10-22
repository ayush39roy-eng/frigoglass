import * as React from 'react';

import { useScoringDimensions } from './hooks/use-matrix';
import type { ScoringDimensionTable } from './api/types';
import { EMPTY_SCORING_MODEL, buildScoringModel, type ScoringModel } from './lib/scoring-model-core';

export type { ScoringModel, ScoringModelEntry } from './lib/scoring-model-core';

const ScoringModelContext = React.createContext<ScoringModel>(EMPTY_SCORING_MODEL);

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

/** Fetches the served table and provides it; until it arrives (or on error) the model is empty. */
export function FetchedScoringModelProvider({
  children,
  enabled = true,
}: {
  children: React.ReactNode;
  /** False skips the request (e.g. a caller without Matrix read). */
  enabled?: boolean;
}): React.JSX.Element {
  const { data } = useScoringDimensions(enabled);
  return <ScoringModelProvider table={data}>{children}</ScoringModelProvider>;
}

/** "Total: 100 (scaled from 295)" — total_weight is the served figure (Σ active weights). */
export function ScoringTotalLine(): React.JSX.Element | null {
  const { total_weight: total } = useScoringModel();
  if (total === null) return null;
  return (
    <span className="text-2xs text-text-muted" data-testid="scoring-total-line">
      Total: 100 (scaled from {total})
    </span>
  );
}
