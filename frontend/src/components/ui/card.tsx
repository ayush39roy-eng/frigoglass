import * as React from 'react';

import { cn } from '@/lib/utils';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Adds a hover elevation. Only for cards that are themselves a control — a card
   * that navigates, opens a drawer, or is draggable. A card that merely CONTAINS
   * controls is not interactive and must not lift, or the page reads as a field of
   * floating tiles with no hierarchy.
   */
  interactive?: boolean;
}

/**
 * The card: large radius, hairline border, soft resting lift.
 *
 * Depth here is deliberately quiet — a large-blur shadow at ~4% alpha, not a hard
 * drop shadow. That is what separates the reference dashboards from the templates
 * that imitate them: the shadow is felt rather than seen, so a grid of twelve cards
 * still reads as twelve cards instead of as texture. The border does most of the
 * definition; the shadow only lifts the card off the ground.
 */
const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, interactive = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        // Bold Blocks (2026-10-01): a visible 1.5px border plus the solid 3px
        // bottom lip baked into --shadow-card, so each card reads as its own box.
        'rounded-card border-2 border-border-strong/60 bg-surface text-text shadow-card',
        interactive &&
          'cursor-pointer transition-[box-shadow,transform,border-color] duration-fast ease-ease-out-expo hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop',
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

/** Fixed-height panel header: title left, actions right (ui-ux-pro-max SKILL). */
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex min-h-12 items-center justify-between gap-s3 border-b-2 border-border px-card py-s3',
        className,
      )}
      {...props}
    />
  ),
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3
      ref={ref}
      className={cn('font-display text-h2 font-bold leading-tight tracking-tight text-text', className)}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-body text-text-muted', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-card', className)} {...props} />,
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-center gap-s2 border-t border-border px-card py-s2', className)}
      {...props}
    />
  ),
);
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
