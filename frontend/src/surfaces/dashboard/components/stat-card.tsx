/**
 * The Bold Blocks KPI card now lives in `@/components/ui/kpi-card` so every
 * surface (not just the Dashboard) can use the same feature / ink / plain
 * tiles. Re-exported here so existing Dashboard imports keep working.
 */
export { KpiRow, StatCard } from '@/components/ui/kpi-card';
export type { StatBadge, StatCardProps, StatTone, StatVariant } from '@/components/ui/kpi-card';
