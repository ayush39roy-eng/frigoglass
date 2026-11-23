/** P61 (ADR 0069): the plan surfaces that show the freshness banner and the
 *  header Recalculate — Dashboard, Projects (+ Workspace), Capacity, Matrix /
 *  Priority board, Gantt. */
const PLAN_SURFACE_PATHS = ['/projects', '/capacity', '/matrix', '/timeline'] as const;

export function isPlanSurfacePath(pathname: string): boolean {
  if (pathname === '/') return true;
  return PLAN_SURFACE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
