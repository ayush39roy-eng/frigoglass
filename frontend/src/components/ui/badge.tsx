import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs font-medium leading-none [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-border-strong bg-surface-sunken text-text-muted',
        primary: 'border-transparent bg-primary-subtle text-primary-subtle-fg',
        danger: 'border-transparent bg-danger-subtle text-danger-subtle-fg',
        warning: 'border-transparent bg-warning-subtle text-warning-subtle-fg',
        success: 'border-transparent bg-success-subtle text-success-subtle-fg',
        outline: 'border-border-strong bg-transparent text-text',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
