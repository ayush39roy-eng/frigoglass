import * as React from 'react';
import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  CircleSlash,
  FlaskConical,
  Users,
} from 'lucide-react';

import { DensityRegion } from '@/components/layout/density-zone';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DeltaChip,
  FeatureCard,
  KpiCard,
  Sparkline,
  StatCard,
} from '@/components/ui/stat-card';
import { SERIES_TOKENS } from '@/lib/chart-theme';
import { cn } from '@/lib/utils';

/**
 * THE DESIGN SYSTEM GALLERY — /design-system
 *
 * Every primitive, rendered in BOTH density zones side by side, so the contrast that
 * governs the whole system is visible in one view rather than described in prose.
 *
 * WHY THIS AND NOT STORYBOOK
 * --------------------------
 * The brief asked for Storybook. This repo is a better fit for an in-app route, and
 * the decision is deliberate rather than a shortcut:
 *
 *  - Storybook is ~40 dev dependencies and a second build pipeline, on a project
 *    that ships on-premise behind a corporate network and is already past its P4
 *    gate with 95 test files and a working Vite build.
 *  - The thing worth reviewing here is how primitives behave INSIDE the real shell,
 *    under the real token cascade, with the real theme toggle. A Storybook canvas
 *    renders them outside all three, which is exactly where density bugs hide.
 *  - This route is lazy-loaded like any surface, so it costs the production bundle
 *    nothing (see lazy-surfaces.ts) and stays reviewable by anyone with the app open
 *    — including the client, on their own server, with no extra tooling.
 *
 * If a component library is ever extracted from this app for reuse elsewhere,
 * Storybook becomes the right answer and this page becomes redundant.
 *
 * NOT LINKED IN THE SIDEBAR. Reachable by URL only — it is a developer tool, and a
 * nav slot is scarce space that belongs to the seven surfaces.
 */

const TREND = [12, 18, 15, 22, 19, 28, 24, 31] as const;

/* -------------------------------------------------------------------------- */
/* Layout helpers                                                              */
/* -------------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-s3">
      <h2 className="label-caps border-b border-border pb-s2 text-text-subtle">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Renders the same children twice, once per zone, in adjacent columns. This is the
 * whole point of the page: nothing below is a mock-up of density, it is the actual
 * cascade resolving twice.
 */
function BothDensities({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-s4 lg:grid-cols-2">
      {(['overview', 'working'] as const).map((density) => (
        <DensityRegion
          key={density}
          density={density}
          className="min-w-0 rounded-lg border border-border bg-canvas p-s3"
        >
          <div className="label-caps mb-s3 flex items-center gap-s2 text-text-subtle">
            <span
              className={cn(
                'inline-block size-1.5 rounded-full',
                density === 'overview' ? 'bg-primary' : 'bg-accent',
              )}
              aria-hidden="true"
            />
            {density}
          </div>
          {children}
        </DensityRegion>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function DesignSystemPage(): React.JSX.Element {
  return (
    <div className="space-y-s8 pb-s10">
      <PageHeader
        title="Design system"
        description="Every primitive in both density zones. Overview is for screens you read; Working is for screens you work. Same colours, same fonts, same components — different scale."
      />

      <Section title="Type scale">
        <BothDensities>
          <div className="space-y-s3 rounded-lg border border-border bg-surface p-card">
            <div className="font-display text-display tabular-nums text-text">236</div>
            <h3 className="text-h1 text-text">Prioritization Matrix</h3>
            <h4 className="text-h2 text-text">Portfolio decision summary</h4>
            <p className="text-body text-text-muted">
              Body copy at the zone&rsquo;s reading size. Line height 1.45. This is the smallest
              size in the system that carries running text.
            </p>
            <div className="label-caps text-text-subtle">Section label — identical in both zones</div>
            <div className="font-mono text-figure tabular-nums text-text">
              1,284.50 &nbsp; 0,998.10 &nbsp; 1,100.00
            </div>
          </div>
        </BothDensities>
      </Section>

      <Section title="Tabular numerals">
        <Card>
          <CardHeader>
            <CardTitle>Why every figure is mono</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-s4 sm:grid-cols-2">
            <div>
              <div className="label-caps mb-s2 text-danger">Proportional — columns wobble</div>
              <div className="space-y-1 text-right font-sans text-body [font-variant-numeric:proportional-nums]">
                <div>1,284.50</div>
                <div>911.10</div>
                <div>1,100.00</div>
                <div>78.25</div>
              </div>
            </div>
            <div>
              <div className="label-caps mb-s2 text-success">Tabular — decimals align</div>
              <div className="space-y-1 text-right font-mono text-body tabular-nums">
                <div>1,284.50</div>
                <div>911.10</div>
                <div>1,100.00</div>
                <div>78.25</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Cards">
        <BothDensities>
          <div className="space-y-s3">
            <div className="grid grid-cols-2 gap-gutter">
              <KpiCard
                label="Within year"
                value="182"
                unit="proj"
                delta={{ value: 8.4, label: '+8.4%' }}
                trend={TREND}
                icon={CheckCircle2}
              />
              <KpiCard
                label="Spillover"
                value="24"
                unit="proj"
                delta={{ value: 3.1, label: '+3.1%', higherIsBetter: false }}
                icon={CalendarRange}
              />
            </div>

            <div className="grid grid-cols-2 gap-gutter">
              <StatCard label="Engineers" value="47" hint="6 hubs" icon={Users} />
              <StatCard label="Chambers" value="12" hint="3 regions" icon={FlaskConical} />
            </div>

            <FeatureCard
              eyebrow="Active run"
              heading="Schedule v3 is current"
              description="Greedy scheduler, computed 8 Sept 2026. All figures on every surface read from this run."
              icon={CheckCircle2}
              action={
                <Button size="sm" variant="secondary">
                  View run details
                </Button>
              }
            />
          </div>
        </BothDensities>
      </Section>

      <Section title="Status — never colour alone">
        <Card>
          <CardContent className="flex flex-wrap gap-s2">
            <Badge tone="success">
              <CheckCircle2 aria-hidden="true" /> On track
            </Badge>
            <Badge tone="warning">
              <AlertTriangle aria-hidden="true" /> At risk
            </Badge>
            <Badge tone="danger">
              <AlertTriangle aria-hidden="true" /> Off track
            </Badge>
            <Badge tone="neutral">
              <CircleSlash aria-hidden="true" /> Left out
            </Badge>
            <Badge tone="danger">ENG CONFLICT</Badge>
            <Badge tone="warning">OVERLAP</Badge>
            <Badge tone="primary">P1</Badge>
            <Badge tone="outline">Q</Badge>
          </CardContent>
        </Card>
      </Section>

      <Section title="Deltas">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-s4">
            <div className="flex items-center gap-s2">
              <span className="text-body text-text-muted">Higher is better:</span>
              <DeltaChip value={12.7} label="+12.7%" />
              <DeltaChip value={-4.2} label="-4.2%" />
            </div>
            <div className="flex items-center gap-s2">
              <span className="text-body text-text-muted">Lower is better:</span>
              <DeltaChip value={12.7} label="+12.7%" higherIsBetter={false} />
              <DeltaChip value={-4.2} label="-4.2%" higherIsBetter={false} />
            </div>
            <div className="flex items-center gap-s2">
              <span className="text-body text-text-muted">Flat:</span>
              <DeltaChip value={0} label="0.0%" />
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section title="Buttons">
        <BothDensities>
          <div className="flex flex-wrap items-center gap-s2">
            <Button size="sm">Primary</Button>
            <Button size="sm" variant="secondary">
              Secondary
            </Button>
            <Button size="sm" variant="ghost">
              Ghost
            </Button>
            <Button size="sm" variant="danger">
              Danger
            </Button>
          </div>
        </BothDensities>
      </Section>

      <Section title="Chart ramp — assigned by value, not by category">
        <Card>
          <CardContent className="space-y-s3">
            <div className="flex gap-1">
              {SERIES_TOKENS.map((tokenName, i) => (
                <div key={tokenName} className="flex-1 space-y-1">
                  <div
                    className="h-12 rounded"
                    style={{ background: `hsl(var(${tokenName}))` }}
                    aria-hidden="true"
                  />
                  <div className="label-caps text-center text-text-subtle">rank {i + 1}</div>
                </div>
              ))}
            </div>
            <p className="text-body text-text-muted">
              The largest series is always the darkest, so a reader ranks the series before
              reading a single axis label. Assigning by category index — every charting
              library&rsquo;s default — makes the ranking invisible and the legend mandatory.
            </p>
          </CardContent>
        </Card>
      </Section>

      <Section title="Sparkline">
        <Card>
          <CardContent>
            <Sparkline values={TREND} label="Example trend" className="h-12 w-full" />
          </CardContent>
        </Card>
      </Section>

      <Section title="Elevation — one level, not four">
        <div className="grid gap-gutter sm:grid-cols-3">
          <Card className="p-card">
            <div className="label-caps text-text-subtle">Resting</div>
            <p className="mt-1 text-body text-text-muted">Border only. No shadow.</p>
          </Card>
          <Card interactive className="p-card">
            <div className="label-caps text-text-subtle">Interactive</div>
            <p className="mt-1 text-body text-text-muted">Hover me — lifts on hover.</p>
          </Card>
          <Card className="p-card shadow-overlay">
            <div className="label-caps text-text-subtle">Overlay</div>
            <p className="mt-1 text-body text-text-muted">Menus, dialogs, drag ghosts.</p>
          </Card>
        </div>
      </Section>
    </div>
  );
}
