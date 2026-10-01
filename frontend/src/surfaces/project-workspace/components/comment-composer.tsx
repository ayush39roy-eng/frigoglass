import * as React from 'react';

import { Button } from '@/components/ui/button';
import { formatInteger } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { cn } from '@/lib/utils';

import { COMMENT_MAX_CHARS } from '../api/types';
import { useMentionSearch } from '../hooks/use-workspace';
import { COMMENT_LIMIT_TEXT, mentionQueryAt } from '../lib/comments';

/**
 * Markdown comment box with `@mention` autocomplete (ARIA combobox + listbox).
 * Candidates come from `GET /users/mention-search`; while OQ#8 withholds them
 * the list is simply empty and `@text` stays plain text — nothing breaks.
 */
export function CommentComposer({
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
  busy,
  label,
}: {
  initial?: string;
  submitLabel: string;
  onSubmit: (bodyMd: string) => Promise<unknown>;
  onCancel?: () => void;
  busy: boolean;
  label: string;
}): React.JSX.Element {
  const [text, setText] = React.useState(initial);
  const [caret, setCaret] = React.useState(initial.length);
  const [active, setActive] = React.useState(0);
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  // Caret to restore after inserting a mention — applied in a layout effect
  // right after that render, so a fast next keystroke cannot land before it.
  const pendingCaret = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    if (pendingCaret.current === null || !ref.current) return;
    const at = pendingCaret.current;
    pendingCaret.current = null;
    ref.current.focus();
    ref.current.setSelectionRange(at, at);
  }, [text]);
  const listId = React.useId();
  const inputId = React.useId();

  const mention = mentionQueryAt(text, caret);
  const q = useDebouncedValue(mention?.query ?? '', 200);
  const search = useMentionSearch(mention && dismissed !== mention.query ? q : '');
  const options = mention && dismissed !== mention.query ? (search.data ?? []) : [];
  const open = options.length > 0;

  const choose = (display: string) => {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${display} ${text.slice(caret)}`;
    const nextCaret = mention.start + display.length + 2;
    pendingCaret.current = nextCaret;
    setText(next);
    setCaret(nextCaret);
    setActive(0);
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || body.length > COMMENT_MAX_CHARS) return;
    try {
      await onSubmit(body);
    } catch {
      // The parent shows the error (429, 422, EDIT_LOCKED …). Keep the draft so
      // nothing typed is lost, and don't leave an unhandled rejection behind.
      return;
    }
    setText('');
    setCaret(0);
  };

  // P9-R03: the server caps `body_md` at 10 000 chars (422 beyond). `maxLength`
  // stops typing past it; the counter appears as the limit nears.
  const length = text.length;
  const nearLimit = length >= COMMENT_MAX_CHARS * 0.9;
  const overLimit = length > COMMENT_MAX_CHARS;
  const counterId = `${inputId}-count`;

  return (
    <div className="relative space-y-1.5">
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <textarea
        id={inputId}
        ref={ref}
        rows={3}
        value={text}
        maxLength={COMMENT_MAX_CHARS}
        aria-describedby={counterId}
        placeholder="Write a comment — Markdown and @mentions supported"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${String(active)}` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setDismissed(null);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => (a + 1) % options.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a - 1 + options.length) % options.length);
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            const opt = options[active];
            if (opt) {
              e.preventDefault();
              choose(opt.display);
            }
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDismissed(mention?.query ?? null);
          }
        }}
        className="w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {open ? (
        <ul id={listId} role="listbox" aria-label="Mention suggestions" className="absolute z-20 max-h-48 w-64 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-overlay">
          {options.map((o, i) => (
            <li
              key={o.user_id}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={i === active}
              className={cn('cursor-pointer rounded px-2 py-1 text-xs', i === active ? 'bg-primary-subtle text-primary-subtle-fg' : 'text-text')}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o.display);
              }}
            >
              {o.display}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <span
          id={counterId}
          data-testid="comment-counter"
          aria-live={nearLimit ? 'polite' : 'off'}
          className={cn(
            'mr-auto font-mono text-2xs tabular-nums',
            overLimit ? 'text-danger' : nearLimit ? 'text-warning-subtle-fg' : 'text-text-subtle',
          )}
        >
          {formatInteger(length)} / {COMMENT_LIMIT_TEXT}
        </span>
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="button" size="sm" disabled={busy || text.trim() === '' || overLimit} onClick={() => void submit()}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </div>
  );
}
