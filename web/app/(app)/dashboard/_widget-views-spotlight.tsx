'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import {
  Activity,
  ArrowUpRight,
  Banknote,
  Clock,
  Coins,
  Maximize2,
  ShieldAlert,
  Truck,
  Users,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Button, Drawer, cn } from '@openbooks/ui'
import { MoneyProvider } from '@/components/money-provider'
import { readApiErrorMessage } from '@/lib/api-error'
import { useViewerFormat } from '@/lib/viewer-format'
import type { AnalyticsSpotlight, SpotlightFigure, SpotlightPanel } from '@/lib/analytics/dashboard-catalog'
import { SpotlightPanelBody, TONE_HEX, TONE_TEXT, withAlpha } from '../analytics/_ui/SpotlightPanel'
import { WIDGETS } from './_widget-registry'
import type { WidgetCardProps } from './_widget-tiles'

/** Each spotlight's presentation identity: its source dashboard's icon and accent. */
const SPOTLIGHT_LOOK: Record<string, { icon: LucideIcon; accent: string }> = {
  'financial-health': { icon: Activity, accent: '#0d9488' },
  cashflow: { icon: Wallet, accent: '#0284c7' },
  'receivables-intelligence': { icon: Banknote, accent: '#059669' },
  'customer-intelligence': { icon: Users, accent: '#7c3aed' },
  'vendor-performance': { icon: Truck, accent: '#d97706' },
  'spend-velocity': { icon: Zap, accent: '#ea580c' },
  'true-cost': { icon: Coins, accent: '#4f46e5' },
  utilization: { icon: Clock, accent: '#0891b2' },
  sentinel: { icon: ShieldAlert, accent: '#e11d48' },
}

/**
 * Render cases for the expandable Analytics spotlights — one per shipped
 * dashboard. Each card reads its dashboard's own projection from the
 * spotlight API, so it carries no dashboard metrics of its own.
 */
export function SpotlightWidgetCard({ widgetId }: WidgetCardProps): React.ReactNode {
  switch (widgetId) {
    case 'spotlight-financial-health':
    case 'spotlight-cashflow':
    case 'spotlight-receivables-intelligence':
    case 'spotlight-customer-intelligence':
    case 'spotlight-vendor-performance':
    case 'spotlight-spend-velocity':
    case 'spotlight-true-cost':
    case 'spotlight-utilization':
    case 'spotlight-sentinel':
      return <SpotlightCard widgetId={widgetId} />
    default:
      return null
  }
}

type SpotlightState = { status: 'loading' } | { status: 'ready'; data: AnalyticsSpotlight } | { status: 'failed'; message: string }

function useSpotlight(slug: string, fallback: string): { state: SpotlightState; retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const key = `${slug}:${attempt}`
  // A response is kept with the request it answers; any other request reads as loading.
  const [result, setResult] = useState<{ key: string; state: SpotlightState } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const settle = (state: SpotlightState) => { if (!controller.signal.aborted) setResult({ key, state }) }
    void (async () => {
      try {
        const response = await fetch(`/api/analytics/spotlights/${encodeURIComponent(slug)}`, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) {
          settle({ status: 'failed', message: await readApiErrorMessage(response, fallback) })
          return
        }
        settle({ status: 'ready', data: await response.json() as AnalyticsSpotlight })
      } catch {
        settle({ status: 'failed', message: fallback })
      }
    })()
    // Leaving the dashboard or retrying discards the earlier response.
    return () => controller.abort()
  }, [key, slug, fallback])
  return { state: result?.key === key ? result.state : { status: 'loading' }, retry: () => setAttempt((value) => value + 1) }
}

function SpotlightCard({ widgetId }: { widgetId: string }) {
  const t = useTranslations('dashboard')
  const common = useTranslations('common')
  const meta = WIDGETS[widgetId]!
  const slug = meta.analyticsSource!
  const look = SPOTLIGHT_LOOK[slug]!
  const href = `/analytics/${slug}`
  const title = t(meta.labelKey)
  const { state, retry } = useSpotlight(slug, t('spotlight.loadFailed'))
  const [expanded, setExpanded] = useState(false)
  const Icon = look.icon
  const data = state.status === 'ready' ? state.data : null

  const body = (() => {
    if (state.status === 'loading') return <SpotlightSkeleton />
    if (state.status === 'failed') {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-slate-500 dark:text-slate-400" aria-live="polite">
          {state.message}
          <Button size="sm" variant="outline" onClick={retry}>{common('actions.retry')}</Button>
        </div>
      )
    }
    const spotlight = state.data
    if (!spotlight.headline) return <Notice text={spotlight.notice ?? t('spotlight.loadFailed')} />
    return (
      <MoneyProvider currency={spotlight.currency}>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="px-4 pt-3">
            <Headline figure={spotlight.headline} />
          </div>
          {spotlight.figures.length > 0 ? (
            <div className="mt-3 grid grid-cols-3 gap-2 px-4">
              {spotlight.figures.slice(0, 3).map((figure) => <FigureChip key={figure.label} figure={figure} />)}
            </div>
          ) : null}
          {spotlight.feature ? (
            <div className="mt-2 flex min-h-[7rem] flex-1 flex-col px-3 pb-3">
              <p className="px-1 pb-1 text-[11px] font-medium text-slate-400 dark:text-slate-500">{spotlight.feature.title}</p>
              <div className="min-h-0 flex-1">
                <SpotlightPanelBody panel={spotlight.feature} accent={look.accent} height="fill" compact />
              </div>
            </div>
          ) : <div className="flex-1" />}
        </div>
      </MoneyProvider>
    )
  })()

  return (
    <section
      aria-label={title}
      className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow duration-200 hover:shadow-[0_14px_36px_-18px_rgba(15,23,42,0.28)] dark:border-slate-800 dark:bg-slate-900"
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-36" style={{ background: `linear-gradient(180deg, ${withAlpha(look.accent, 0.1)}, ${withAlpha(look.accent, 0)})` }} />
      <header className="relative flex items-center gap-2.5 px-4 pt-3.5">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: withAlpha(look.accent, 0.12), color: look.accent, boxShadow: `inset 0 0 0 1px ${withAlpha(look.accent, 0.2)}` }}>
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <Link href={href} className="block truncate text-sm font-semibold text-slate-900 hover:underline dark:text-slate-100">{title}</Link>
          <p className="truncate text-[11px] text-slate-400 dark:text-slate-500">{data?.periodLabel ?? ' '}</p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          disabled={!data?.headline}
          aria-label={t('spotlight.expand', { title })}
          title={t('spotlight.expand', { title })}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-900/5 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-slate-200"
        >
          <Maximize2 size={15} />
        </button>
      </header>
      {body}
      {data ? (
        // The drawer portals out of the card, but its pointer events still
        // bubble through the React tree: keep them from starting a grid drag.
        <div className="contents" onMouseDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}>
          <SpotlightDrawer
            open={expanded}
            onClose={() => setExpanded(false)}
            spotlight={data}
            title={title}
            href={href}
            icon={<span className="inline-flex h-9 w-9 items-center justify-center rounded-xl" style={{ backgroundColor: withAlpha(look.accent, 0.12), color: look.accent }}><Icon size={18} /></span>}
            accent={look.accent}
          />
        </div>
      ) : null}
    </section>
  )
}

function Headline({ figure, large = false }: { figure: SpotlightFigure; large?: boolean }) {
  const tone = figure.tone ?? 'neutral'
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{figure.label}</p>
      <p className={cn('truncate font-semibold tracking-tight text-slate-950 tabular-nums dark:text-white', large ? 'mt-1 text-4xl' : 'mt-0.5 text-[28px] leading-tight')}>{figure.value}</p>
      {figure.detail ? (
        <p className={cn('mt-1 flex items-center gap-1.5 truncate text-[11px] font-medium', TONE_TEXT[tone])}>
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: TONE_HEX[tone] }} />
          <span className="truncate">{figure.detail}</span>
        </p>
      ) : null}
    </div>
  )
}

function FigureChip({ figure, roomy = false }: { figure: SpotlightFigure; roomy?: boolean }) {
  const tone = figure.tone ?? 'neutral'
  return (
    <div className={cn('relative min-w-0 overflow-hidden rounded-xl border border-slate-200/70 bg-white/70 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/60', roomy ? 'px-3.5 py-3' : 'px-2.5 py-2')}>
      <p className="truncate text-[10.5px] font-medium text-slate-500 dark:text-slate-400" title={figure.label}>{figure.label}</p>
      <p className={cn('truncate font-semibold tracking-tight text-slate-900 tabular-nums dark:text-slate-50', roomy ? 'mt-1 text-lg' : 'mt-0.5 text-sm')} title={figure.value}>{figure.value}</p>
      {roomy && figure.detail ? <p className={cn('mt-0.5 truncate text-[11px]', tone === 'neutral' ? 'text-slate-400' : TONE_TEXT[tone])}>{figure.detail}</p> : null}
      {tone !== 'neutral' ? <span aria-hidden className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TONE_HEX[tone] }} /> : null}
    </div>
  )
}

function Notice({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-6 text-center text-sm text-slate-500 dark:text-slate-400" aria-live="polite">{text}</div>
  )
}

function SpotlightSkeleton() {
  return (
    <div className="flex flex-1 animate-pulse flex-col gap-3 px-4 pt-4 pb-4" aria-hidden>
      <div className="h-3 w-24 rounded bg-slate-200/80 dark:bg-slate-800" />
      <div className="h-7 w-40 rounded bg-slate-200/80 dark:bg-slate-800" />
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((key) => <div key={key} className="h-12 rounded-xl bg-slate-100 dark:bg-slate-800/70" />)}
      </div>
      <div className="min-h-16 flex-1 rounded-xl bg-slate-100 dark:bg-slate-800/70" />
    </div>
  )
}

/**
 * The expanded spotlight: every headline figure, the feature chart at full
 * width and the dashboard's supporting panels, in the house drawer.
 */
function SpotlightDrawer({ open, onClose, spotlight, title, href, icon, accent }: {
  open: boolean
  onClose: () => void
  spotlight: AnalyticsSpotlight
  title: string
  href: string
  icon: React.ReactNode
  accent: string
}) {
  const t = useTranslations('dashboard')
  const { dateTime } = useViewerFormat()
  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="2xl"
      title={title}
      leading={icon}
      description={`${spotlight.periodLabel} · ${t('spotlight.updated', { time: dateTime(new Date(spotlight.observedAt), { timeStyle: 'short' }) })}`}
      headerActions={
        <Link href={href} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white transition-colors hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">
          {t('spotlight.openDashboard')}
          <ArrowUpRight size={14} />
        </Link>
      }
    >
      <MoneyProvider currency={spotlight.currency}>
        <div className="space-y-5">
          {spotlight.headline ? (
            <div className="relative overflow-hidden rounded-2xl border border-slate-200/80 p-5 dark:border-slate-800">
              <span aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(120% 140% at 0% 0%, ${withAlpha(accent, 0.14)}, ${withAlpha(accent, 0)} 60%)` }} />
              <div className="relative grid gap-5 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:items-center">
                <Headline figure={spotlight.headline} large />
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {spotlight.figures.map((figure) => <FigureChip key={figure.label} figure={figure} roomy />)}
                </div>
              </div>
            </div>
          ) : null}
          {spotlight.notice ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">{spotlight.notice}</p>
          ) : null}
          {spotlight.feature ? <PanelCard panel={spotlight.feature} accent={accent} height={300} /> : null}
          {spotlight.panels.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {spotlight.panels.map((panel, index) => (
                <PanelCard
                  key={`${panel.kind}-${index}`}
                  panel={panel}
                  accent={accent}
                  height={220}
                  // A lone trailing chart takes the full row rather than half of it.
                  wide={spotlight.panels.length % 2 === 1 && index === spotlight.panels.length - 1 && (panel.kind === 'trend' || panel.kind === 'bridge')}
                />
              ))}
            </div>
          ) : null}
        </div>
      </MoneyProvider>
    </Drawer>
  )
}

function PanelCard({ panel, accent, height, wide = false }: { panel: SpotlightPanel; accent: string; height: number; wide?: boolean }) {
  return (
    <section className={cn('rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-slate-800 dark:bg-slate-900', wide && 'lg:col-span-2')}>
      <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-slate-800 dark:text-slate-100">
        <span aria-hidden className="h-3.5 w-1 rounded-full" style={{ background: `linear-gradient(180deg, ${accent}, ${withAlpha(accent, 0.35)})` }} />
        {panel.title}
      </h3>
      <SpotlightPanelBody panel={panel} accent={accent} height={height} />
    </section>
  )
}
