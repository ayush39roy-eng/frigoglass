/**
 * The chip lists of the Overview resource tables (P19-T04). Display only.
 *
 * - Project types: every value of the engineer `allowed_categories` model,
 *   from the served categories (P33-T14, `CategoryCatalog.eligibilityCodes`):
 *   the PDD categories, the legacy "OEM" (any OEM category on an OEM hub,
 *   DOMAIN_RULES CAT_NOT_ALLOWED) and the OEM-workflow categories, in rank order.
 * - Stages: the lab-kind workflow steps served by `GET /workflow-step-templates`
 *   (the only ids `PATCH /chambers` accepts), plus any id a chamber already
 *   carries that is not in that list, so nothing served is hidden. The client's
 *   PDD-J (pre-production) and PDD-L (pilot) are not lab-kind steps in our
 *   workflow, so they are not offered.
 */
import type { WorkflowStepTemplate } from '@/lib/api/reference';
import type { CategoryCatalog } from '@/lib/category-catalog';
import { OEM_ELIGIBILITY_CODE } from '@/types/enums';

/** Tooltip for an eligibility chip: the reserved `OEM`, or a served label that differs from its code. */
export function categoryChipTitle(code: string, catalog: CategoryCatalog): string | undefined {
  if (code === OEM_ELIGIBILITY_CODE) return 'Any OEM category (OEM hubs)';
  const label = catalog.labelOf(code);
  return label !== code ? label : undefined;
}

export interface StageChip {
  id: string;
  /** Short visible name, e.g. "Proof of concept". */
  short: string;
  /** Full accessible label, e.g. "PDD-F Proof of concept". */
  label: string;
  /** Compact visible text, e.g. "PDD-F · PoC" (the full label is the name and title). */
  compact: string;
}

const SHORT_BY_CODE: Record<string, string> = {
  POC: 'Proof of concept',
  CERT: 'Certification',
};
const ABBR_BY_CODE: Record<string, string> = {
  POC: 'PoC',
  CERT: 'Cert.',
};

function shortName(t: WorkflowStepTemplate & { code?: unknown }): string {
  if (typeof t.code === 'string' && SHORT_BY_CODE[t.code]) return SHORT_BY_CODE[t.code]!;
  return t.name;
}

export function stageChips(
  templates: readonly WorkflowStepTemplate[] | undefined,
  chamberStages: readonly (readonly string[])[],
): StageChip[] {
  const chips: StageChip[] = [];
  const seen = new Set<string>();
  for (const t of templates ?? []) {
    if (t.kind !== 'lab' || seen.has(t.id)) continue;
    seen.add(t.id);
    const short = shortName(t);
    const code = (t as { code?: unknown }).code;
    const abbr = typeof code === 'string' ? ABBR_BY_CODE[code] : undefined;
    chips.push({ id: t.id, short, label: `${t.id} ${short}`, compact: abbr ? `${t.id} · ${abbr}` : t.id });
  }
  for (const list of chamberStages) {
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      chips.push({ id, short: id, label: id, compact: id });
    }
  }
  // The served list is ordered OEM workflow first; the client reads PDD first.
  const rank = (id: string): number => (id.startsWith('PDD-') ? 0 : id.startsWith('OEM-') ? 1 : 2);
  return chips.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}
