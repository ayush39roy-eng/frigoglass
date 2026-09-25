import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Standard page landmark: title left, actions/filters right, fixed rhythm. Every
 * surface uses this so the eye finds the same landmark in the same place
 * (ui-ux-pro-max SKILL "panel headers").
 */
export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps): React.JSX.Element {
  return (
    <div className={cn('mb-stack flex items-start justify-between gap-s4', className)}>
      <div className="min-w-0 space-y-0.5">
        {/* text-h1 resolves to 20px on Overview and 17px on Working. A page title
            that stayed 20px on the Matrix would claim the same emphasis as the
            Dashboard's while sitting above four times as much data — the heading
            should recede as the content gets denser, not compete with it. */}
        <h1 className="text-h1 tracking-tight text-text">{title}</h1>
        {description ? <p className="text-body text-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-s2">{actions}</div> : null}
    </div>
  );
}
