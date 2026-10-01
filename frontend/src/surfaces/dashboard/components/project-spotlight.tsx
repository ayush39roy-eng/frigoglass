import * as React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Building2, TriangleAlert } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { categoricalRankSoftBg, categoricalRankText, categoryRank } from '@/lib/categorical-palette';
import { formatInteger, formatWeek } from '@/lib/format';
import { useMotionTokens } from '@/lib/motion';
import { cn } from '@/lib/utils';

import type { CompletingWithinYearRow } from '../api/types';
import { OUTCOME_STYLE, outcomeOf } from '../lib/outcome';
import { CardInfo } from '@/components/ui/card-info';

/**
 * PROJECT SPOTLIGHT — the client's "course-design-cards" reference pattern,
 * rebuilt as a real RPD feature.
 *
 * The reference component was a generic marketing grid: colour-coded cards, a
 * date, a title, a subtitle, a labelled progress bar, an avatar stack and a
 * "2 days left" pill. Mapping onto this domain, element by element:
 *
 *  - date → `last_step_end_week`, the week the project's last scheduled step
 *    ends in the active run. Rendered VERBATIM (`W47`) rather than converted
 *    into a countdown: "weeks remaining" would be `52 − last_step_end_week`,
 *    arithmetic this surface is not allowed to perform (Invariant I9 /
 *    CLAUDE.md "no independent calculation anywhere, including in the
 *    frontend"). The reference's "2 days left" pill therefore has no honest
 *    equivalent and is OMITTED rather than faked.
 *  - title → `project_name`, linking into the Project Workspace, same target
 *    the Project breakdown table's name column already uses.
 *  - subtitle → hub + category + priority, as chips.
 *  - progress bar → how far into the 78-week horizon the project's last step
 *    lands, with the real figure (`W47 of 78 weeks`) beside it. The bar's
 *    LENGTH is a ratio used for drawing only; the number a reader takes away is
 *    the raw week, straight off the row.
 *  - bar colour → the project's schedule outcome, using the EXISTING outcome
 *    colour semantics (`lib/outcome.ts`), never a new palette.
 *  - avatar stack → overlapping hub / category / priority ICON chips. Two
 *    reasons, and only the first is a style choice. (1) `docs/
 *    OPEN_QUESTIONS.md` #8 records per-engineer data as a *blocking* GDPR
 *    determination pending DPO sign-off for real employees in Greece and
 *    Romania, so no named engineer is wired into any UI; a decorative avatar
 *    representing nobody would be allowed, but it would also be the only
 *    element on this surface that means nothing. (2) HARD CONSTRAINT: this app
 *    is delivered on-premise, behind Frigoglass's corporate network
 *    (CLAUDE.md). Hotlinked Unsplash / CDN avatar imagery would render as
 *    broken images on the client's own servers, which have no guaranteed
 *    egress to the public internet. Every asset this surface draws is local.
 *
 * Capped at `MAX_CARDS` with a "View all" hand-off into the full, virtualized,
 * server-filtered Project breakdown table below — 236 projects is far past the
 * point where a card grid is a worse table.
 */

const MAX_CARDS = 6;

/** Fallback when `/schedule-runs/active` has not resolved — the horizon is a
 *  DOMAIN_RULES.md constant, and the run's own `horizon_weeks` is preferred
 *  whenever it is available. */
const DEFAULT_HORIZON_WEEKS = 78;

export interface ProjectSpotlightProps {
  rows: CompletingWithinYearRow[];
  /** `ScheduleRunSummary.horizon_weeks` from the active run, when loaded. */
  horizonWeeks: number | null | undefined;
}

interface SpotlightCardProps {
  row: CompletingWithinYearRow;
  horizonWeeks: number;
  index: number;
}

function SpotlightCard({ row, horizonWeeks, index }: SpotlightCardProps): React.JSX.Element {
  const motionTokens = useMotionTokens();
  const bucket = outcomeOf(row);
  const style = OUTCOME_STYLE[bucket];
  const week = row.last_step_end_week;
  const pct =
    week === null || horizonWeeks <= 0 ? 0 : Math.min(100, Math.round((week / horizonWeeks) * 100));

  const mountProps = motionTokens.reduced
    ? {}
    : {
        initial: { opacity: 0, y: 16, scale: 0.985 },
        animate: { opacity: 1, y: 0, scale: 1 },
        transition: { type: 'spring' as const, stiffness: 300, damping: 30, delay: index * 0.05 },
        whileHover: { y: -3 },
        whileTap: { scale: 0.96 },
      };

  return (
    <motion.div {...mountProps} className="h-full">
      {/* Deliberately NOT `interactive`: that variant adds its own
          `hover:-translate-y-px`, which would stack on top of the framer hover
          above and give the card two competing lifts. The shadow half of the
          treatment is applied directly instead. */}
      <BoltCard className="flex h-full cursor-pointer flex-col gap-s3 p-card hover:shadow-pop">
        <div className="flex items-center justify-between gap-s2">
          <span
            className="inline-flex items-center rounded-pill bg-dash-alt px-2.5 py-1 text-2xs font-semibold tabular-nums text-text-muted"
            data-numeric=""
          >
            {week === null ? 'Not scheduled' : formatWeek(week)}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-2xs font-semibold',
              style.chip,
            )}
          >
            <style.Icon className="size-3" aria-hidden="true" />
            {style.label}
          </span>
        </div>

        <div className="min-w-0 space-y-s2">
          <h3 className="truncate text-body font-semibold leading-snug text-text">
            <Link
              to={`/projects/${row.project_id}`}
              className="rounded-sm underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={`${row.project_name} — open in Project Workspace`}
            >
              {row.project_name}
            </Link>
          </h3>
          {/* Hub only. Category and priority are carried by the chip stack in the
              footer — stating all three twice on one 300px card was exactly the
              redundancy the client asked us to strip. */}
          <p className="truncate text-2xs text-text-muted">{row.hub}</p>
        </div>

        <div className="mt-auto space-y-1.5">
          <div className="flex items-baseline justify-between gap-s2">
            <span className="label-caps text-text-subtle">Scheduled through</span>
            <span className="tnum text-2xs font-semibold text-text" data-numeric="">
              {week === null
                ? '—'
                : `${formatWeek(week)} of ${formatInteger(horizonWeeks)} weeks`}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-pill bg-dash-alt">
            <motion.div
              className={cn('h-full rounded-pill', style.track)}
              initial={motionTokens.reduced ? false : { width: 0 }}
              animate={{ width: `${String(pct)}%` }}
              transition={{
                ...motionTokens.transition,
                delay: motionTokens.reduced ? 0 : 0.12 + index * 0.05,
              }}
            />
          </div>
        </div>

        {/* The reference's avatar stack, as meaningful chips: overlapping circles
            whose "initials" are the project's REAL category band and priority
            band, tinted by the same deterministic category palette the tables
            use, beside a hub glyph. Same geometry as the reference; none of the
            circles is a person. */}
        <div className="flex items-center justify-between gap-s2 border-t border-dash-hairline pt-s3">
          <span className="flex items-center -space-x-1.5" aria-hidden="true">
            <span
              className="grid size-7 place-items-center rounded-full border-2 border-surface bg-primary-subtle text-primary-subtle-fg"
              title={row.hub}
            >
              <Building2 className="size-3.5" />
            </span>
            {row.category ? (
              <span
                className={cn(
                  'grid size-7 place-items-center rounded-full border-2 border-surface text-[10px] font-bold',
                  categoricalRankSoftBg(categoryRank(row.category)),
                  categoricalRankText(categoryRank(row.category)),
                )}
                title={`Category ${row.category}`}
              >
                {row.category}
              </span>
            ) : null}
            {row.priority ? (
              <span
                className="grid size-7 place-items-center rounded-full border-2 border-surface bg-dash-alt text-[10px] font-bold text-text-muted"
                title={`Priority ${row.priority}`}
              >
                {row.priority}
              </span>
            ) : null}
          </span>
          <span className="sr-only">
            Hub {row.hub}
            {row.category ? `, category ${row.category}` : ''}
            {row.priority ? `, priority ${row.priority}` : ''}
          </span>
          {/* A real flag off the row, not decoration: the leader's allowed
              categories exclude this project's category (a warning, not a
              scheduling block — see `schedule-outcome-meta.ts`). */}
          {row.cat_not_allowed ? (
            <span className="inline-flex items-center gap-1 rounded-pill bg-warning-subtle px-2 py-0.5 text-2xs font-medium text-warning-subtle-fg">
              <TriangleAlert className="size-3" aria-hidden="true" />
              Cat. not allowed
            </span>
          ) : null}
        </div>
      </BoltCard>
    </motion.div>
  );
}

export function ProjectSpotlight({
  rows,
  horizonWeeks,
}: ProjectSpotlightProps): React.JSX.Element {
  const horizon = horizonWeeks ?? DEFAULT_HORIZON_WEEKS;
  const shown = rows.slice(0, MAX_CARDS);

  return (
    /* Section, not a card — the spotlight cards ARE the cards. Same rule as
       `status-overview-cards.tsx` / `within-year-panel.tsx`: never nest a card
       inside a card (docs/MEMORY.md 2026-10-01). */
    <Card className="border-0 bg-transparent shadow-none">
      <CardHeader className="flex-wrap border-0 px-0">
        <CardTitle className="text-h1">Project spotlight</CardTitle>
        <span
          className="inline-flex items-center rounded-pill bg-dash-alt px-2.5 py-1 text-2xs font-medium tabular-nums text-text-muted"
          data-numeric=""
        >
          {formatInteger(shown.length)} of {formatInteger(rows.length)}
        </span>
        <CardInfo label="Project spotlight source">
          <p>
            The first {MAX_CARDS} projects of the active schedule run, in the order the API returns
            them (<code>GET /dashboard/completing-within-year</code>) — no ranking is applied here.
          </p>
          <p>
            Each card&apos;s week, outcome, hub, category and priority are fields on that
            project&apos;s own row. The bar shows where its last scheduled step lands inside the{' '}
            {formatInteger(horizon)}-week horizon; no remaining-time countdown is shown, because
            that figure is not one the API provides (Invariant I9).
          </p>
          <p>
            The circular chips are hub, category and priority — not people. Engineer-level data is
            blocked pending the GDPR determination in{' '}
            <code>docs/OPEN_QUESTIONS.md</code> #8.
          </p>
        </CardInfo>
        {/* A plain in-page anchor, not a react-router `<Link>`: the target is a
            section of THIS page, so the browser's native hash scroll (and the
            focus move that comes with it) is the correct behaviour — routing to
            a path of "#project-breakdown" is not. */}
        <a
          href="#project-breakdown"
          className="ml-auto inline-flex items-center gap-1 rounded-pill border border-dash-hairline bg-surface px-3 py-1.5 text-2xs font-semibold text-text transition-colors duration-fast ease-ease-out-expo hover:bg-dash-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          View all projects
          <ArrowRight className="size-3" aria-hidden="true" />
        </a>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {shown.length === 0 ? (
          <EmptyState title="No projects in this run" description="Nothing to spotlight yet." />
        ) : (
          <div className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((row, index) => (
              <SpotlightCard
                key={row.project_id}
                row={row}
                horizonWeeks={horizon}
                index={index}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
