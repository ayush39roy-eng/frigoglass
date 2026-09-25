import * as React from 'react';
import { ChevronDown, Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiDownload, ApiError } from '@/lib/api/client';
import { saveBlob } from '@/lib/download';

/**
 * Cross-surface "Download" action for P5-T04's six export endpoints
 * (`GET /exports/{surface}?format=csv|xlsx`, `backend/api/routers/
 * exports.py`) — P5-T08. One shared component used on all six surfaces
 * rather than six divergent implementations.
 *
 * **Sync-only, by design** (see `docs/MEMORY.md` P5-T08 entry for the full
 * reasoning): every export endpoint defaults to a synchronous, streamed
 * response, and per that router's own docstring an unfiltered export at this
 * app's real scale (~236 projects, per CLAUDE.md) is "a few thousand rows,
 * sub-second" — genuinely sufficient for all six surfaces. This component
 * therefore never sends `async_export=true` and never polls `GET
 * /exports/jobs/{id}`; it just fetches the file and saves it. If a future
 * surface's unfiltered export turns out large enough to want the async/MinIO
 * path, that is a new, explicit opt-in on top of this component — not a
 * change to it.
 *
 * **RBAC**: no permission check happens here. Every export endpoint requires
 * the exact same `READ` permission as that surface's own live queries
 * (`core.rbac.Surface`/`Action.READ` — see `api/routers/exports.py`'s module
 * docstring), and every surface page already replaces its entire content
 * with `AccessNotice` when those live queries 403 (each page's own `denied`
 * branch). A caller who can't reach a surface's data therefore never renders
 * this button for that surface, without any RBAC logic duplicated in the
 * frontend — the existing access-notice precedent already covers it. The
 * inline error below only covers the (unexpected) case of a 403 surfacing
 * mid-session after the surface itself rendered successfully.
 */
export type DownloadExportFormat = 'csv' | 'xlsx';

export interface DownloadButtonProps {
  /** Export endpoint path (`backend/api/routers/exports.py`), e.g.
   * `/exports/matrix`. */
  path: string;
  /** The surface's own CURRENT filter state, mirrored 1:1 onto the export
   * endpoint's query params (undefined values are dropped, same convention
   * as `apiGet`'s own `query` option) — this is what makes "download" match
   * "what I'm looking at right now" rather than an unfiltered dump. */
  filters?: Record<string, string | undefined>;
  /** Used only if the server response has no `Content-Disposition` filename
   * (it always does today — `api/routers/exports.py::_respond` sets one on
   * every response — this is a defensive fallback only). No extension; the
   * chosen format's extension is appended. */
  fallbackFilename: string;
  /** Hide the action entirely (not just disable it) — e.g. while the
   * surface's own data is still loading and no filter state is settled yet. */
  hidden?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export function DownloadButton({
  path,
  filters,
  fallbackFilename,
  hidden = false,
  disabled = false,
  label = 'Download',
  className,
}: DownloadButtonProps): React.JSX.Element | null {
  const [pending, setPending] = React.useState<DownloadExportFormat | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleDownload = React.useCallback(
    async (format: DownloadExportFormat) => {
      setError(null);
      setPending(format);
      try {
        const { blob, filename } = await apiDownload(path, {
          query: { ...filters, format },
          fallbackFilename: `${fallbackFilename}.${format}`,
        });
        saveBlob(blob, filename);
      } catch (err) {
        setError(
          err instanceof ApiError && err.isForbidden
            ? 'Your role does not have access to export this view.'
            : 'The export could not be downloaded. Please try again.',
        );
      } finally {
        setPending(null);
      }
    },
    [path, filters, fallbackFilename],
  );

  if (hidden) return null;

  return (
    <div className={className}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="secondary" size="sm" disabled={disabled || pending !== null}>
            {pending ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Download aria-hidden="true" />
            )}
            {label}
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void handleDownload('csv')} disabled={pending !== null}>
            Download as CSV
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleDownload('xlsx')} disabled={pending !== null}>
            Download as XLSX
          </DropdownMenuItem>
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
