import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';

import { ThemeProvider } from '@/components/theme/theme-provider';
import { createQueryClient } from '@/lib/query-client';

import { routeObjects } from './routes';

const queryClient = createQueryClient();
const router = createBrowserRouter(routeObjects);

export function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
