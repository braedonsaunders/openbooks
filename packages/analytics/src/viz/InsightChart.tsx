'use client'

import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import type { EChartsOption } from '../viz'

export type InsightChartProps = {
  option: EChartsOption
  /** Explicit height in px; defaults to filling the parent (which must be sized). */
  height?: number
  className?: string
}

/**
 * A self-contained ECharts canvas. Re-renders on option change, resizes with its
 * container (ResizeObserver), and respects light/dark via CSS-driven container
 * colors (the option already uses theme-neutral axis/label colors). Disposes the
 * instance on unmount to avoid leaks in the studio's live preview.
 */
export function InsightChart({ option, height, className }: InsightChartProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    // `notMerge` so removing a series/axis between previews doesn't linger.
    chart.setOption(option as echarts.EChartsCoreOption, { notMerge: true })
  }, [option])

  return (
    <div
      ref={ref}
      className={className}
      style={height ? { height, width: '100%' } : { width: '100%', height: '100%' }}
    />
  )
}
