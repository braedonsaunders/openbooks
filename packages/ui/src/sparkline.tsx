import * as React from 'react'
import { cn } from './utils'

/**
 * Tiny inline-SVG sparkline. Renders a polyline path from the given numeric
 * series, scaled to fit the parent's dimensions. Color is driven by `tone`
 * — pass an explicit color via `stroke` to override.
 *
 *   <Sparkline points={[3, 5, 4, 7, 6, 8, 9]} tone="up" className="h-8 w-20" />
 *
 * For semantic situations (incident counts are bad-up, compliance is good-up)
 * pick the tone that visually matches: incidents climbing → tone="bad",
 * compliance climbing → tone="good".
 */

export type SparklineTone = 'up' | 'down' | 'good' | 'bad' | 'neutral'

type SparklineProps = {
  /** Numeric series — must contain at least 2 points to draw a line. */
  points: number[]
  /** Hardcoded visual tone (overridden by `auto` when set). */
  tone?: SparklineTone
  /**
   * If true, derive the tone from the first→last direction. `goodWhenRising`
   * controls which direction is "good". Defaults to direction-only colors.
   */
  auto?: boolean
  goodWhenRising?: boolean
  /** Show small filled dots at the min and max points. */
  dots?: boolean
  /** Explicit stroke color (CSS color); overrides tone. */
  stroke?: string
  /** Add a soft area fill under the line. */
  area?: boolean
  /** Stroke width in pixels (in the 100x32 viewBox). */
  strokeWidth?: number
  className?: string
  ariaLabel?: string
}

const TONE_STROKE: Record<SparklineTone, string> = {
  up: 'rgb(220 38 38)', // red-600 (e.g. incidents up = bad)
  down: 'rgb(22 163 74)', // green-600 (e.g. incidents down = good)
  good: 'rgb(22 163 74)', // green-600
  bad: 'rgb(220 38 38)', // red-600
  neutral: 'rgb(100 116 139)', // slate-500
}

const TONE_FILL: Record<SparklineTone, string> = {
  up: 'rgba(220, 38, 38, 0.10)',
  down: 'rgba(22, 163, 74, 0.10)',
  good: 'rgba(22, 163, 74, 0.10)',
  bad: 'rgba(220, 38, 38, 0.10)',
  neutral: 'rgba(100, 116, 139, 0.10)',
}

export function Sparkline({
  points,
  tone = 'neutral',
  auto,
  goodWhenRising = true,
  dots = false,
  stroke,
  area = false,
  strokeWidth = 1.5,
  className,
  ariaLabel,
}: SparklineProps) {
  // Derive effective tone if auto requested.
  const resolvedTone: SparklineTone = React.useMemo(() => {
    if (!auto || points.length < 2) return tone
    const first = points[0]!
    const last = points[points.length - 1]!
    if (last === first) return 'neutral'
    const rising = last > first
    return rising ? (goodWhenRising ? 'good' : 'bad') : goodWhenRising ? 'bad' : 'good'
  }, [auto, goodWhenRising, points, tone])

  const strokeColor = stroke ?? TONE_STROKE[resolvedTone]
  const fillColor = TONE_FILL[resolvedTone]

  // Empty / single-point cases — render an unobtrusive baseline.
  if (points.length < 2) {
    return (
      <svg
        viewBox="0 0 100 32"
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel ?? 'No trend data'}
        className={cn('block', className)}
      >
        <line
          x1={0}
          y1={16}
          x2={100}
          y2={16}
          stroke="rgb(226 232 240)"
          strokeWidth={1}
          strokeDasharray="3,3"
        />
      </svg>
    )
  }

  // Normalize the series into the 100×32 viewBox. We pin min/max to the
  // top and bottom of the box with a 2px padding so the stroke isn't clipped.
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const VB_W = 100
  const VB_H = 32
  const PAD_Y = 3

  const minIdx = points.indexOf(min)
  const maxIdx = points.indexOf(max)

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * VB_W
    const y = VB_H - PAD_Y - ((p - min) / range) * (VB_H - PAD_Y * 2)
    return [x, y] as const
  })

  const pathD = 'M ' + coords.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join(' L ')
  const areaD = pathD + ` L ${VB_W} ${VB_H} L 0 ${VB_H} Z` // close path to baseline for the fill

  const label =
    ariaLabel ?? `Trend: ${points.length} points from ${points[0]} to ${points[points.length - 1]}`

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cn('block overflow-visible', className)}
    >
      {area ? <path d={areaD} fill={fillColor} stroke="none" /> : null}
      <path
        d={pathD}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {dots
        ? [minIdx, maxIdx]
            .filter((i, idx, arr) => arr.indexOf(i) === idx)
            .map((i) => {
              const [x, y] = coords[i]!
              return (
                <circle
                  key={`dot-${i}`}
                  cx={x}
                  cy={y}
                  r={1.75}
                  fill={strokeColor}
                  stroke="white"
                  strokeWidth={0.75}
                />
              )
            })
        : null}
    </svg>
  )
}
