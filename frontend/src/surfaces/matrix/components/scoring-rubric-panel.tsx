import * as React from 'react';
import { BookOpenText, ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SCORING_ANCHORS, SCORING_SCALE } from '@/lib/domain-constants';
import { cn } from '@/lib/utils';

import { DIMENSIONS } from '../api/types';

/**
 * Collapsible "Scoring rubric" (P9 contract §8): the 1..5 scale and, per
 * dimension, what a 1 and a 5 mean. Static copy from the deck's "Scoring
 * Logic" slide via `domain-constants.ts` — the API is not involved and no
 * score is derived from it (Invariant I9).
 */
export function ScoringRubricPanel(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const bodyId = React.useId();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-s2">
          <BookOpenText className="size-4 text-text-muted" aria-hidden="true" />
          Scoring rubric
        </CardTitle>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide rubric' : 'Show rubric'}
          <ChevronDown className={cn('transition-transform duration-fast', open && 'rotate-180')} aria-hidden="true" />
        </Button>
      </CardHeader>
      {open ? (
        <CardContent id={bodyId} className="space-y-s3">
          <dl className="flex flex-wrap gap-x-s4 gap-y-1 text-2xs text-text-muted" aria-label="Score scale">
            {SCORING_SCALE.map((s) => (
              <div key={s.score} className="flex items-center gap-1">
                <dt className="font-mono font-semibold text-text" data-numeric="">
                  {s.score}
                </dt>
                <dd>{s.label}</dd>
              </div>
            ))}
          </dl>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Dimension</TableHead>
                <TableHead>Pillar</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead>1 — Negligible</TableHead>
                <TableHead>5 — Exceptional</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {DIMENSIONS.map((dim) => {
                const anchor = SCORING_ANCHORS[dim.field];
                return (
                  <TableRow key={dim.field}>
                    <TableCell className="font-medium text-text">{dim.label}</TableCell>
                    <TableCell className="text-text-muted">{dim.pillar}</TableCell>
                    <TableCell className="text-right" data-numeric="">
                      {dim.weight}
                    </TableCell>
                    <TableCell>{anchor.low}</TableCell>
                    <TableCell>{anchor.high}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="text-2xs text-text-subtle">
            Weights total 280; the weighted score, normalised percentage and band are computed by
            the server (DOMAIN_RULES.md) — this rubric only explains the inputs.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
