/**
 * P21-T03: the score chip's intensity step for a served dimension score.
 * Presentation only: the chip always shows the served number itself, and the
 * step is that score held to the 0..5 rubric range (ADR 0033). Nothing about
 * points, totals or bands is derived here (I9).
 */
export function scoreIntensity(score: number): number {
  return Math.min(5, Math.max(0, Math.round(score)));
}
