import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * The Tailwind theme is a thin projection of the SEMANTIC token layer
 * (src/styles/tokens.css). No raw colour values live here — every colour is a
 * `hsl(var(--color-*) / <alpha-value>)` reference so tokens stay the single source
 * of truth and dark mode is a pure token re-point with zero config duplication.
 */

function withAlpha(token: string): string {
  return `hsl(var(--${token}) / <alpha-value>)`;
}

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
    },
    extend: {
      colors: {
        canvas: withAlpha('color-canvas'),
        surface: {
          DEFAULT: withAlpha('color-surface'),
          raised: withAlpha('color-surface-raised'),
          sunken: withAlpha('color-surface-sunken'),
        },
        border: {
          DEFAULT: withAlpha('color-border'),
          strong: withAlpha('color-border-strong'),
        },
        ring: withAlpha('color-ring'),
        text: {
          DEFAULT: withAlpha('color-text'),
          muted: withAlpha('color-text-muted'),
          subtle: withAlpha('color-text-subtle'),
          inverse: withAlpha('color-text-inverse'),
        },
        primary: {
          DEFAULT: withAlpha('color-primary'),
          hover: withAlpha('color-primary-hover'),
          fg: withAlpha('color-primary-fg'),
          subtle: withAlpha('color-primary-subtle'),
          'subtle-fg': withAlpha('color-primary-subtle-fg'),
        },
        danger: {
          DEFAULT: withAlpha('color-danger'),
          fg: withAlpha('color-danger-fg'),
          subtle: withAlpha('color-danger-subtle'),
          'subtle-fg': withAlpha('color-danger-subtle-fg'),
        },
        warning: {
          DEFAULT: withAlpha('color-warning'),
          fg: withAlpha('color-warning-fg'),
          subtle: withAlpha('color-warning-subtle'),
          'subtle-fg': withAlpha('color-warning-subtle-fg'),
        },
        success: {
          DEFAULT: withAlpha('color-success'),
          fg: withAlpha('color-success-fg'),
          subtle: withAlpha('color-success-subtle'),
          'subtle-fg': withAlpha('color-success-subtle-fg'),
        },
        accent: {
          DEFAULT: withAlpha('color-accent'),
          'subtle-fg': withAlpha('color-accent-subtle-fg'),
        },
        // Dashboard-only content tokens (Boltshift rebuild, 2026-10-01). See the
        // "BOLTSHIFT LAYER" note in tokens.css — consumed ONLY by
        // surfaces/dashboard/components/*, never by the shared Card/GlassPanel
        // used by every other surface.
        dash: {
          hairline: withAlpha('color-dash-hairline'),
          edge: withAlpha('color-dash-edge'),
          alt: withAlpha('color-dash-alt'),
        },
        dashChart: {
          1: withAlpha('dash-cat-1'),
          2: withAlpha('dash-cat-2'),
          3: withAlpha('dash-cat-3'),
          4: withAlpha('dash-cat-4'),
          5: withAlpha('dash-cat-5'),
          6: withAlpha('dash-cat-6'),
          7: withAlpha('dash-cat-7'),
          8: withAlpha('dash-cat-8'),
          9: withAlpha('dash-cat-9'),
          10: withAlpha('dash-cat-10'),
        },
        // Structural hue. The sidebar rail and its furniture — never an action.
        sidebar: {
          DEFAULT: withAlpha('color-sidebar'),
          raised: withAlpha('color-sidebar-raised'),
          border: withAlpha('color-sidebar-border'),
          text: withAlpha('color-sidebar-text'),
          'text-muted': withAlpha('color-sidebar-text-muted'),
          active: withAlpha('color-sidebar-active'),
          'active-fg': withAlpha('color-sidebar-active-fg'),
        },
        petrol: {
          50: withAlpha('petrol-50'),
          100: withAlpha('petrol-100'),
          200: withAlpha('petrol-200'),
          300: withAlpha('petrol-300'),
          400: withAlpha('petrol-400'),
          500: withAlpha('petrol-500'),
          600: withAlpha('petrol-600'),
          700: withAlpha('petrol-700'),
          800: withAlpha('petrol-800'),
          900: withAlpha('petrol-900'),
        },
        // Bold Blocks layer (tokens.css): shell ground, ink feature card, lime/red delta pills.
        shell: withAlpha('color-shell'),
        ink: {
          DEFAULT: withAlpha('color-ink'),
          raised: withAlpha('color-ink-raised'),
          fg: withAlpha('color-ink-fg'),
        },
        pop: {
          DEFAULT: withAlpha('color-pop'),
          fg: withAlpha('color-pop-fg'),
        },
        drop: {
          DEFAULT: withAlpha('color-drop'),
          fg: withAlpha('color-drop-fg'),
        },
        // The single emphasised dark tile per screen.
        feature: {
          DEFAULT: withAlpha('color-feature'),
          fg: withAlpha('color-feature-fg'),
          muted: withAlpha('color-feature-muted'),
        },
        band: {
          p1: withAlpha('color-band-p1'),
          p2: withAlpha('color-band-p2'),
          p3: withAlpha('color-band-p3'),
          p4: withAlpha('color-band-p4'),
          q: withAlpha('color-band-q'),
        },
        // Categorical chart ramp. Assigned to series ORDERED BY VALUE, never by
        // category index — the largest series is always the darkest, so the ranking
        // is readable before the axis is. Carries no status meaning.
        chart: {
          1: withAlpha('chart-1'),
          2: withAlpha('chart-2'),
          3: withAlpha('chart-3'),
          4: withAlpha('chart-4'),
          5: withAlpha('chart-5'),
          6: withAlpha('chart-6'),
          grid: withAlpha('chart-grid'),
          axis: withAlpha('chart-axis-text'),
          'tooltip-bg': withAlpha('chart-tooltip-bg'),
          'tooltip-text': withAlpha('chart-tooltip-text'),
        },
        gantt: {
          planned: withAlpha('color-gantt-planned'),
          'planned-frozen': withAlpha('color-gantt-planned-frozen'),
          actual: withAlpha('color-gantt-actual'),
          delay: withAlpha('color-gantt-delay'),
          grid: withAlpha('color-gantt-grid'),
          'marker-year': withAlpha('color-gantt-marker-year'),
          'marker-now': withAlpha('color-gantt-marker-now'),
          // P9 completion lines — see tokens.css.
          expected: withAlpha('color-gantt-expected'),
          projected: withAlpha('color-gantt-projected'),
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        md: 'var(--radius)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        card: 'var(--radius-card)',
        panel: 'var(--radius-panel)',
        control: 'var(--radius-control)',
        pill: 'var(--radius-pill)',
        // Boltshift shell chrome (app-shell/app-sidebar) + Dashboard content cards.
        shell: 'var(--radius-shell)',
        rail: 'var(--radius-rail)',
        dash: 'var(--radius-dash)',
      },
      fontFamily: {
        // 'Plus Jakarta Sans Variable' / 'Inter Variable' / 'JetBrains Mono Variable'
        // are the family names the fontsource packages register
        // (src/styles/fonts.css). Before this, `Inter` was named here but never
        // actually loaded, so every screen silently rendered in system-ui —
        // correct-looking on a Mac, wrong everywhere else.
        //
        // 2026-10-01 (Boltshift): Plus Jakarta Sans replaces Inter as the primary
        // UI face app-wide (spec §3, "500/600/700 for UI + headings", no surface
        // carve-out). Inter Variable stays second in the stack as the fallback
        // face — see fonts.css's header comment.
        sans: [
          'Plus Jakarta Sans Variable',
          'Inter Variable',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono Variable',
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
        // Follows the density zone: Space Grotesk on Overview, Inter on Working.
        display: 'var(--font-display)',
      },
      fontSize: {
        // Restrained scale tied to the rpd-visual-bar SKILL: xs for cells/badges,
        // sm for body, base for section headers, lg/xl for page titles only.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],

        // DENSITY-AWARE STEPS. These resolve differently under
        // [data-density="overview"] vs [data-density="working"], so a component
        // styled `text-body` re-tunes itself when moved between zones with no prop.
        // The literal Tailwind steps (text-sm, text-xs, ...) are deliberately left
        // untouched so the 250-odd existing files keep their current sizing until
        // each is migrated deliberately.
        page: ['var(--text-page)', { lineHeight: '1.1', fontWeight: '800', letterSpacing: '-0.025em' }],
        display: ['var(--text-display)', { lineHeight: '1', fontWeight: '800', letterSpacing: '-0.03em' }],
        h1: ['var(--text-h1)', { lineHeight: 'var(--leading-heading)', fontWeight: '700', letterSpacing: '-0.015em' }],
        h2: ['var(--text-h2)', { lineHeight: 'var(--leading-heading)', fontWeight: '700', letterSpacing: '-0.01em' }],
        body: ['var(--text-body)', { lineHeight: 'var(--leading-body)' }],
        label: [
          'var(--text-label)',
          { lineHeight: '1.3', fontWeight: '600', letterSpacing: 'var(--tracking-label)' },
        ],
        figure: ['var(--text-mono)', { lineHeight: '1.35' }],
      },
      spacing: {
        header: 'var(--app-header-h)',
        sidebar: 'var(--app-sidebar-w)',
        'sidebar-collapsed': 'var(--app-sidebar-w-collapsed)',

        // 4px base grid, density-invariant.
        s1: 'var(--s1)',
        s2: 'var(--s2)',
        s3: 'var(--s3)',
        s4: 'var(--s4)',
        s5: 'var(--s5)',
        s6: 'var(--s6)',
        s7: 'var(--s7)',
        s8: 'var(--s8)',
        s9: 'var(--s9)',
        s10: 'var(--s10)',

        // Density-aware rhythm.
        card: 'var(--card-pad)',
        'card-tight': 'var(--card-pad-tight)',
        gutter: 'var(--grid-gutter)',
        row: 'var(--row-h)',
        'row-compact': 'var(--row-h-compact)',
        stack: 'var(--stack)',
      },
      maxWidth: {
        content: 'var(--content-max)',
      },
      boxShadow: {
        // One elevation level for interaction, one for true overlays. Resting cards
        // use their border and nothing else.
        card: 'var(--shadow-card)',
        hover: 'var(--shadow-hover)',
        overlay: 'var(--shadow-overlay)',
        // Boltshift shell chrome + Dashboard content cards (see tokens.css).
        shell: 'var(--shadow-shell)',
        pop: 'var(--shadow-pop)',
        ctaBlue: 'var(--shadow-cta-blue)',
        dashCard: 'var(--shadow-dash-card)',
        feature: 'var(--shadow-feature)',
        ink: 'var(--shadow-ink)',
      },
      transitionDuration: {
        instant: 'var(--dur-instant)',
        fast: 'var(--dur-fast)',
        base: 'var(--dur-base)',
        slow: 'var(--dur-slow)',
      },
      transitionTimingFunction: {
        'ease-out-expo': 'var(--ease-out)',
        'ease-in-out-quint': 'var(--ease-in-out)',
      },
      keyframes: {
        'grow-x': {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' },
        },
        'grow-y': {
          from: { transform: 'scaleY(0)' },
          to: { transform: 'scaleY(1)' },
        },
        'row-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'grow-x': 'grow-x 900ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'grow-y': 'grow-y 700ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'row-in': 'row-in 420ms cubic-bezier(0.16, 1, 0.3, 1) both',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
