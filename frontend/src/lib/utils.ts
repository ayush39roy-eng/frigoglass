import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge has to be TOLD about custom theme keys, or it guesses from the
 * class prefix — and it guesses wrong.
 *
 * The density type scale adds `text-display`, `text-h1`, `text-h2`, `text-body`,
 * `text-label` and `text-figure` as FONT SIZES. Out of the box, tailwind-merge sees
 * `text-*` with an unrecognised suffix and classifies it as a text COLOUR. It then
 * treats `text-display` and `text-feature-fg` as conflicting members of one group and
 * drops the earlier one — so
 *
 *     cn('text-display', feature ? 'text-feature-fg' : 'text-text')
 *
 * silently rendered the KPI figure at inherited 14px instead of 34px, with no error
 * and no warning. Every density-aware size token was affected wherever it appeared
 * alongside a text colour, which is essentially everywhere.
 *
 * Declaring the two groups explicitly restores the intended behaviour: a size and a
 * colour no longer conflict, and two sizes still do.
 *
 * If you add a font size or a text colour to tailwind.config.ts, add it here too.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // Density-aware font sizes (tailwind.config.ts → theme.extend.fontSize).
      'font-size': [{ text: ['display', 'h1', 'h2', 'body', 'label', 'figure', '2xs'] }],
      // Semantic text colours (tailwind.config.ts → theme.extend.colors).
      'text-color': [
        {
          text: [
            'text',
            'muted',
            'subtle',
            'inverse',
            'feature-fg',
            'feature-muted',
            'primary-fg',
            'primary-subtle-fg',
            'danger-fg',
            'danger-subtle-fg',
            'warning-fg',
            'warning-subtle-fg',
            'success-fg',
            'success-subtle-fg',
            'accent-subtle-fg',
          ],
        },
      ],
    },
  },
});

/** Merge conditional class names, de-duplicating conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
