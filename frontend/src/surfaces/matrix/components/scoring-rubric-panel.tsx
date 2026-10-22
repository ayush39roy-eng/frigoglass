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
import { SCORING_SCALE, scoringAnchor } from '@/lib/domain-constants';
import { cn } from '@/lib/utils';

import { POINTS_RULE_COPY } from '../api/types';
import { formatWeight, useScoringModel } from '../scoring-model';

/**
 * Collapsible "Scoring rubric" (P9 contract §8): the 0..5 scale and, per ACTIVE
 * dimension of the served model (P26: display order, any number), its pillar,
 * served weight and, where the deck describes it, what a 1 and a 5 mean. No
 * score is derived from it (Invariant I9). Editing lives in the "Scoring
 * rubric" side sheet opened from the View panel.
 */
export function ScoringRubricPanel(): React.JSX.Element {
  const model = useScoringModel();
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
              {model.dimensions.map((dim) => {
                const anchor = scoringAnchor(dim.key);
                return (
                  <TableRow key={dim.key}>
                    <TableCell className="font-medium text-text">{dim.label}</TableCell>
                    <TableCell className="text-text-muted">{dim.pillar}</TableCell>
                    <TableCell className="text-right" data-numeric="">
                      {formatWeight(dim.weight, dim.scaled_weight)}
                    </TableCell>
                    <TableCell>{anchor ? anchor.low : <span className="text-text-subtle">—</span>}</TableCell>
                    <TableCell>{anchor ? anchor.high : <span className="text-text-subtle">—</span>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="text-2xs text-text-subtle">
            {POINTS_RULE_COPY}{' '}
            {model.total_weight === null ? '' : `Active weights total ${String(model.total_weight)}, shown scaled to 100. `}The weighted score, normalised percentage and band are computed by
            the server (DOMAIN_RULES.md) — this rubric only explains the inputs.
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}
