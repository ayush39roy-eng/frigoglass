import * as React from 'react';

import { useImportPlan } from './import-store';
import type { ImportSimulateResponse } from './import-types';
import { YEAR_ALL, yearOptions } from './year-filter';

/** The Year key in effect (P32-R05): the stored one when this result offers it, else "all". */
export function useEffectiveYear(result: Pick<ImportSimulateResponse, 'base_year' | 'breakdowns'>): string {
  const key = useImportPlan((s) => s.yearFilter);
  const options = React.useMemo(() => yearOptions(result), [result]);
  return options.some((o) => o.key === key) ? key : YEAR_ALL;
}
