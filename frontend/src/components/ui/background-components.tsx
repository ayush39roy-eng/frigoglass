import { cn } from "@/lib/utils";

/**
 * Soft radial "glow" layer, keyed off the `--color-primary` token (never a
 * raw hex) so it always tracks the app's existing blue brand colour and
 * needs no light/dark-specific value of its own. `multiply` reads as a glow
 * over a light surface; the near-black dark-mode canvas would multiply that
 * to invisible, so dark mode switches to `screen` (lightens instead) to stay
 * visible both ways. `light` is the subtle, ambient strength meant to sit
 * behind real content (e.g. a dashboard); the stronger default suits a page
 * that IS this background, like the sign-in screen.
 *
 * The parent must establish a positioning context (`relative`) for this
 * `absolute inset-0` layer to fill it.
 */
export function GlowOverlay({
  light = false,
  className,
}: {
  light?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_center,hsl(var(--color-primary))_0%,transparent_70%)] mix-blend-multiply dark:mix-blend-screen",
        light ? "opacity-20" : "opacity-60",
        className,
      )}
    />
  );
}

/**
 * Full-bleed page wrapper combining `GlowOverlay` with a canvas background
 * and a content layer — for a page that IS this background end to end (e.g.
 * the sign-in screen). To tint an existing surface instead, render
 * `GlowOverlay` directly inside it.
 */
export const Component = ({
  className,
  children,
  light = false,
}: {
  className?: string;
  children?: React.ReactNode;
  light?: boolean;
}) => {
  return (
    <div className={cn("min-h-screen w-full relative bg-canvas", className)}>
      <GlowOverlay light={light} />
      {/* Content */}
      <div className="relative z-10">{children}</div>
    </div>
  );
};
