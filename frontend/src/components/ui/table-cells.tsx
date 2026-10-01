import * as React from 'react';
import { Link } from 'react-router-dom';
import { EllipsisVertical, type LucideIcon } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/**
 * Rich table cells (2026-10-01, client reference "table-01"): an icon-in-a-circle
 * + title/subtitle cell, a thin progress cell, and a per-row ⋮ action menu.
 * Adapted from the shadcn reference to this app's tokens — no stock avatars
 * (engineer/person data is GDPR personal data, CLAUDE.md), no raw colours.
 */

export interface EntityCellProps {
  icon: LucideIcon;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Tailwind classes for the icon disc (background + foreground pair). */
  iconClassName?: string;
  /** Optional link target for the title. */
  to?: string;
  titleAttr?: string;
}

export function EntityCell({
  icon: Icon,
  title,
  subtitle,
  iconClassName = 'bg-primary-subtle text-primary-subtle-fg',
  to,
  titleAttr,
}: EntityCellProps): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-s3">
      <span
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-full ring-1 ring-inset ring-black/5',
          iconClassName,
        )}
        aria-hidden="true"
      >
        <Icon className="size-[18px]" />
      </span>
      <span className="min-w-0">
        {to ? (
          <Link
            to={to}
            title={titleAttr}
            className="block truncate text-sm font-semibold text-text underline-offset-2 hover:text-primary hover:underline"
          >
            {title}
          </Link>
        ) : (
          <span className="block truncate text-sm font-semibold text-text" title={titleAttr}>
            {title}
          </span>
        )}
        {subtitle ? (
          <span className="block truncate text-xs font-medium text-text-subtle">{subtitle}</span>
        ) : null}
      </span>
    </span>
  );
}

export interface ProgressCellProps {
  /** 0–100. Presentation only; the caller passes an already-known ratio. */
  value: number;
  /** Tailwind background class for the fill. */
  fillClassName?: string;
  label?: React.ReactNode;
  ariaLabel: string;
}

export function ProgressCell({
  value,
  fillClassName = 'bg-primary',
  label,
  ariaLabel,
}: ProgressCellProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <span className="flex w-full min-w-0 items-center gap-s3">
      <span
        className="relative h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-surface-sunken"
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0 origin-left rounded-full animate-grow-x',
            fillClassName,
          )}
          style={{ width: `${String(clamped)}%` }}
        />
      </span>
      {label ? (
        <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums text-text-muted" data-numeric="">
          {label}
        </span>
      ) : null}
    </span>
  );
}

export interface RowAction {
  label: string;
  icon: LucideIcon;
  to?: string;
  onSelect?: () => void;
}

export function RowActions({ actions, label }: { actions: RowAction[]; label: string }): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="grid size-8 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-sunken hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label={label}
      >
        <EllipsisVertical className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {actions.map((action) =>
          action.to ? (
            <DropdownMenuItem key={action.label} asChild className="gap-s3">
              <Link to={action.to}>
                <action.icon className="size-4" aria-hidden="true" />
                {action.label}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={action.label}
              className="gap-s3"
              {...(action.onSelect ? { onSelect: action.onSelect } : {})}
            >
              <action.icon className="size-4" aria-hidden="true" />
              {action.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
