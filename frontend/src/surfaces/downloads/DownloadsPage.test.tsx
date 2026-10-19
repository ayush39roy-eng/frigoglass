import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';

const client = { apiGet: vi.fn(), apiDownload: vi.fn() };
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (...a: unknown[]) => client.apiGet(...a),
    apiDownload: (...a: unknown[]) => client.apiDownload(...a),
  };
});
const saveBlob = vi.fn();
vi.mock('@/lib/download', () => ({ saveBlob: (...a: unknown[]) => saveBlob(...a) }));

import DownloadsPage from './DownloadsPage';

const JOBS = [
  {
    id: 'job-1',
    kind: 'matrix',
    format: 'xlsx',
    status: 'completed',
    created_at: '2026-10-18T08:00:00Z',
    completed_at: '2026-10-18T08:00:05Z',
    row_count: 236,
    file_name: 'matrix-export.xlsx',
  },
  {
    id: 'job-2',
    kind: 'gantt',
    format: 'csv',
    status: 'running',
    created_at: '2026-10-18T07:00:00Z',
    completed_at: null,
    row_count: null,
    file_name: 'gantt-export.csv',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DownloadsPage (P13-T15)', () => {
  it('lists the served export jobs (limit 50) and downloads a ready one via the existing route', async () => {
    client.apiGet.mockResolvedValue(JOBS);
    const blob = new Blob(['x']);
    client.apiDownload.mockResolvedValue({ blob, filename: 'matrix-export.xlsx' });
    const user = userEvent.setup();
    renderWithProviders(<DownloadsPage />);

    const rows = await screen.findAllByTestId('export-job-row');
    expect(client.apiGet).toHaveBeenCalledWith('/export-jobs', expect.objectContaining({ query: { limit: 50 } }));
    expect(rows[0]).toHaveTextContent('matrix-export.xlsx');
    expect(rows[0]).toHaveTextContent('Prioritization Matrix');
    expect(rows[0]).toHaveTextContent('Ready');
    expect(rows[0]).toHaveTextContent('236');
    expect(rows[1]).toHaveTextContent('Preparing');
    expect(within(rows[1]).getByText('Not ready yet')).toBeInTheDocument();
    expect(within(rows[1]).queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();

    await user.click(within(rows[0]).getByRole('button', { name: 'Download matrix-export.xlsx' }));
    expect(client.apiDownload).toHaveBeenCalledWith('/exports/jobs/job-1/download', { fallbackFilename: 'matrix-export.xlsx' });
    expect(saveBlob).toHaveBeenCalledWith(blob, 'matrix-export.xlsx');
  });

  it('shows an empty state when the caller has no export jobs', async () => {
    client.apiGet.mockResolvedValue([]);
    renderWithProviders(<DownloadsPage />);
    expect(await screen.findByText('No export jobs yet')).toBeInTheDocument();
  });
});
