import * as React from 'react';

import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { formatInteger } from '@/lib/format';
import type { ProjectStatus } from '@/types/enums';

import type { RegionSummary } from '../api/types';

/**
 * The register's per-country summary chips (mock-up "ALL ACTIVE REGISTERED
 * PROJECTS" header, contract §4): Comm. / Ind. / Dev. / Que counts per country.
 * Each figure is one served `status_counts` entry of
 * `GET /dashboard/region-summary` — never summed in the browser (I9).
 */

const STATUS_ABBR: { status: ProjectStatus; abbr: string }[] = [
  { status: 'Commercialized', abbr: 'Comm.' },
  { status: 'Under Industrialization', abbr: 'Ind.' },
  { status: 'In Development', abbr: 'Dev.' },
  { status: 'In Queue', abbr: 'Que' },
];

export function RegisterRegionSummary({ summary }: { summary: RegionSummary }): React.JSX.Element {
  return (
    <ul className="flex flex-wrap gap-s2" aria-label="Projects by country and status" data-testid="register-region-summary">
      {summary.regions.map((row) => (
        <li
          key={row.region}
          className="inline-flex flex-wrap items-center gap-x-s2 gap-y-1 rounded-dash border-[1.5px] border-dash-hairline bg-dash-alt px-s3 py-1.5 text-2xs"
        >
          <span className="inline-flex items-center gap-1.5 font-bold text-text">
            <CountryFlag region={row.region} />
            {row.region}
          </span>
          {STATUS_ABBR.map(({ status, abbr }) => (
            <span key={status} className="tabular-nums text-text-muted" title={status} data-numeric="">
              <abbr title={status} className="no-underline">
                {abbr}
              </abbr>{' '}
              <span className="font-bold text-text">{formatInteger(row.status_counts[status] ?? 0)}</span>
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}
