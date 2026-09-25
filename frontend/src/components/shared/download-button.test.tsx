import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DownloadButton } from './download-button';

vi.mock('@/lib/download', () => ({
  saveBlob: vi.fn(),
}));

import { saveBlob } from '@/lib/download';

// A string (not a `Blob` instance) body — jsdom's `Blob` global isn't
// `Response`-compatible in this test environment (lacks `.stream()`); a
// string body exercises the same `response.blob()` code path `apiDownload`
// uses for real in the browser.
function csvResponse(): Response {
  return new Response('a,b\n1,2', {
    status: 200,
    headers: { 'content-disposition': 'attachment; filename="matrix-export.csv"' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('DownloadButton', () => {
  it('offers a CSV / XLSX choice and fetches + saves the chosen format with the current filters', async () => {
    const fetchMock = vi.fn((_input: string | URL) => Promise.resolve(csvResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <DownloadButton
        path="/exports/matrix"
        filters={{ hub_id: 'hub-1', category: undefined }}
        fallbackFilename="matrix-export"
      />,
    );

    await user.click(screen.getByRole('button', { name: /download/i }));
    const csvItem = await screen.findByRole('menuitem', { name: 'Download as CSV' });
    await user.click(csvItem);

    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    const [savedBlob, savedFilename] = vi.mocked(saveBlob).mock.calls[0] ?? [];
    expect(savedFilename).toBe('matrix-export.csv');
    expect(await (savedBlob as Blob).text()).toBe('a,b\n1,2');

    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.pathname).toBe('/exports/matrix');
    expect(calledUrl.searchParams.get('hub_id')).toBe('hub-1');
    expect(calledUrl.searchParams.has('category')).toBe(false);
    expect(calledUrl.searchParams.get('format')).toBe('csv');
  });

  it('requests XLSX when that menu item is chosen', async () => {
    const fetchMock = vi.fn((_input: string | URL) => Promise.resolve(csvResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<DownloadButton path="/exports/capacity" fallbackFilename="capacity-export" />);

    await user.click(screen.getByRole('button', { name: /download/i }));
    const xlsxItem = await screen.findByRole('menuitem', { name: 'Download as XLSX' });
    await user.click(xlsxItem);

    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    const calledUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(calledUrl.searchParams.get('format')).toBe('xlsx');
  });

  it('shows an inline message and never calls saveBlob when the export is forbidden (403)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: 'Not permitted' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    const user = userEvent.setup();

    render(<DownloadButton path="/exports/matrix" fallbackFilename="matrix-export" />);

    await user.click(screen.getByRole('button', { name: /download/i }));
    const csvItem = await screen.findByRole('menuitem', { name: 'Download as CSV' });
    await user.click(csvItem);

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not have access/i);
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it('renders nothing when hidden', () => {
    const { container } = render(
      <DownloadButton path="/exports/matrix" fallbackFilename="matrix-export" hidden />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
