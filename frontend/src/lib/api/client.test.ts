import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiDownload, ApiError, apiGet } from './client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiGet', () => {
  it('returns parsed JSON on 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ within_year_count: 9 }))),
    );
    await expect(apiGet('/dashboard/completing-within-year')).resolves.toEqual({
      within_year_count: 9,
    });
  });

  it('drops undefined/null query params and stringifies the rest', async () => {
    const fetchMock = vi.fn((_input: string | URL) =>
      Promise.resolve(jsonResponse({ rows: [] })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await apiGet('/dashboard/projects', {
      query: { status_: 'In Queue', category: undefined, priority: null },
    });
    const called = fetchMock.mock.calls[0]?.[0];
    const url = new URL(typeof called === 'string' ? called : String(called));
    expect(url.pathname).toBe('/dashboard/projects');
    expect(url.searchParams.get('status_')).toBe('In Queue');
    expect(url.searchParams.has('category')).toBe(false);
    expect(url.searchParams.has('priority')).toBe(false);
  });

  it('throws an ApiError carrying the HTTP status and FastAPI detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse({ detail: 'Not permitted' }, { status: 403 })),
      ),
    );
    const err = await apiGet('/dashboard/pipeline-totals').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).isForbidden).toBe(true);
    expect((err as ApiError).detail).toBe('Not permitted');
  });

  it('maps a network failure to ApiError status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const err = await apiGet('/dashboard/pipeline-totals').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
  });
});

describe('apiDownload', () => {
  it('returns the blob and the server Content-Disposition filename on 2xx', async () => {
    // A string (not a `Blob` instance) response body — jsdom's `Blob` global
    // isn't `Response`-compatible in this test environment (it lacks
    // `.stream()`); a string body exercises the exact same `response.blob()`
    // code path `apiDownload` actually uses in the browser.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('a,b\n1,2', {
            status: 200,
            headers: {
              'content-type': 'text/csv',
              'content-disposition': 'attachment; filename="matrix-export.csv"',
            },
          }),
        ),
      ),
    );
    const result = await apiDownload('/exports/matrix', { fallbackFilename: 'fallback.csv' });
    expect(result.filename).toBe('matrix-export.csv');
    expect(await result.blob.text()).toBe('a,b\n1,2');
  });

  it('falls back to the caller-provided filename when there is no Content-Disposition header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('x', { status: 200 }))),
    );
    const result = await apiDownload('/exports/capacity', { fallbackFilename: 'capacity-export.csv' });
    expect(result.filename).toBe('capacity-export.csv');
  });

  it('drops undefined query params, same convention as apiGet', async () => {
    const fetchMock = vi.fn((_input: string | URL) =>
      Promise.resolve(new Response('x', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await apiDownload('/exports/dashboard', {
      query: { hub_id: undefined, category: 'A+', format: 'csv' },
      fallbackFilename: 'dashboard-export.csv',
    });
    const called = fetchMock.mock.calls[0]?.[0];
    const url = new URL(typeof called === 'string' ? called : String(called));
    expect(url.searchParams.has('hub_id')).toBe(false);
    expect(url.searchParams.get('category')).toBe('A+');
    expect(url.searchParams.get('format')).toBe('csv');
  });

  it('throws an ApiError carrying the HTTP status on a non-2xx response (RBAC 403)', async () => {
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
    const err = await apiDownload('/exports/matrix', { fallbackFilename: 'x.csv' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isForbidden).toBe(true);
    expect((err as ApiError).detail).toBe('Not permitted');
  });

  it('maps a network failure to ApiError status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const err = await apiDownload('/exports/matrix', { fallbackFilename: 'x.csv' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
  });
});
