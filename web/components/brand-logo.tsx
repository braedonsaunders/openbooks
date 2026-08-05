// openbooks brand logo — hand-drawn SVG open-ledger lockup. Ink strokes use
// `currentColor` (slate ink in light mode, near-white in dark); the ledger
// entry lines stay brand teal in both themes and carry the ray shimmer. Every
// shape is a stroke with a normalized pathLength so the splash can draw the
// logo in (keyframes live in globals.css under "Brand logo").
//
// Exports:
//   <Logo />        full horizontal lockup (mark + "openbooks" wordmark)
//   <LogoMark />    open book only (square-ish, for tight spots)
//   <BrandSplash /> full-screen draw-in for document/route loading
//   <LogoLoader />  centered animated mark for heavy in-shell loads

import type { CSSProperties, SVGProps } from 'react'
import { cn } from '@openbooks/ui'

const BRAND_TEAL = '#0f766e'
const BRAND_TEAL_DARK = '#2dd4bf'

const INK_CLASS = 'text-slate-900 dark:text-slate-100'

// static — fully drawn, no motion.
// loop   — perpetual 12s redraw cycle.
// draw   — draw in, then join the 12s cycle.
// intro  — draw in once, then hold static (used on the login stage).
type Mode = 'static' | 'loop' | 'draw' | 'intro'

const delay = (s: number) => ({ '--bd': `${s}s` }) as CSSProperties
const rayDelay = (s: number, pulse: number) =>
  ({ '--bd': `${s}s`, '--bp': `${pulse}s` }) as CSSProperties

/* ------------------------------- The mark -------------------------------- */
// Drawn in a 48 × 48 box. Build order: spine → left cover → right cover →
// page edges, then the ledger entries write themselves onto the pages.

const MARK_STRUCTURE = [
  'M24 13 V 40', // spine
  'M24 13 C 18 7.5 10 6 4.5 8.5 V 35.5 C 10 33.5 18 34.5 24 40', // left cover
  'M24 13 C 30 7.5 38 6 43.5 8.5 V 35.5 C 38 33.5 30 34.5 24 40', // right cover
]

// Ledger entries, written top-to-bottom, left page then right — staggered
// delays read as the books writing themselves.
const MARK_ENTRIES = [
  'M9.5 15.5 C 13 14.8 17 15.6 20 17.4',
  'M9.5 21.5 C 13 20.8 17 21.6 20 23.4',
  'M9.5 27.5 C 13 26.8 17 27.6 20 29.4',
  'M28 17.4 C 31 15.6 35 14.8 38.5 15.5',
  'M28 23.4 C 31 21.6 35 20.8 38.5 21.5',
  'M28 29.4 C 31 27.6 35 26.8 38.5 27.5',
]

function MarkArt({ mode }: { mode: Mode }) {
  const strokeCls =
    mode === 'intro'
      ? 'brand-stroke-intro'
      : mode === 'draw'
        ? 'brand-stroke-draw'
        : mode === 'loop'
          ? 'brand-stroke-loop'
          : undefined
  const entryCls =
    mode === 'intro'
      ? 'brand-ray-intro'
      : mode === 'draw'
        ? 'brand-ray-draw'
        : mode === 'loop'
          ? 'brand-ray-loop'
          : undefined
  return (
    <>
      <g fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round">
        {MARK_STRUCTURE.map((d, i) => (
          <path
            key={d}
            d={d}
            {...(strokeCls
              ? { pathLength: 1, className: strokeCls, style: delay(0.05 + i * 0.14) }
              : {})}
          />
        ))}
      </g>
      <g
        fill="none"
        strokeWidth={2.6}
        strokeLinecap="round"
        className="text-[#0f766e] dark:text-[#2dd4bf]"
        stroke="currentColor"
      >
        {MARK_ENTRIES.map((d, i) => (
          <path
            key={d}
            d={d}
            {...(entryCls
              ? { pathLength: 1, className: entryCls, style: rayDelay(0.55 + i * 0.1, (i % 3) * 0.5) }
              : {})}
          />
        ))}
      </g>
    </>
  )
}

/* ----------------------------- The wordmark ------------------------------ */
// The wordmark is set type, not hand-drawn strokes — geometric and legible.
// It fades/rises in after the mark draws (mode 'draw'); otherwise it's static.
function WordmarkText({ mode }: { mode: Mode }) {
  const fadeCls = mode === 'draw' || mode === 'intro' ? 'brand-word-in' : undefined
  return (
    <text
      x={64}
      y={38}
      fontSize={34}
      fontWeight={700}
      letterSpacing={-1.2}
      fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
      className={fadeCls}
    >
      <tspan fill="currentColor">open</tspan>
      <tspan className="text-[#0f766e] dark:text-[#2dd4bf]" fill="currentColor">
        books
      </tspan>
    </text>
  )
}

/* -------------------------------- Exports -------------------------------- */

type LogoProps = SVGProps<SVGSVGElement> & { animated?: boolean; draw?: boolean; intro?: boolean }

export function LogoMark({ animated, draw, intro, className, ...rest }: LogoProps) {
  const mode: Mode = intro ? 'intro' : draw ? 'draw' : animated ? 'loop' : 'static'
  return (
    <svg viewBox="0 0 48 56" aria-hidden className={cn('h-7 w-auto', INK_CLASS, className)} {...rest}>
      <MarkArt mode={mode} />
    </svg>
  )
}

export function Logo({ animated, draw, intro, className, ...rest }: LogoProps) {
  const mode: Mode = intro ? 'intro' : draw ? 'draw' : animated ? 'loop' : 'static'
  return (
    <svg
      viewBox="0 0 238 56"
      role="img"
      aria-label="openbooks"
      className={cn('h-8 w-auto', INK_CLASS, className)}
      {...rest}
    >
      {/* nudge the book down a few units so its optical center lines up with
          the wordmark's x-height instead of sitting high */}
      <g transform="translate(0,5)">
        <MarkArt mode={mode} />
      </g>
      <WordmarkText mode={mode} />
    </svg>
  )
}

/** Full-screen draw-in used by the splash screen and route fallbacks. */
export function BrandSplash() {
  return (
    <div className="grid h-full w-full place-items-center bg-slate-50 dark:bg-slate-950">
      <Logo draw className="h-12 w-auto sm:h-14" />
    </div>
  )
}

/** Centered animated mark for heavy in-shell loading states. */
export function LogoLoader({ label }: { label?: string }) {
  return (
    <div className="flex h-full min-h-48 w-full flex-col items-center justify-center gap-3">
      <LogoMark draw className="h-10 w-auto" />
      {label ? <p className="text-sm text-slate-500 dark:text-slate-400">{label}</p> : null}
    </div>
  )
}
