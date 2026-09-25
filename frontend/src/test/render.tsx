import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';

import { routeObjects } from '@/app/routes';
import { ThemeProvider } from '@/components/theme/theme-provider';
import type { ThemePreference } from '@/components/theme/theme-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createQueryClient } from '@/lib/query-client';

/** Render a plain component tree with the providers most components assume. */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: RenderOptions & { theme?: ThemePreference },
): RenderResult {
  const client = createQueryClient();
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <ThemeProvider defaultPreference={options?.theme ?? 'light'}>
        <QueryClientProvider client={client}>
          <TooltipProvider>{children}</TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}

/** Render the real app router (shell + routes) starting at `initialPath`. */
export function renderApp(initialPath = '/'): RenderResult {
  const client = createQueryClient();
  const router = createMemoryRouter(routeObjects, { initialEntries: [initialPath] });
  return render(
    <ThemeProvider defaultPreference="light">
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}
