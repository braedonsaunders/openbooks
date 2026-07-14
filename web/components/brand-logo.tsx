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

import type { CSSProperties, ReactNode, SVGProps } from 'react'
import { cn } from '@openbooks/ui'

const BRAND_TEAL = '#0f766e'
const BRAND_TEAL_DARK = '#2dd4bf'

const INK_CLASS = 'text-slate-900 dark:text-slate-100'

type Mode = 'static' | 'loop' | 'draw'

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
  const draw = mode === 'draw'
  const animated = mode !== 'static'
  const strokeCls = draw ? 'brand-stroke-draw' : animated ? 'brand-stroke-loop' : undefined
  const entryCls = draw ? 'brand-ray-draw' : animated ? 'brand-ray-loop' : undefined
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
// Monoline lowercase "openbooks" on a 26-unit advance; baseline y=40,
// x-height 18, ascenders from y=7, descender to 52.

function letterPaths(letter: string, x: number): string[] {
  const circle = (cx: number) => `M ${cx - 10.5} 29 a 10.5 10.5 0 1 0 21 0 a 10.5 10.5 0 1 0 -21 0`
  switch (letter) {
    case 'o':
      return [circle(x + 10.5)]
    case 'p':
      return [`M ${x} 19 V 52`, `M ${x} 22.5 a 10.5 10.5 0 1 1 0 13`]
    case 'e':
      return [
        `M ${x + 0.6} 26.5 L ${x + 20.4} 26.5`,
        `M ${x + 20.4} 26.5 a 10.5 10.5 0 1 0 -2.2 9.8`,
      ]
    case 'n':
      return [`M ${x} 40 V 19`, `M ${x} 25 c 3.5 -5.5 9.5 -7.5 13.5 -5 c 4 2.5 6.5 5.5 6.5 10.5 V 40`]
    case 'b':
      return [`M ${x} 7 V 40`, `M ${x} 22.5 a 10.5 10.5 0 1 1 0 13`]
    case 'k':
      return [`M ${x} 7 V 40`, `M ${x + 15.5} 19.5 L ${x + 0.8} 30.5`, `M ${x + 5.8} 26.8 L ${x + 16.5} 40`]
    case 's':
      return [
        `M ${x + 16.8} 21.8 c -2.2 -3.4 -12.6 -4.2 -14.6 0.6 c -2.2 6 14.4 4.4 13.4 10.8 c -1 5.4 -12.8 4.8 -15.6 0.8`,
      ]
    default:
      return []
  }
}

const WORD = 'openbooks'
const WORD_X = 62
const ADVANCE: Record<string, number> = { o: 27, p: 27, e: 27, n: 26.5, b: 27, k: 22.5, s: 23 }

function WordmarkArt({ mode }: { mode: Mode }) {
  const draw = mode === 'draw'
  const animated = mode !== 'static'
  const strokeCls = draw ? 'brand-stroke-draw' : animated ? 'brand-stroke-loop' : undefined
  let x = WORD_X
  let pathIndex = 0
  const rendered: ReactNode[] = []
  for (let i = 0; i < WORD.length; i++) {
    const ch = WORD[i]!
    const teal = i >= 4 // "books" carries the brand teal
    for (const d of letterPaths(ch, x)) {
      rendered.push(
        <path
          key={`${i}-${d}`}
          d={d}
          stroke="currentColor"
          className={cn(strokeCls, teal && 'text-[#0f766e] dark:text-[#2dd4bf]') || undefined}
          {...(strokeCls ? { pathLength: 1, style: delay(0.35 + pathIndex * 0.07) } : {})}
        />,
      )
      pathIndex++
    }
    x += ADVANCE[ch] ?? 27
  }
  return (
    <g fill="none" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round">
      {rendered}
    </g>
  )
}

/* -------------------------------- Exports -------------------------------- */

type LogoProps = SVGProps<SVGSVGElement> & { animated?: boolean; draw?: boolean }

export function LogoMark({ animated, draw, className, ...rest }: LogoProps) {
  const mode: Mode = draw ? 'draw' : animated ? 'loop' : 'static'
  return (
    <svg viewBox="0 0 48 56" aria-hidden className={cn('h-7 w-auto', INK_CLASS, className)} {...rest}>
      <MarkArt mode={mode} />
    </svg>
  )
}

export function Logo({ animated, draw, className, ...rest }: LogoProps) {
  const mode: Mode = draw ? 'draw' : animated ? 'loop' : 'static'
  return (
    <svg
      viewBox="0 0 302 56"
      role="img"
      aria-label="openbooks"
      className={cn('h-8 w-auto', INK_CLASS, className)}
      {...rest}
    >
      <MarkArt mode={mode} />
      <WordmarkArt mode={mode} />
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
