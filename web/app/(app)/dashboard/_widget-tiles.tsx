'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { metricTilePack, packsEqual } from './_metric-tile-density'
import type { DashboardMetrics } from './_metrics'

/** What a widget render function receives: its id and its pruned metrics. */
export type WidgetCardProps = { widgetId: string; data: DashboardMetrics }

/**
 * The shared tile primitives every dashboard widget renders through — the
 * card shell, the metric tile, the chart tile and the empty row. Widget
 * modules compose these; none draws its own card chrome.
 */

export function CardShell({
  title,
  icon,
  href,
  children,
}: {
  title: string
  icon?: React.ReactNode
  href?: string
  children: React.ReactNode
}) {
  const header = (
    <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
      {icon ? (
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100 ring-inset dark:bg-teal-950/50 dark:text-teal-300">
          {icon}
        </span>
      ) : null}
      <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
    </div>
  )
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {href ? <Link href={href}>{header}</Link> : header}
      {/* Let scrolling continue to the page when the card is empty or at its edge. */}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  )
}


export type MetricTone = 'teal' | 'sky' | 'emerald' | 'amber' | 'orange' | 'rose' | 'violet' | 'slate'
export const METRIC_TONES: Record<MetricTone, { icon: string; accent: string; wash: string; hover: string; dot: string }> = {
  teal: { icon: 'bg-teal-500/10 text-teal-700 dark:bg-teal-400/10 dark:text-teal-300', accent: 'from-teal-500 to-cyan-400', wash: 'from-teal-500/[0.07]', hover: 'hover:border-teal-300/80 dark:hover:border-teal-700/70', dot: 'bg-teal-500' },
  sky: { icon: 'bg-sky-500/10 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300', accent: 'from-sky-500 to-indigo-400', wash: 'from-sky-500/[0.07]', hover: 'hover:border-sky-300/80 dark:hover:border-sky-700/70', dot: 'bg-sky-500' },
  emerald: { icon: 'bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300', accent: 'from-emerald-500 to-teal-400', wash: 'from-emerald-500/[0.07]', hover: 'hover:border-emerald-300/80 dark:hover:border-emerald-700/70', dot: 'bg-emerald-500' },
  amber: { icon: 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300', accent: 'from-amber-500 to-yellow-400', wash: 'from-amber-500/[0.08]', hover: 'hover:border-amber-300/80 dark:hover:border-amber-700/70', dot: 'bg-amber-500' },
  orange: { icon: 'bg-orange-500/10 text-orange-700 dark:bg-orange-400/10 dark:text-orange-300', accent: 'from-orange-500 to-amber-400', wash: 'from-orange-500/[0.08]', hover: 'hover:border-orange-300/80 dark:hover:border-orange-700/70', dot: 'bg-orange-500' },
  rose: { icon: 'bg-rose-500/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300', accent: 'from-rose-500 to-pink-400', wash: 'from-rose-500/[0.07]', hover: 'hover:border-rose-300/80 dark:hover:border-rose-700/70', dot: 'bg-rose-500' },
  violet: { icon: 'bg-violet-500/10 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300', accent: 'from-violet-500 to-fuchsia-400', wash: 'from-violet-500/[0.07]', hover: 'hover:border-violet-300/80 dark:hover:border-violet-700/70', dot: 'bg-violet-500' },
  slate: { icon: 'bg-slate-500/10 text-slate-700 dark:bg-slate-400/10 dark:text-slate-300', accent: 'from-slate-500 to-slate-300', wash: 'from-slate-500/[0.06]', hover: 'hover:border-slate-300 dark:hover:border-slate-600', dot: 'bg-slate-400' },
}

export function useMetricTilePack() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pack, setPack] = useState(() => metricTilePack(0, 0))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => {
      const next = metricTilePack(el.clientWidth, el.clientHeight)
      setPack((prev) => (packsEqual(prev, next) ? prev : next))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, pack }
}

/**
 * KPI card. The tone lives INSIDE the rounded shape: a soft corner wash
 * behind the number, a tinted icon, and a short gradient accent stroke under
 * the value. No edge rails — a rail drawn on an absolutely positioned strip
 * cannot follow a rounded corner and reads as a print artifact.
 */
export function MetricTile({
  icon,
  label,
  value,
  href,
  hint,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: string
  href?: string
  hint?: string
  tone: MetricTone
}) {
  const colors = METRIC_TONES[tone]
  const { ref, pack } = useMetricTilePack()
  const inner = (
    <div
      ref={ref}
      className="relative flex h-full min-h-[7rem] flex-col overflow-hidden rounded-2xl"
      style={{ padding: `${pack.padTop}px ${pack.padX}px ${pack.padBottom}px` }}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 bg-gradient-to-br via-transparent to-transparent ${colors.wash}`}
      />
      <div className="relative flex items-center gap-2.5">
        <span
          className={`inline-flex shrink-0 items-center justify-center rounded-xl ${colors.icon}`}
          style={{ width: pack.icon, height: pack.icon }}
        >
          {icon}
        </span>
        <span className="min-w-0 truncate text-[12.5px] font-medium tracking-tight text-slate-600 dark:text-slate-300">
          {label}
        </span>
        {href ? (
          <span className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-300 opacity-0 transition-all duration-200 group-hover:opacity-100 dark:text-slate-600">
            <ArrowUpRight size={14} />
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1" aria-hidden />
      <div className="relative min-w-0">
        <div
          className="truncate leading-none font-semibold tracking-tight text-slate-950 tabular-nums dark:text-white"
          style={{ fontSize: pack.figure }}
        >
          {value}
        </div>
        <div className="flex items-center gap-2" style={{ marginTop: pack.hintGap }}>
          {pack.narrow ? null : (
            <span aria-hidden className={`h-[3px] w-8 shrink-0 rounded-full bg-gradient-to-r ${colors.accent}`} />
          )}
          {hint ? (
            <span
              className={`min-w-0 text-[11px] font-medium text-slate-400 dark:text-slate-500 ${
                pack.hintLines > 1 ? 'line-clamp-2 leading-snug' : 'truncate leading-none'
              }`}
            >
              {hint}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
  const shell = `group block h-full rounded-2xl border border-slate-200/90 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 dark:border-slate-800 dark:bg-slate-900`
  if (href) {
    return (
      <Link href={href} className={`${shell} hover:-translate-y-0.5 hover:shadow-[0_10px_30px_-12px_rgba(15,23,42,0.18)] ${colors.hover}`}>
        {inner}
      </Link>
    )
  }
  return <div className={shell}>{inner}</div>
}

export function EmptyRow() {
  return (
    <div className="flex h-full items-center justify-center py-6 text-sm text-slate-400 dark:text-slate-500">
      —
    </div>
  )
}

/**
 * A chart widget: an Analytics dashboard's own chart inside the shared card
 * shell, under the headline figure and the window it covers. The chart
 * fills the card, so resizing the widget resizes the chart.
 */
export function ChartTile({
  title,
  icon,
  href,
  headline,
  context,
  children,
}: {
  title: string
  icon?: React.ReactNode
  href?: string
  headline?: string
  context?: string
  children: React.ReactNode
}) {
  return (
    <CardShell title={title} icon={icon} href={href}>
      <div className="flex h-full min-h-[8rem] flex-col px-4 pt-2 pb-3">
        {headline || context ? (
          <div className="flex items-baseline justify-between gap-3">
            {headline ? (
              <span className="truncate text-lg font-semibold tracking-tight text-slate-950 tabular-nums dark:text-white">{headline}</span>
            ) : <span />}
            {context ? <span className="min-w-0 truncate text-[11px] font-medium text-slate-400 dark:text-slate-500">{context}</span> : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </CardShell>
  )
}

/**
 * The honest state of a chart or list widget with nothing true to show:
 * the reason, in words, where the figures would be.
 */
export function UnavailableRow({ reason }: { reason: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
      {reason}
    </div>
  )
}
