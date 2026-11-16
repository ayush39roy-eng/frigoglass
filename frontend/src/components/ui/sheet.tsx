import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Sheet: a side panel built on the Radix Dialog (shadcn/ui pattern). It keeps
 * the Dialog's focus trap, Escape, `aria-modal`, labelled title / description
 * and focus return to the trigger, but slides in from the side, full height,
 * so the page stays visible beside it. The overlay is light on purpose: the
 * content under it is context for what the sheet asks (owner request
 * 2026-11-17, priority-move preview).
 */

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetPortal = DialogPrimitive.Portal;
const SheetClose = DialogPrimitive.Close;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-slate-950/15',
      'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none',
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = 'SheetOverlay';

type SheetSide = 'right' | 'left';

const SIDE_CLASSES: Record<SheetSide, string> = {
  right:
    'inset-y-0 right-0 sm:border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
  left: 'inset-y-0 left-0 sm:border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
};

export interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: SheetSide;
  /** Hide the built-in close (X) button, e.g. while an action is in flight. */
  hideClose?: boolean;
}

const SheetContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  ({ side = 'right', hideClose = false, className, children, ...props }, ref) => (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        data-side={side}
        data-variant="sheet"
        className={cn(
          // Full screen on a phone; a side panel from `sm` up.
          'fixed z-50 flex h-full w-full flex-col gap-4 border-border bg-surface p-5 shadow-lg sm:max-w-xl',
          'data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:animate-none',
          SIDE_CLASSES[side],
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            className="absolute right-3 top-3 rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </SheetPortal>
  ),
);
SheetContent.displayName = 'SheetContent';

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex flex-col gap-1.5 pr-6 text-left', className)} {...props} />;
}
SheetHeader.displayName = 'SheetHeader';

function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn('mt-auto flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}
SheetFooter.displayName = 'SheetFooter';

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-base font-semibold text-text', className)} {...props} />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-sm text-text-muted', className)} {...props} />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
