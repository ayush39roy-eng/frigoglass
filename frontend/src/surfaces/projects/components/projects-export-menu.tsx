import * as React from 'react';
import { ChevronDown, Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiDownload, ApiError } from '@/lib/api/client';
import { saveBlob } from '@/lib/download';

/**
 * P22-T01: the merged Projects page's one "Export" menu. It carries both of the
 * exports the two old pages had, unchanged:
 *
 * - **Projects list** — `GET /exports/dashboard` with every filter on the page
 *   (the old Projects page's Download, `dashboard` read).
 * - **Registration register** — `GET /exports/project-registration`, which
 *   includes the encrypted financial columns for callers entitled to them (the
 *   old `/register` Download, `project_registration` read). Offered only to
 *   roles that read Registration; the server still decides. That endpoint has
 *   no country / leader / step / sort filter, so the menu says so.
 *
 * Synchronous download, like `components/shared/download-button.tsx`. There is
 * no import endpoint in the backend (P5-T05 scope lock, OQ #7), so there is no
 * import item.
 */

export interface ExportSource {
  id: string;
  label: string;
  hint?: string;
  path: string;
  filters: Record<string, string | undefined>;
  fallbackFilename: string;
}

type Format = 'csv' | 'xlsx';

export function ProjectsExportMenu({ sources }: { sources: ExportSource[] }): React.JSX.Element {
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const download = React.useCallback(async (source: ExportSource, format: Format) => {
    setError(null);
    setPending(`${source.id}:${format}`);
    try {
      const { blob, filename } = await apiDownload(source.path, {
        query: { ...source.filters, format },
        fallbackFilename: `${source.fallbackFilename}.${format}`,
      });
      saveBlob(blob, filename);
    } catch (err) {
      setError(
        err instanceof ApiError && err.isForbidden
          ? 'Your role does not have access to this export.'
          : 'The export could not be downloaded. Please try again.',
      );
    } finally {
      setPending(null);
    }
  }, []);

  return (
    <div className="flex flex-col items-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="secondary" size="sm" disabled={pending !== null}>
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
            Export
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {sources.map((source, i) => (
            <React.Fragment key={source.id}>
              {i > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs">
                  {source.label}
                  {source.hint ? (
                    <span className="block text-2xs font-normal text-text-muted">{source.hint}</span>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void download(source, 'csv')} disabled={pending !== null}>
                  {source.label} as CSV
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void download(source, 'xlsx')} disabled={pending !== null}>
                  {source.label} as XLSX
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </React.Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? (
        <p role="alert" className="mt-1 text-2xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
