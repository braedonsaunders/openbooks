'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ECharts, EChartsCoreOption } from 'echarts'
import type { EChartsOption } from '../viz'

export type InsightChartProps = {
  option: EChartsOption
  /** Explicit height in px; defaults to filling the parent (which must be sized). */
  height?: number
  className?: string
  /** Exact, formatted point descriptions for keyboard inspection. */
  inspection?: { label: string; instructions: string; points: string[]; seriesIndex?: number }
}

/**
 * A self-contained ECharts canvas. Re-renders on option change, resizes with its
 * container (ResizeObserver), and respects light/dark via CSS-driven container
 * colors (the option already uses theme-neutral axis/label colors). Disposes the
 * instance on unmount to avoid leaks in the studio's live preview.
 */
export function InsightChart({ option, height, className, inspection }: InsightChartProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<ECharts | null>(null)
  const latestOption = useRef(option)
  latestOption.current = option
  const pendingInspection = useRef<{ seriesIndex: number; dataIndex: number } | null>(null)
  const [rendererFailure, setRendererFailure] = useState<{ cause: unknown } | null>(null)
  const instructionsId = useId()
  const [inspectedIndex, setInspectedIndex] = useState<number | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    let cancelled = false
    let chart: ECharts | undefined
    let observer: ResizeObserver | undefined
    const dispose = () => {
      observer?.disconnect()
      observer = undefined
      if (chartRef.current === chart) chartRef.current = null
      chart?.dispose()
      chart = undefined
    }
    // Shared pages can reference chart components without mounting a chart.
    // Fetch the renderer only when there is a canvas to initialize.
    void import('echarts').then((echarts) => {
      if (cancelled) return
      chart = echarts.init(element, undefined, { renderer: 'canvas' })
      chartRef.current = chart
      chart.setOption(latestOption.current as EChartsCoreOption, { notMerge: true })
      observer = new ResizeObserver(() => chart?.resize())
      observer.observe(element)
      const point = pendingInspection.current
      if (point) {
        chart.dispatchAction({ type: 'highlight', ...point })
        chart.dispatchAction({ type: 'showTip', ...point })
      }
    }).catch((cause: unknown) => {
      if (cancelled) return
      dispose()
      setRendererFailure({ cause })
    })
    return () => {
      cancelled = true
      dispose()
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    // `notMerge` so removing a series/axis between previews doesn't linger.
    chart.setOption(option as EChartsCoreOption, { notMerge: true })
  }, [option])

  const inspect = (index: number) => {
    if (!inspection?.points.length) return
    const dataIndex = Math.max(0, Math.min(index, inspection.points.length - 1))
    const seriesIndex = inspection.seriesIndex ?? 0
    pendingInspection.current = { seriesIndex, dataIndex }
    setInspectedIndex(dataIndex)
    chartRef.current?.dispatchAction({ type: 'downplay', seriesIndex })
    chartRef.current?.dispatchAction({ type: 'highlight', seriesIndex, dataIndex })
    chartRef.current?.dispatchAction({ type: 'showTip', seriesIndex, dataIndex })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!inspection?.points.length) return
    const current = inspectedIndex ?? inspection.points.length - 1
    const next = event.key === 'ArrowLeft' ? current - 1
      : event.key === 'ArrowRight' ? current + 1
      : event.key === 'Home' ? 0
      : event.key === 'End' ? inspection.points.length - 1 : null
    if (next === null) return
    event.preventDefault()
    inspect(next)
  }

  if (rendererFailure) throw rendererFailure.cause

  const canvas = (
    <div
      ref={ref}
      className={inspection ? undefined : className}
      style={{ height: inspection ? '100%' : height ?? '100%', width: '100%' }}
    />
  )
  if (!inspection) return canvas
  return <div
    role="group"
    aria-label={inspection.label}
    aria-describedby={instructionsId}
    tabIndex={inspection.points.length ? 0 : undefined}
    className={className}
    style={{ height: height ?? '100%', width: '100%' }}
    onFocus={() => inspect(inspection.points.length - 1)}
    onKeyDown={onKeyDown}
    onBlur={() => {
      pendingInspection.current = null
      chartRef.current?.dispatchAction({ type: 'hideTip' })
      chartRef.current?.dispatchAction({ type: 'downplay', seriesIndex: inspection.seriesIndex ?? 0 })
      setInspectedIndex(null)
    }}
  >
    {canvas}
    <span id={instructionsId} className="sr-only">{inspection.instructions}</span>
    <span aria-live="polite" className="sr-only">{inspectedIndex === null ? '' : inspection.points[inspectedIndex]}</span>
  </div>
}
