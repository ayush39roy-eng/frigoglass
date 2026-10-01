import * as React from 'react';
import { Bot, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

import { ASK_AGENT_QUESTION_MAX_CHARS } from '../api/types';
import { useAskAgent } from '../hooks/use-workspace';
import { askAgentErrorMessage } from '../lib/ask-agent';

/**
 * "Ask the agent" (ADR 0014) — a free-text question about THIS project,
 * answered from data the asker can already see, with financial fields and
 * real engineer names redacted server-side before the question ever leaves
 * the app (never re-derived or re-checked here — the frontend only renders
 * the plain-text answer verbatim, never `dangerouslySetInnerHTML`).
 *
 * Rendered unconditionally on the Workspace — this panel does not hide
 * itself based on the caller's `project_workspace` surface permission,
 * because Ask-the-agent's own gate (`effective_project_access`, ADR 0012)
 * is a DIFFERENT, finer-grained check than the surface-level permission the
 * rest of this page reads from `/me` (a bare grant-only Viewer can ask even
 * without `project_workspace.write`, and — in the documented edge case where
 * a role has literally zero Workspace surface permission at all — could in
 * principle even lack `project_workspace.read`, in which case they would
 * never have reached this page to begin with). Rather than re-deriving that
 * resolver client-side, this panel always renders and lets a 403 from the
 * endpoint itself produce the explicit "you don't have access to ask about
 * this project" state below — the same "let the server's 403 win" pattern
 * `write-gate.tsx` already documents.
 */
export function AskAgentPanel({ projectId }: { projectId: string }): React.JSX.Element {
  const [question, setQuestion] = React.useState('');
  const [answer, setAnswer] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const ask = useAskAgent(projectId);
  const inputId = React.useId();

  const submit = async () => {
    const q = question.trim();
    if (!q || q.length > ASK_AGENT_QUESTION_MAX_CHARS) return;
    setErrorMessage(null);
    setAnswer(null);
    try {
      const res = await ask.mutateAsync(q);
      setAnswer(res.answer);
    } catch (err) {
      setErrorMessage(askAgentErrorMessage(err));
    }
  };

  return (
    <Card className="border-2 border-primary/40 bg-primary-subtle/30 shadow-feature">
      <CardHeader className="border-b-0">
        <CardTitle className="flex items-center gap-s2 text-h1">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-fg">
            <Bot className="size-5" aria-hidden="true" />
          </span>
          Ask the agent
          <span className="ml-auto inline-flex items-center gap-1 rounded-pill bg-primary px-2.5 py-1 text-2xs font-semibold text-primary-fg">
            <Sparkles className="size-3" aria-hidden="true" />
            AI
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-s3">
        <p className="text-sm text-text-muted">
          Ask a question about this project — stage status, schedule, files, anything visible on
          this page. Answers never include financial figures, customer names or engineer names;
          those are never sent to the agent.
        </p>
        <Label htmlFor={inputId} className="sr-only">
          Question for the agent
        </Label>
        <textarea
          id={inputId}
          rows={3}
          value={question}
          maxLength={ASK_AGENT_QUESTION_MAX_CHARS}
          placeholder="e.g. Which stages are behind schedule?"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          className="w-full rounded-lg border-2 border-primary/30 bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex justify-end">
          <Button
            type="button"
            size="lg"
            className="font-semibold shadow-feature"
            disabled={ask.isPending || question.trim() === ''}
            onClick={() => void submit()}
          >
            <Bot aria-hidden="true" />
            {ask.isPending ? 'Asking…' : 'Ask the agent'}
          </Button>
        </div>
        {errorMessage ? (
          <p role="alert" className="text-2xs text-danger">
            {errorMessage}
          </p>
        ) : null}
        {answer ? (
          <div
            role="status"
            data-testid="ask-agent-answer"
            className="whitespace-pre-wrap rounded-lg border border-border bg-surface-raised p-3 text-sm text-text"
          >
            {answer}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
