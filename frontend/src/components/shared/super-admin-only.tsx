import * as React from 'react';

import { SUPER_ADMIN_ONLY_HINT } from '@/lib/auth/super-admin';
import { cn } from '@/lib/utils';

/**
 * P46 (ADR 0058 D1): wraps a control that is disabled because the action is
 * Super Admin only. A disabled button fires no pointer events, so the tooltip
 * ("Super Admin only") sits on this wrapper, and screen readers get the same
 * text next to the control. When `locked` is false the children render as is.
 */
export function SuperAdminOnly({
  locked,
  children,
  className,
}: {
  locked: boolean;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  if (!locked) return <>{children}</>;
  return (
    <span title={SUPER_ADMIN_ONLY_HINT} data-super-admin-only="true" className={cn('inline-flex items-center', className)}>
      {children}
      <span className="sr-only">{SUPER_ADMIN_ONLY_HINT}</span>
    </span>
  );
}
