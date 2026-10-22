import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Standard page landmark: title left, actions/filters right, fixed rhythm. Every
 * surface uses this so the eye finds the same landmark in the same place
 * (ui-ux-pro-max SKILL "panel headers").
 */
export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Optional small uppercase line above the title (e.g. the surface group). */
  eyebrow?: string;
  actions?: React.ReactNode;
  /** Optional control pinned top right, on the title's line (e.g. the
   *  Dashboard's country filter, owner ask 2026-10-22). The actions then run
   *  on their own row beneath. */
  aside?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  aside,
  className,
}: PageHeaderProps): React.JSX.Element {
  const heading = (
    <div className="min-w-0 space-y-1">
      {eyebrow ? <p className="label-caps text-primary">{eyebrow}</p> : null}
      {/* text-h1 resolves to 20px on Overview and 17px on Working. A page title
            that stayed 20px on the Matrix would claim the same emphasis as the
            Dashboard's while sitting above four times as much data — the heading
            should recede as the content gets denser, not compete with it. */}
      <h1 className="font-display text-page text-text">{title}</h1>
      {description ? (
        <p className="text-body font-medium text-text-muted">{description}</p>
      ) : null}
    </div>
  );
  const actionRow = actions ? (
    <div className="flex max-w-full flex-wrap shrink-0 items-center gap-s2">
      {actions}
    </div>
  ) : null;
  if (aside) {
    // One compact band (owner ask 2026-10-22): the heading left, and on the
    // right the aside stacked over the actions, both right-aligned.
    return (
      <div
        className={cn(
          "mb-s4 flex flex-wrap items-end justify-between gap-s3",
          className,
        )}
      >
        {heading}
        <div className="flex max-w-full flex-col items-end gap-s2">
          <div className="max-w-full">{aside}</div>
          {actions ? (
            <div className="flex max-w-full flex-wrap items-center justify-end gap-s2">
              {actions}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "mb-s6 flex flex-wrap items-end justify-between gap-s4",
        className,
      )}
    >
      {heading}
      {actionRow}
    </div>
  );
}
