import type * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { RegisterRedirect } from './register-redirect';

/** P22-T01: the old Project Registration URLs land on the merged Projects page. */

function Where(): React.JSX.Element {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}${search}`}</p>;
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/register" element={<RegisterRedirect />} />
        <Route path="/register/:projectId" element={<RegisterRedirect />} />
        <Route path="/projects" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c0d9e8f7a65';

describe('RegisterRedirect', () => {
  it('/register → /projects', () => {
    renderAt('/register');
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/projects$/);
  });

  it('/register?edit=<id> keeps the deep link: → /projects?edit=<id>', () => {
    renderAt(`/register?edit=${ID}`);
    expect(screen.getByTestId('where')).toHaveTextContent(`/projects?edit=${ID}`);
  });

  it('/register/<id> → /projects?edit=<id>', () => {
    renderAt(`/register/${ID}`);
    expect(screen.getByTestId('where')).toHaveTextContent(`/projects?edit=${ID}`);
  });
});
