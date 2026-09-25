import * as React from 'react';
import type { RouteObject } from 'react-router-dom';

import { AppShell } from '@/components/layout/app-shell';
import { SurfaceFallback } from '@/components/layout/surface-fallback';
import { NotFound, RouteErrorBoundary } from '@/pages/not-found';
import { PlaceholderPage } from '@/pages/placeholder-page';

import {
  AuditLogPage,
  CapacityPage,
  DashboardPage,
  DesignSystemPage,
  GanttPage,
  MatrixPage,
  PlanningPage,
  RegistrationPage,
} from './lazy-surfaces';
import { SURFACES } from './nav';

/**
 * Route table. One route per surface. Built surfaces (P4-T02..T07) are lazy
 * `import()`ed as their own Vite chunk (frontend-builder SKILL — this is what
 * keeps the 400 KB initial budget); unbuilt ones still render <PlaceholderPage>.
 * The path and nav entry never change when a surface is built.
 */

function lazyElement(node: React.ReactNode): React.ReactNode {
  return <React.Suspense fallback={<SurfaceFallback />}>{node}</React.Suspense>;
}

const SURFACE_ELEMENTS: Partial<Record<string, React.ReactNode>> = {
  '/': lazyElement(<DashboardPage />),
  '/capacity': lazyElement(<CapacityPage />),
  '/matrix': lazyElement(<MatrixPage />),
  '/timeline': lazyElement(<GanttPage />),
  '/register': lazyElement(<RegistrationPage />),
  '/planning': lazyElement(<PlanningPage />),
  '/audit-log': lazyElement(<AuditLogPage />),
};

const surfaceRoutes: RouteObject[] = SURFACES.map((surface) => {
  const element = SURFACE_ELEMENTS[surface.path] ?? <PlaceholderPage surface={surface} />;
  return surface.path === '/'
    ? { index: true, element }
    : { path: surface.path.replace(/^\//, ''), element };
});

export const routeObjects: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorBoundary />,
    children: [
      ...surfaceRoutes,
      // Developer route, deliberately absent from SURFACES (and therefore from the
      // sidebar): every primitive in both density zones. See pages/design-system.tsx.
      { path: 'design-system', element: lazyElement(<DesignSystemPage />) },
      { path: '*', element: <NotFound /> },
    ],
  },
];
