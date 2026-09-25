/**
 * Trigger a browser file-save for an already-fetched `Blob` (P5-T08 —
 * "Download" action for every surface's CSV/XLSX export). Pure DOM side
 * effect, deliberately kept separate from the network fetch (`apiDownload`,
 * `src/lib/api/client.ts`) so the fetch and the save-to-disk step can be
 * tested/mocked independently.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick rather than synchronously — some browsers have
  // been observed to abort an in-flight save if the object URL is freed
  // before the click's navigation is processed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
