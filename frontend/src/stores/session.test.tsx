import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { SURFACES } from '@/app/nav';
import { visibleNavGroups } from '@/app/nav-visibility';
import { ReadOnlyNotice, WriteGate } from '@/components/session/write-gate';
import { ApiError } from '@/lib/api/client';
import { renderApp } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { makeMe, seedSession } from '@/test/session';
import { ROLE_NAMES, SURFACE_KEYS, type RoleName } from '@/types/enums';

import { permissionFor, useSessionStore } from './session';

const api = { fetchMe: vi.fn() };
vi.mock('@/lib/api/session', () => ({
  fetchMe: () => api.fetchMe(),
  fetchDevUsers: () => Promise.resolve([]),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.getState().reset();
});

describe('session store', () => {
  it('boots idle, loads /me once, and exposes the resolved permission table verbatim', async () => {
    const me = makeMe({ roles: ['Admin'], permissions: ROLE_MATRIX.Admin });
    api.fetchMe.mockResolvedValue(me);
    expect(useSessionStore.getState().status).toBe('idle');
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().status).toBe('ready');
    expect(useSessionStore.getState().me).toEqual(me);
    expect(api.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('a 401 becomes an "unauthorized" session error, not a crash', async () => {
    api.fetchMe.mockRejectedValue(new ApiError(401, 'unauthorized'));
    await useSessionStore.getState().load();
    expect(useSessionStore.getState().status).toBe('error');
    expect(useSessionStore.getState().errorKind).toBe('unauthorized');
    expect(useSessionStore.getState().me).toBeNull();
  });

  it('permissionFor: no session or a missing surface key is "no access", never undefined', () => {
    expect(permissionFor(null, 'matrix')).toEqual({ read: false, write: false });
    const me = makeMe();
    delete (me.permissions as Partial<typeof me.permissions>).workflow_settings;
    expect(permissionFor(me, 'workflow_settings')).toEqual({ read: false, write: false });
  });
});

describe.each(ROLE_NAMES)('gating for role: %s', (role: RoleName) => {
  const permissions = ROLE_MATRIX[role];

  it('the sidebar lists exactly the surfaces the role can read', () => {
    const me = makeMe({ roles: [role], permissions });
    const visiblePaths = visibleNavGroups(me)
      .flatMap(([, items]) => items)
      .map((i) => i.path)
      .sort();
    const expected = SURFACES.filter((s) => permissions[s.surface].read)
      .map((s) => s.path)
      .sort();
    expect(visiblePaths).toEqual(expected);
  });

  it('write controls render only on surfaces the role can write; read-only notice otherwise', () => {
    seedSession({ roles: [role], permissions });
    render(
      <>
        {SURFACE_KEYS.map((surface) => (
          <section key={surface} aria-label={surface}>
            <WriteGate surface={surface}>
              <button type="button">edit {surface}</button>
            </WriteGate>
            <ReadOnlyNotice surface={surface} />
          </section>
        ))}
      </>,
    );
    for (const surface of SURFACE_KEYS) {
      const region = screen.getByRole('region', { name: surface });
      const button = within(region).queryByRole('button', { name: `edit ${surface}` });
      const notice = within(region).queryByTestId('read-only-notice');
      if (permissions[surface].write) {
        expect(button).toBeInTheDocument();
        expect(notice).not.toBeInTheDocument();
      } else {
        expect(button).not.toBeInTheDocument();
        expect(notice).toBeInTheDocument();
      }
    }
  });
});

describe('route guard', () => {
  it('a direct URL to a surface the role cannot read renders the 403 page, not a blank', async () => {
    renderApp('/audit-log', {
      session: { roles: ['Portfolio Manager'], permissions: ROLE_MATRIX['Portfolio Manager'] },
    });
    expect(await screen.findByTestId('forbidden-page')).toHaveTextContent(
      /does not have access to Audit Log/,
    );
    const nav = screen.getByRole('navigation', { name: 'Surfaces' });
    expect(within(nav).queryByRole('link', { name: 'Audit Log' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Register' })).toBeInTheDocument();
  });

  it('the Project Workspace route is gated on project_workspace', async () => {
    renderApp('/projects/p-1', { session: { roles: ['Auditor'], permissions: ROLE_MATRIX.Auditor } });
    expect(await screen.findByTestId('forbidden-page')).toBeInTheDocument();
  });

  it('a readable Project Workspace route mounts the workspace surface (not the 403 page)', async () => {
    renderApp('/projects/p-1');
    expect(await screen.findByText('Project Workspace')).toBeInTheDocument();
    expect(screen.queryByTestId('forbidden-page')).not.toBeInTheDocument();
  });
});
