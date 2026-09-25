import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * Buttons carry the ACTION half of the two-colour system, so every filled variant is
 * blue or a status hue — never petrol, which is reserved for structure.
 *
 * Three deliberate changes from the first build:
 *  - Bigger. The old md was 32px tall; 36px is comfortable for a mouse without
 *    pushing toolbars taller, and the sm step now clears the 28px floor rather than
 *    sitting under it.
 *  - `rounded-control` (12px) instead of the 6px default, matching the card radius.
 *    A pill-radius button next to a 16px card is the detail that reads as "designed".
 *  - A resting shadow and a 1px lift on hover for the filled variants only. Outline
 *    and ghost stay flat: a ghost button that lifts looks like a bug, because there
 *    is no visible object to lift.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-s2 whitespace-nowrap rounded-control font-medium transition-[background-color,box-shadow,transform,border-color] duration-fast ease-ease-out-expo focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-fg shadow-card hover:bg-primary-hover hover:shadow-hover active:translate-y-px active:shadow-card',
        secondary:
          'border border-border-strong bg-surface text-text shadow-card hover:border-primary/40 hover:bg-surface-raised hover:text-primary',
        // Tinted fill — the "soft" button in the references. Reads as an action
        // without competing with the primary on the same row.
        soft: 'bg-primary-subtle text-primary-subtle-fg hover:bg-primary/15',
        ghost: 'text-text-muted hover:bg-surface-sunken hover:text-text',
        danger:
          'bg-danger text-danger-fg shadow-card hover:opacity-90 hover:shadow-hover active:translate-y-px',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-s3 text-xs',
        md: 'h-9 px-s4 text-sm',
        lg: 'h-10 px-s5 text-sm',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
