import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() };
});

import { apiGet, apiSend } from '@/lib/api/client';
import {
  createProject,
  fetchHardGateStatus,
  fetchProject,
  fetchProjects,
  submitProject,
  updateProject,
} from './registration-api';
import type { ProjectCreateRequest, ProjectRead } from './types';

const mockApiGet = vi.mocked(apiGet);
const mockApiSend = vi.mocked(apiSend);

afterEach(() => vi.clearAllMocks());

describe('registration-api', () => {
  it('renames filter params to the backend query param names (hub_id/status_/type_)', async () => {
    mockApiGet.mockResolvedValueOnce([]);
    await fetchProjects({
      hubId: 'hub-1',
      category: 'A+',
      status: 'Draft',
      priority: 'P1',
      type: 'NM',
      limit: 500,
      offset: 0,
    });
    expect(mockApiGet).toHaveBeenCalledWith('/projects', {
      query: {
        hub_id: 'hub-1',
        category: 'A+',
        status_: 'Draft',
        priority: 'P1',
        type_: 'NM',
        limit: 500,
        offset: 0,
      },
    });
  });

  it('drops undefined filters (the client strips them from the URL)', async () => {
    mockApiGet.mockResolvedValueOnce([]);
    await fetchProjects({});
    expect(mockApiGet).toHaveBeenCalledWith('/projects', {
      query: {
        hub_id: undefined,
        category: undefined,
        status_: undefined,
        priority: undefined,
        type_: undefined,
        limit: undefined,
        offset: undefined,
      },
    });
  });

  it('requests one project verbatim', async () => {
    mockApiGet.mockResolvedValueOnce({ id: 'p1' } as ProjectRead);
    await fetchProject('p1');
    expect(mockApiGet).toHaveBeenCalledWith('/projects/p1', {});
  });

  it('requests the hard-gate status endpoint verbatim', async () => {
    mockApiGet.mockResolvedValueOnce({ can_leave_draft: false, missing_fields: ['category'] });
    await fetchHardGateStatus('p1');
    expect(mockApiGet).toHaveBeenCalledWith('/projects/p1/hard-gate-status', {});
  });

  it('POSTs the create body to /projects without transformation', async () => {
    const body: ProjectCreateRequest = { name: 'Cooler A', hub_id: 'hub-1' };
    mockApiSend.mockResolvedValueOnce({ id: 'p1', ...body } as unknown as ProjectRead);
    await createProject(body);
    expect(mockApiSend).toHaveBeenCalledWith('POST', '/projects', body);
  });

  it('PATCHes the update body to /projects/{id}', async () => {
    const body = { name: 'Cooler B' };
    mockApiSend.mockResolvedValueOnce({ id: 'p1', ...body } as unknown as ProjectRead);
    await updateProject('p1', body);
    expect(mockApiSend).toHaveBeenCalledWith('PATCH', '/projects/p1', body);
  });

  it('POSTs the submit body to /projects/{id}/submit', async () => {
    mockApiSend.mockResolvedValueOnce({ id: 'p1' } as ProjectRead);
    await submitProject('p1', { target_status: 'In Queue' });
    expect(mockApiSend).toHaveBeenCalledWith('POST', '/projects/p1/submit', {
      target_status: 'In Queue',
    });
  });
});
