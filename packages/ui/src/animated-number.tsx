'use client'

import * as React from 'react'
import { animate, useMotionValue, useReducedMotion } from 'framer-motion'

/**
 * Counts up from `from` (default 0) to `value` on mount using an eased
 * animation. Useful for KPI tiles and counters.
 *
 *   <AnimatedNumber value={42} />
 *   <AnimatedNumber value={1234.5} format={(n) => `$${n.toFixed(2)}`} />
 */
export function AnimatedNumber({
  value,
  from = 0,
  duration = 0.8,
  format,
  className,
  decimals,
}: {
  value: number
  from?: number
  /** Animation duration in seconds. */
  duration?: number
  /** Custom formatter. If omitted, the value is rounded to `decimals` (0). */
  format?: (n: number) => string
  className?: string
  /** Number of decimal places to render when no `format` is provided. */
  decimals?: number
}) {
  const reduce = useReducedMotion()
  const mv = useMotionValue(reduce ? value : from)
  const [displayValue, setDisplayValue] = React.useState(reduce ? value : from)

  React.useEffect(() => {
    if (reduce) {
      setDisplayValue(value)
      return
    }
    const controls = animate(mv, value, {
      duration,
      ease: [0.22, 0.61, 0.36, 1],
      onUpdate: setDisplayValue,
    })
    return () => controls.stop()
  }, [duration, mv, reduce, value])

  return (
    <span className={className} aria-label={String(value)}>
      {formatValue(displayValue, format, decimals)}
    </span>
  )
}

function formatValue(n: number, format?: (n: number) => string, decimals?: number): string {
  if (format) return format(n)
  const d = decimals ?? 0
  const rounded = d > 0 ? n.toFixed(d) : Math.round(n).toString()
  // Add thousands separators for readability.
  const [intPart, fracPart] = rounded.split('.')
  const withCommas = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fracPart ? `${withCommas}.${fracPart}` : withCommas
}
