import * as React from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { CardInfo } from '@/components/ui/card-info';
import { cn } from '@/lib/utils';

/**
 * The ONE card pattern of the plan import (P32-R05 C2 clean-up): a header with an icon chip,
 * a title and a one-line hint, an optional info popover (the detail that used to be a
 * paragraph) and optional actions on the right, then the body. Same spacing everywhere.
 */
export function FeatureCard({
  icon: Icon,
  title,
  hint,
  info,
  actions,
  children,
  className,
  bodyClassName,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: React.ReactNode;
  /** Sentences for the info popover ("About <title>"). */
  info?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  testId?: string;
}): React.JSX.Element {
  const headingId = React.useId();
  return (
    <Card className={cn('min-w-0', className)} role="region" aria-labelledby={headingId} data-testid={testId}>
      <div className="flex flex-wrap items-start gap-s3 border-b-2 border-border px-card py-s3">
        <span
          className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary-subtle text-primary-subtle-fg"
          aria-hidden="true"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 id={headingId} className="text-sm font-semibold leading-tight text-text">
            {title}
          </h4>
          {hint ? <p className="mt-0.5 text-2xs text-text-muted">{hint}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-s2">{actions}</div> : null}
        {info ? <CardInfo label={`About ${title.toLowerCase()}`}>{info}</CardInfo> : null}
      </div>
      {children ? <CardContent className={cn('space-y-s3', bodyClassName)}>{children}</CardContent> : null}
    </Card>
  );
}

/**
 * The sticky action bar at the foot of each step (Compute plan / Save as scenario / Back to
 * review). Stays in view while the planner scrolls a long table.
 */
export function ActionBar({
  children,
  label,
  testId,
}: {
  children: React.ReactNode;
  label: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label={label}
      className="sticky bottom-0 z-10 -mx-s2 flex flex-wrap items-center gap-s2 rounded-card border-2 border-border-strong/60 bg-surface px-s3 py-s2 shadow-pop"
      data-testid={testId}
    >
      {children}
    </div>
  );
}
