import * as React from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBookedPct } from '@/lib/format';

import { NativeSelect } from '../../components/form-controls';
import { num } from '../../components/figures';
import { ProjectRowsTable, SectionHeading, type RowColumn } from '../../components/result-parts';
import type { CapacityWindowDef, CapacityWindowFigure, DesignerRow, ImportSimulateResponse } from '../import-types';
import { shortWeekLabel } from '../week-labels';
import { ServedStatusChip } from './status-chip';

function WindowCells({
  windows,
  figures,
}: {
  windows: readonly CapacityWindowDef[];
  figures: readonly CapacityWindowFigure[];
}) {
  return (
    <>
      {windows.map((w) => {
        const f = figures.find((x) => x.key === w.key);
        return (
          <TableCell key={w.key} className="whitespace-nowrap">
            {f ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span className="font-mono tabular-nums">{`${num(f.load_weeks)} / ${num(f.capacity_weeks)}`}</span>
                <span className="font-mono font-semibold tabular-nums">{formatBookedPct(f.booked_pct)}</span>
                <ServedStatusChip status={f.status} />
              </span>
            ) : (
              '—'
            )}
          </TableCell>
        );
      })}
    </>
  );
}

function WindowTable({
  title,
  label,
  windows,
  rows,
}: {
  title: string;
  label: string;
  windows: readonly CapacityWindowDef[];
  rows: {
    key: string;
    name: string;
    extra: string;
    figures: CapacityWindowFigure[];
  }[];
}): React.JSX.Element {
  return (
    <section className="space-y-s2" aria-label={title}>
      <SectionHeading>{title}</SectionHeading>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">Nothing in your scope.</p>
      ) : (
        <div className="rounded-md border border-border">
          <Table aria-label={title}>
            <TableHeader>
              <TableRow>
                <TableHead>{label}</TableHead>
                <TableHead>{label === 'Hub' ? 'FTE' : 'Chambers'}</TableHead>
                {windows.map((w) => (
                  <TableHead key={w.key}>{`${w.label} — load / capacity (wks), booked`}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="font-mono tabular-nums">{r.extra}</TableCell>
                  <WindowCells windows={windows} figures={r.figures} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

export function ResultsCapacity({ result }: { result: ImportSimulateResponse }): React.JSX.Element {
  const cap = result.capacity;
  const options = React.useMemo(
    () => [
      ...Object.keys(cap.weekly.hubs).map((h) => ({
        value: `hub:${h}`,
        label: `Designers — ${h}`,
      })),
      ...Object.keys(cap.weekly.lab_regions).map((r) => ({
        value: `lab:${r}`,
        label: `Lab — ${r}`,
      })),
    ],
    [cap.weekly],
  );
  const [chosen, setChosen] = React.useState<string | null>(null);
  const series = chosen ?? options[0]?.value ?? '';
  const [kind, name] = [series.slice(0, 3), series.slice(4)];
  const data = kind === 'hub' ? cap.weekly.hubs[name] : cap.weekly.lab_regions[name];
  const chartData = React.useMemo(
    () =>
      data
        ? cap.weekly.weeks.map((w, i) => ({
            week: shortWeekLabel(w, result.base_year),
            load: data.load[i] ?? 0,
            capacity: data.capacity[i] ?? 0,
          }))
        : [],
    [data, cap.weekly.weeks, result.base_year],
  );

  const designerColumns: RowColumn<DesignerRow>[] = [
    {
      header: 'Designer',
      cell: (d) => (
        <span className="inline-flex items-center gap-1.5 font-medium">
          {d.name}
          {d.is_new ? <Badge tone="primary">new</Badge> : null}
        </span>
      ),
    },
    { header: 'Hub', cell: (d) => d.hub },
    {
      header: 'FTE',
      cell: (d) => <span className="font-mono tabular-nums">{num(d.fte)}</span>,
    },
    ...cap.windows.map((w): RowColumn<DesignerRow> => ({
      header: `${w.label} — booked effort / available (wks)`,
      cell: (d) => {
        const f = d.windows.find((x) => x.key === w.key);
        return f ? (
          <span className="inline-flex flex-wrap items-center gap-1.5 whitespace-nowrap">
            <span
              className="font-mono tabular-nums"
              title={
                f.booked_span_weeks !== undefined ? `${num(f.booked_span_weeks)} calendar weeks booked` : undefined
              }
            >{`${num(f.booked_weeks)} / ${num(f.available_weeks)}`}</span>
            {f.booked_span_weeks !== undefined ? (
              <span className="text-2xs text-text-muted">{`(${num(f.booked_span_weeks)} cal. wks)`}</span>
            ) : null}
            <span className="font-mono font-semibold tabular-nums">{formatBookedPct(f.booked_pct)}</span>
            <ServedStatusChip status={f.status} />
          </span>
        ) : (
          '—'
        );
      },
    })),
  ];

  return (
    <div className="space-y-s5" data-testid="import-capacity">
      <WindowTable
        title="Design capacity by hub"
        label="Hub"
        windows={cap.windows}
        rows={cap.hubs.map((h) => ({
          key: h.hub,
          name: h.hub,
          extra: num(h.fte),
          figures: h.windows,
        }))}
      />
      <WindowTable
        title="Lab capacity by region"
        label="Lab region"
        windows={cap.windows}
        rows={cap.lab_regions.map((r) => ({
          key: r.region,
          name: r.region,
          extra: String(r.chambers),
          figures: r.windows,
        }))}
      />

      <section className="space-y-s2" aria-label="Weekly load against capacity">
        <SectionHeading>Weekly load against capacity</SectionHeading>
        {options.length === 0 ? (
          <p className="text-xs text-text-muted">No weekly series in your scope.</p>
        ) : (
          <>
            <div className="flex max-w-xs flex-col gap-1">
              <Label htmlFor="import-cap-series" className="text-2xs text-text-muted">
                Hub or lab region
              </Label>
              <NativeSelect id="import-cap-series" value={series} onChange={(e) => setChosen(e.target.value)}>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <figure
              className="h-72 w-full"
              aria-label={`Weekly load and capacity, ${name}`}
              data-testid="import-cap-chart"
            >
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke="hsl(var(--color-gantt-grid))" vertical={false} />
                  <XAxis dataKey="week" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis tick={{ fontSize: 10 }} width={36} />
                  <Tooltip formatter={(v) => (typeof v === 'number' ? num(v) : String(v))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="load" name="Load (weeks)" fill="hsl(var(--color-primary))" isAnimationActive={false} />
                  <Line
                    dataKey="capacity"
                    name="Capacity (weeks)"
                    stroke="hsl(var(--color-gantt-marker-year))"
                    dot={false}
                    strokeWidth={2}
                    type="stepAfter"
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </figure>
          </>
        )}
      </section>

      <section className="space-y-s2" aria-label="Designers">
        <SectionHeading>Designers</SectionHeading>
        {cap.designers.length === 0 ? (
          <p className="text-xs text-text-muted">No designers in your scope.</p>
        ) : (
          <ProjectRowsTable rows={cap.designers} columns={designerColumns} rowKey={(d) => d.ref} label="Designers" />
        )}
      </section>
    </div>
  );
}
