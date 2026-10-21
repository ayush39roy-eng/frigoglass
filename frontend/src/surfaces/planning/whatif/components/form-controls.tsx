import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** A native `<select>` in the design-system input skin. Native on purpose: a
 *  scenario has many rows and a native control is keyboard- and AT-complete. */
export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-8 w-full rounded border border-border-strong bg-surface px-2 text-sm text-text',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger',
        className,
      )}
      {...props}
    />
  ),
);
NativeSelect.displayName = 'NativeSelect';

/** Label + control + inline error, wired with ids so the error is announced. */
export function Field({
  id,
  label,
  error,
  hint,
  className,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string;
  className?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => React.ReactNode;
}): React.JSX.Element {
  const descId = error || hint ? `${id}-desc` : undefined;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <Label htmlFor={id} className="text-2xs text-text-muted">
        {label}
      </Label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': descId })}
      {error ? (
        <p id={descId} role="alert" className="text-2xs font-medium text-danger-subtle-fg">
          {error}
        </p>
      ) : hint ? (
        <p id={descId} className="text-2xs text-text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <Input inputMode="decimal" autoComplete="off" {...props} />;
}
