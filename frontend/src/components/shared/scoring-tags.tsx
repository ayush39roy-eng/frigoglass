import * as React from 'react';
import { Tag } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { canonicalScoringTags, SCORING_TAGS_HELP } from '@/lib/scoring-tags';
import { cn } from '@/lib/utils';
import { SCORING_TAGS, SCORING_TAG_LABELS, type ScoringTag } from '@/types/enums';

/**
 * P27 (ADR 0038): the Registration "project nature" tags.
 *
 * - `ScoringTagsField`: the checkbox group (any combination) on Project
 *   Registration and the Workspace edit. The value is always in canonical order.
 * - The read view text is `scoringTagsText` in `@/lib/scoring-tags`.
 * - `FromRegistrationHint`: the small "from registration" mark on a dimension
 *   listed in the served `tag_dimension_keys`. Information only: the score stays
 *   editable. The server decides which dimensions are listed (no client map).
 */

export function ScoringTagsField({
  value,
  onChange,
  idPrefix = 'reg-tag',
  disabled = false,
  legendClassName = 'text-xs font-medium text-text',
}: {
  value: readonly ScoringTag[];
  onChange: (next: ScoringTag[]) => void;
  idPrefix?: string;
  disabled?: boolean;
  legendClassName?: string;
}): React.JSX.Element {
  const helpId = `${idPrefix}-help`;
  return (
    <fieldset className="space-y-2" aria-describedby={helpId} data-testid="scoring-tags-field">
      <legend className={legendClassName}>Project nature</legend>
      <p id={helpId} className="text-2xs text-text-subtle">
        {SCORING_TAGS_HELP}
      </p>
      <div className="grid gap-x-3 gap-y-1.5 sm:grid-cols-2">
        {SCORING_TAGS.map((tag) => {
          const checked = value.includes(tag);
          return (
            <label key={tag} className="flex items-center gap-2 text-xs text-text" htmlFor={`${idPrefix}-${tag}`}>
              <Checkbox
                id={`${idPrefix}-${tag}`}
                checked={checked}
                disabled={disabled}
                data-testid={`scoring-tag-${tag}`}
                onCheckedChange={(next) => {
                  const on = next === true;
                  onChange(canonicalScoringTags(on ? [...value, tag] : value.filter((t) => t !== tag)));
                }}
              />
              {SCORING_TAG_LABELS[tag]}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const HINT_TEXT = 'Pre-filled with 5 from the project nature set at Registration; still editable.';

/**
 * The "from registration" hint. `compact` is the dense-grid form (an icon only;
 * the words stay in the accessible name and tooltip). A focusable button so the
 * tooltip is reachable by keyboard.
 */
export function FromRegistrationHint({
  dimensionLabel,
  compact = false,
  className,
}: {
  dimensionLabel: string;
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex shrink-0 items-center gap-0.5 rounded-sm text-2xs font-medium leading-none text-primary-subtle-fg',
            compact ? 'p-0' : 'bg-primary-subtle px-1 py-0.5',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
          aria-label={`${dimensionLabel}: from registration. ${HINT_TEXT}`}
          data-testid="from-registration-hint"
        >
          <Tag className="size-3" aria-hidden="true" />
          {compact ? null : <span aria-hidden="true">from registration</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">
        <span className="block font-semibold">From registration</span>
        <span className="block text-text-inverse/80">{HINT_TEXT}</span>
      </TooltipContent>
    </Tooltip>
  );
}
