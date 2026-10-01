import * as React from 'react';
import { History, MessageSquare, Pencil, Trash2 } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatTimestamp } from '@/lib/format';
import { ConfirmDialog } from '@/surfaces/planning/components/confirm-dialog';

import type { ActivityItem, CommentRead } from '../api/types';
import { fetchActivity } from '../api/workspace-api';
import { useCommentMutations } from '../hooks/use-workspace';
import { activityKey, activityTime, canStillEdit, commentErrorMessage } from '../lib/comments';
import { MarkdownText } from '../lib/markdown';
import { authorLabel, WITHHELD } from '../lib/people';
import { CommentComposer } from './comment-composer';

/**
 * Activity & Comments — one reverse-chronological feed mixing comments and
 * system events (from the audit log), because "why did this slip?" is usually
 * answered by a comment next to the event that caused it. Comment bodies are
 * rendered from `body_md` by `MarkdownText` (React elements only — never
 * `dangerouslySetInnerHTML`). Authors edit for 15 minutes; deletes are soft.
 * While OQ#8 is open, `/users/mention-search` returns [] so `@name` stays plain
 * text, and every other person's name is withheld (`lib/people.ts`).
 */
export function ActivityPanel({
  projectId,
  initial,
  canWrite,
  currentUserId,
  canModerate,
}: {
  projectId: string;
  initial: ActivityItem[];
  canWrite: boolean;
  currentUserId: string | null;
  /** Admin / Super Admin may delete anyone's comment. */
  canModerate: boolean;
}): React.JSX.Element {
  const { create, edit, remove } = useCommentMutations(projectId);
  const [older, setOlder] = React.useState<ActivityItem[]>([]);
  const [exhausted, setExhausted] = React.useState(initial.length < 50);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<CommentRead | null>(null);

  const feed = React.useMemo(() => {
    const seen = new Set<string>();
    return [...initial, ...older].filter((i) => {
      const k = activityKey(i);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [initial, older]);

  const loadOlder = async () => {
    const last = feed[feed.length - 1];
    if (!last) return;
    setLoadingOlder(true);
    try {
      const page = await fetchActivity(projectId, { before: activityTime(last), limit: 50 });
      setOlder((prev) => [...prev, ...page]);
      if (page.length < 50) setExhausted(true);
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity &amp; comments</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {canWrite ? (
          <div>
            <CommentComposer
              label="New comment"
              submitLabel="Comment"
              busy={create.isPending}
              onSubmit={async (body) => {
                setCreateError(null);
                try {
                  await create.mutateAsync(body);
                } catch (err) {
                  setCreateError(commentErrorMessage(err, 'The comment could not be posted.'));
                  throw err; // the composer keeps the draft on failure
                }
              }}
            />
            {createError ? (
              <p role="alert" className="text-2xs text-danger">
                {createError}
              </p>
            ) : null}
          </div>
        ) : null}

        {feed.length === 0 ? (
          <EmptyState title="No activity yet" description="Comments and system events (status changes, uploads, recalculations) appear here." />
        ) : (
          <ol className="space-y-2" aria-label="Activity feed, newest first">
            {feed.map((item) =>
              item.kind === 'event' ? (
                <li key={activityKey(item)} className="flex gap-2 text-2xs text-text-muted" data-testid="activity-event">
                  <History className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    <span className="text-text">{item.summary}</span>
                    {' · '}
                    {item.actor_name === null ? `Actor ${WITHHELD.charAt(0).toLowerCase()}${WITHHELD.slice(1)}` : `${item.actor_name} (you)`} · <time dateTime={item.occurred_at}>{formatTimestamp(item.occurred_at)}</time>
                  </span>
                </li>
              ) : (
                <CommentItem
                  key={activityKey(item)}
                  comment={item.comment}
                  canWrite={canWrite}
                  currentUserId={currentUserId}
                  canDelete={canWrite && (item.comment.author_user_id === currentUserId || canModerate)}
                  onEdit={(bodyMd) => edit.mutateAsync({ commentId: item.comment.id, bodyMd })}
                  editBusy={edit.isPending}
                  onDelete={() => setDeleteTarget(item.comment)}
                />
              ),
            )}
          </ol>
        )}
        {!exhausted && feed.length > 0 ? (
          <div className="flex justify-center">
            <Button type="button" variant="secondary" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? 'Loading…' : 'Load older activity'}
            </Button>
          </div>
        ) : null}
      </CardContent>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title="Delete this comment?"
        description="The comment is removed from the feed. It is soft-deleted and stays in the audit trail."
        busy={remove.isPending}
        onConfirm={() => {
          if (deleteTarget) void remove.mutateAsync(deleteTarget.id).finally(() => setDeleteTarget(null));
        }}
      />
    </Card>
  );
}

function CommentItem({
  comment,
  canWrite,
  currentUserId,
  canDelete,
  onEdit,
  editBusy,
  onDelete,
}: {
  comment: CommentRead;
  canWrite: boolean;
  currentUserId: string | null;
  canDelete: boolean;
  onEdit: (bodyMd: string) => Promise<unknown>;
  editBusy: boolean;
  onDelete: () => void;
}): React.JSX.Element {
  const [editing, setEditing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const editable = canWrite && canStillEdit(comment);

  return (
    <li className="rounded-lg border border-border bg-surface-raised px-3 py-2" data-testid="activity-comment">
      <div className="flex items-center gap-2 text-2xs text-text-muted">
        <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="font-medium text-text">{authorLabel(comment.author_name, comment.author_user_id, currentUserId)}</span>
        <time dateTime={comment.created_at}>{formatTimestamp(comment.created_at)}</time>
        {comment.edited_at ? <span>(edited)</span> : null}
        <span className="ml-auto flex gap-1">
          {editable && !editing ? (
            <Button type="button" variant="ghost" size="icon" className="size-6" aria-label="Edit comment" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
            </Button>
          ) : null}
          {canDelete ? (
            <Button type="button" variant="ghost" size="icon" className="size-6" aria-label="Delete comment" onClick={onDelete}>
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <div className="mt-1">
          <CommentComposer
            label="Edit comment"
            initial={comment.body_md}
            submitLabel="Save"
            busy={editBusy}
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              setError(null);
              try {
                await onEdit(body);
                setEditing(false);
              } catch (err) {
                // EDIT_LOCKED / NOT_AUTHOR (403) get readable copy.
                setError(commentErrorMessage(err, 'The comment could not be saved.'));
                setEditing(false);
              }
            }}
          />
        </div>
      ) : (
        <MarkdownText source={comment.body_md} className="mt-1 text-sm text-text" />
      )}
      {error ? (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
