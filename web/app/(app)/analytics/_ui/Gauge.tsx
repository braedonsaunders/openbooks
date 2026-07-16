'use client'

import { useId } from 'react'
import { cn } from '@openbooks/ui'
import { scoreTone } from './format'

/**
 * Semicircular score gauge (0–100) rendered as pure SVG — the signature
 * element of the Financial Health screen. No chart library: a background
 * track arc plus a value arc drawn with stroke-dasharray, with the score
 * and a qualitative label stacked at the center.
 */
export function Gauge({
  value,
  label,
  size = 200,
  thickness = 16,
  showTicks = true,
  className,
}: {
  value: number
  label?: string
  size?: number
  thickness?: number
  showTicks?: boolean
  className?: string
}) {
  const v = Math.min(100, Math.max(0, value))
  const tone = scoreTone(v)
  const gradId = useId()

  const w = size
  const r = (w - thickness) / 2
  const cx = w / 2
  const cy = w / 2
  // Top semicircle, left → right.
  const arc = (from: number, to: number) => {
    const a0 = Math.PI * (1 - from / 100)
    const a1 = Math.PI * (1 - to / 100)
    const p0 = { x: cx + r * Math.cos(a0), y: cy - r * Math.sin(a0) }
    const p1 = { x: cx + r * Math.cos(a1), y: cy - r * Math.sin(a1) }
    // Every arc here spans at most 180° (a half-circle), so the large-arc-flag
    // is always 0 — setting it to 1 would draw the major arc the long way round.
    return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 0 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`
  }

  const height = cy + thickness / 2 + 4
  const ticks = [0, 25, 50, 75, 100]

  return (
    <div className={cn('flex flex-col items-center', className)}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={`Score ${Math.round(v)} of 100`}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={tone.hex} stopOpacity={0.65} />
            <stop offset="100%" stopColor={tone.hex} />
          </linearGradient>
        </defs>
        {/* track */}
        <path
          d={arc(0, 100)}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          className="stroke-slate-200 dark:stroke-slate-800"
        />
        {/* value */}
        <path
          d={arc(0, Math.max(0.5, v))}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={thickness}
          strokeLinecap="round"
          style={{ transition: 'all 700ms cubic-bezier(0.22,0.61,0.36,1)' }}
        />
        {showTicks &&
          ticks.map((t) => {
            const a = Math.PI * (1 - t / 100)
            const tr = r + thickness / 2 + 8
            const x = cx + tr * Math.cos(a)
            const y = cy - tr * Math.sin(a)
            return (
              <text
                key={t}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-slate-400 text-[9px] dark:fill-slate-500"
              >
                {t}
              </text>
            )
          })}
      </svg>
      <div className="-mt-6 flex flex-col items-center">
        <span className={cn('text-4xl font-bold tabular-nums', tone.text)}>{Math.round(v)}</span>
        {label && <span className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</span>}
      </div>
    </div>
  )
}
