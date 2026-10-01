/**
 * Re-export shim: `BarChart` moved to `@/components/ui/bar-chart` in P9-T04 so
 * the Capacity surface can share it. Dashboard imports keep working unchanged.
 */
export { BarChart } from '@/components/ui/bar-chart';
export type { BarChartProps, BarDatum, BarTone } from '@/components/ui/bar-chart';
