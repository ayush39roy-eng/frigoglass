import * as React from 'react';
import { MessageSquareText, Pencil, SendHorizontal, TriangleAlert } from 'lucide-react';

import { RunProgressStatus } from '@/components/shared/run-progress-status';
import { EmptyState } from '@/components/shared/empty-state';
import { BookingStatusChip } from '@/components/shared/booking-status-chip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBookedPct } from '@/lib/format';
import { IDLE_RUN_FOLLOW } from '@/lib/use-schedule-run-follow';
import type { RunFollowState } from '@/lib/use-schedule-run-follow';

import type {
  AskResponse,
  CapacitySnapshotResponse,
  ChatScenario,
  ToolName,
  ToolRunOut,
} from '../../api/whatif-types';
import { describeScenario } from '../describe-scenario';
import { classifyWhatIfError, useAsk, type WhatIfErrorInfo } from '../use-whatif';
import { EstimateView } from './estimate-view';
import { SimulateView } from './simulate-view';
import { SolveView } from './solve-view';
import { EXAMPLE_PROMPTS } from './chat-prompts';
import { int, num } from './figures';
import { SectionHeading, WorkingsDisclosure, ScopeNote } from './result-parts';
import { WhatIfErrorNotice } from './whatif-error';

const MAX_QUESTION = 1000;

/** Fixed text (ADR 0031, S18-I1): the question and the scenario figures go to the AI provider. */
export const CHAT_EGRESS_HINT =
  'Do not type names, customers or prices — questions are sent to the AI provider (see settings)';

const TOOL_TITLE: Record<ToolName, string> = {
  estimate_requirements: 'Estimate',
  simulate_scenario: 'Simulation',
  find_minimum_additions: 'Fewest additions',
  get_capacity_snapshot: 'Current capacity',
};

interface TranscriptEntry {
  id: number;
  question: string;
  /** The scenario of the previous answer that was sent along for refinement. */
  priorScenario: ChatScenario | null;
  status: 'pending' | 'done' | 'failed';
  response?: AskResponse;
  error?: WhatIfErrorInfo;
  errorToken?: number;
}

function SnapshotView({ data }: { data: CapacitySnapshotResponse }): React.JSX.Element {
  return (
    <div className="space-y-s2" data-testid="chat-snapshot">
      <ScopeNote scope={data.scope} />
      <Table scrollLabel="Current capacity by hub" aria-label="Current capacity by hub">
        <TableHeader>
          <TableRow>
            <TableHead>Hub</TableHead>
            <TableHead className="text-right">Designer FTE</TableHead>
            <TableHead>Design booked (year)</TableHead>
            <TableHead>Lab booked (year)</TableHead>
            <TableHead className="text-right">Chambers</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.hubs.map((h) => (
            <TableRow key={h.hub}>
              <TableCell className="font-medium">{h.hub}</TableCell>
              <TableCell className="text-right tabular-nums">{num(h.engineer_fte_total)}</TableCell>
              <TableCell>
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <span className="font-mono tabular-nums">{formatBookedPct(h.design_booked_pct_year)}</span>
                  <BookingStatusChip status={h.design_booking_status_year} />
                </span>
              </TableCell>
              <TableCell>
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <span className="font-mono tabular-nums">{formatBookedPct(h.lab_booked_pct_year)}</span>
                  <BookingStatusChip status={h.lab_booking_status_year} />
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">{int(h.chambers.length)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ToolResult({ run }: { run: ToolRunOut }): React.JSX.Element {
  const title = TOOL_TITLE[run.tool];
  return (
    <details open className="rounded-md border border-border p-s3" data-testid="chat-tool-result" data-tool={run.tool}>
      <summary className="cursor-pointer rounded text-xs font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Engine result: {title}
      </summary>
      <div className="mt-s3">
        {run.error ? (
          <p className="text-xs text-warning-subtle-fg" data-testid="chat-tool-error">
            Could not run: {run.error}
          </p>
        ) : null}
        {run.result?.kind === 'estimate' ? <EstimateView data={run.result} /> : null}
        {run.result?.kind === 'simulation' ? <SimulateView data={run.result} /> : null}
        {run.result?.kind === 'solution' ? <SolveView data={run.result} /> : null}
        {run.result?.kind === 'capacity_snapshot' ? <SnapshotView data={run.result} /> : null}
      </div>
    </details>
  );
}

function AnswerBlock({
  response,
  onEdit,
}: {
  response: AskResponse;
  onEdit: (scenario: ChatScenario) => void;
}): React.JSX.Element {
  const lines = response.scenario ? describeScenario(response.scenario) : [];
  const hasEngineWorkings = response.results.some(
    (r) => r.result?.kind === 'estimate' || r.result?.kind === 'simulation' || r.result?.kind === 'solution',
  );
  return (
    <div className="space-y-s3" data-testid="chat-answer">
      {/* Model text is plain text only: never HTML, never markdown-to-HTML. */}
      <p className="whitespace-pre-wrap break-words text-sm text-text" data-testid="chat-answer-text">
        {response.answer}
      </p>
      {response.refused ? (
        <p className="text-2xs text-text-muted" data-testid="chat-refused">
          The assistant only answers capacity and project scenario questions.
        </p>
      ) : null}
      {!response.grounded ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning-subtle px-s3 py-s2 text-xs text-warning-subtle-fg"
          data-testid="chat-ungrounded"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            Not verified: the wording above could not be checked against the engine, so rely on the figures below, not
            the text.
            {response.ungrounded_numbers.length > 0
              ? ` Numbers that could not be matched: ${response.ungrounded_numbers.join(', ')}.`
              : ''}
          </span>
        </div>
      ) : null}
      {response.truncated ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning-subtle px-s3 py-s2 text-xs text-warning-subtle-fg"
          data-testid="chat-truncated"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>The assistant stopped at its step limit, so this answer and its results may be incomplete.</span>
        </div>
      ) : null}

      {response.scenario ? (
        <section className="space-y-s2 rounded-md border border-border bg-surface-sunken/40 p-s3" data-testid="chat-scenario">
          <div className="flex flex-wrap items-center justify-between gap-s2">
            <SectionHeading>Scenario the assistant built</SectionHeading>
            <Button type="button" size="sm" variant="secondary" onClick={() => onEdit(response.scenario as ChatScenario)}>
              <Pencil />
              Edit in builder
            </Button>
          </div>
          {lines.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-s5 text-xs text-text-muted">
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-muted">An empty scenario (no changes).</p>
          )}
        </section>
      ) : null}

      {response.results.map((run, i) => (
        <ToolResult key={`${run.tool}-${String(i)}`} run={run} />
      ))}
      {!hasEngineWorkings ? <WorkingsDisclosure lines={response.workings} title="Workings" /> : null}
    </div>
  );
}

export interface ChatPanelProps {
  /** "Edit in builder": the page loads the scenario into the form. */
  onEditInBuilder: (scenario: ChatScenario) => void;
}

/**
 * "Ask the planner". Stateless on the server: the transcript below lives only
 * in this component's memory. Only the previous answer's scenario is sent back,
 * so a follow-up can refine it (`prior_scenario`).
 */
export function ChatPanel({ onEditInBuilder }: ChatPanelProps): React.JSX.Element {
  const ask = useAsk();
  const [text, setText] = React.useState('');
  const [transcript, setTranscript] = React.useState<TranscriptEntry[]>([]);
  const [unavailable, setUnavailable] = React.useState(false);
  const idRef = React.useRef(0);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  const pending = transcript.some((t) => t.status === 'pending');
  const lastScenario = React.useMemo(() => {
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      const s = transcript[i]?.response?.scenario;
      if (s) return s;
    }
    return null;
  }, [transcript]);

  const send = React.useCallback(
    (question: string, priorScenario: ChatScenario | null, reuseId?: number) => {
      const id = reuseId ?? (idRef.current += 1);
      const patch = (p: Partial<TranscriptEntry>) =>
        setTranscript((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t)));
      if (reuseId === undefined) {
        setTranscript((prev) => [...prev, { id, question, priorScenario, status: 'pending' }]);
      } else {
        patch({ status: 'pending' });
      }
      ask.mutate(
        { question, ...(priorScenario ? { prior_scenario: priorScenario } : {}) },
        {
          onSuccess: (response) => patch({ status: 'done', response }),
          onError: (error) => {
            const info = classifyWhatIfError(error, 'ask');
            if (info.kind === 'agent_unavailable') {
              setUnavailable(true);
              setTranscript((prev) => prev.filter((t) => t.id !== id));
              return;
            }
            patch({ status: 'failed', error: info, errorToken: Date.now() });
          },
        },
      );
    },
    [ask],
  );

  const submit = (): void => {
    const q = text.trim();
    if (q === '' || pending || q.length > MAX_QUESTION) return;
    setText('');
    send(q, lastScenario);
  };

  const progress: RunFollowState = pending
    ? { phase: 'running', percent: null, message: 'The planner is working on your question…' }
    : IDLE_RUN_FOLLOW;

  return (
    <Card data-testid="whatif-chat">
      <CardHeader>
        <CardTitle>Ask the planner</CardTitle>
        {transcript.length > 0 ? (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setTranscript([])}>
            Clear conversation
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-s4">
        {unavailable ? (
          <div
            role="status"
            className="rounded-md border border-border-strong bg-surface-sunken px-s4 py-s3 text-sm text-text"
            data-testid="chat-unavailable"
          >
            Chat is not configured; use the forms.
          </div>
        ) : (
          <>
            <p className="text-xs text-text-muted">
              Describe a change in plain words. The assistant builds a scenario and runs the same engine as the forms;
              every figure comes from the engine, and the scenario is shown so you can edit it. Nothing is saved.
            </p>
            <div className="flex flex-wrap gap-2" aria-label="Example questions" role="group">
              {EXAMPLE_PROMPTS.map((p) => (
                <Button
                  key={p}
                  type="button"
                  size="sm"
                  variant="soft"
                  className="h-auto whitespace-normal py-1.5 text-left"
                  onClick={() => {
                    setText(p);
                    inputRef.current?.focus();
                  }}
                >
                  {p}
                </Button>
              ))}
            </div>

            <div className="space-y-1">
              <Label htmlFor="whatif-chat-input" className="text-2xs text-text-muted">
                Your question
              </Label>
              <textarea
                id="whatif-chat-input"
                ref={inputRef}
                value={text}
                maxLength={MAX_QUESTION}
                rows={3}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submit();
                  }
                }}
                className="flex w-full rounded border border-border-strong bg-surface px-2.5 py-2 text-sm text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                aria-describedby="whatif-chat-hint whatif-chat-egress"
              />
              <p id="whatif-chat-egress" className="text-2xs font-medium text-text-muted" data-testid="chat-egress-hint">
                {CHAT_EGRESS_HINT}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-s2">
                <p id="whatif-chat-hint" className="text-2xs text-text-subtle">
                  {lastScenario
                    ? 'Follow-ups refine the scenario from the last answer. '
                    : ''}
                  Press Ctrl or Cmd + Enter to send. {text.length}/{MAX_QUESTION}
                </p>
                <Button type="button" size="sm" disabled={pending || text.trim() === ''} onClick={submit}>
                  <SendHorizontal />
                  Ask
                </Button>
              </div>
            </div>
          </>
        )}

        <RunProgressStatus state={progress} />

        {transcript.length === 0 && !unavailable ? (
          <EmptyState
            media={<MessageSquareText />}
            title="No questions yet"
            description="Pick an example above or type your own. The conversation is kept in this page only."
          />
        ) : null}

        <ol className="space-y-s5" aria-label="Conversation">
          {transcript.map((t) => (
            <li key={t.id} className="space-y-s3" data-testid="chat-turn">
              <p className="rounded-md bg-primary-subtle px-s3 py-s2 text-sm text-primary-subtle-fg">
                <span className="sr-only">You asked: </span>
                {t.question}
              </p>
              {t.status === 'done' && t.response ? (
                <AnswerBlock response={t.response} onEdit={onEditInBuilder} />
              ) : null}
              {t.status === 'failed' && t.error ? (
                <WhatIfErrorNotice
                  info={t.error}
                  errorToken={t.errorToken}
                  onRetry={() => send(t.question, t.priorScenario, t.id)}
                  retryLabel="Retry this question"
                />
              ) : null}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
