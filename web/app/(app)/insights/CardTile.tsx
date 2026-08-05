'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { InsightQuery, QueryResult, VizSettings, VizType } from '@openbooks/analytics'
import { InsightResultView } from '@openbooks/analytics/viz'
import { Skeleton } from '@openbooks/ui'

export type CardTileData = {
  id: string
  name: string
  description?: string | null
  query: InsightQuery
  vizType: VizType
  vizSettings: VizSettings
}

/**
 * A self-fetching insight card — runs its own query against POST
 * /api/insights/query and renders the result. Used on dashboards AND (later) the
 * home surface via <DashboardEmbed/>, so a card looks identical wherever pinned.
 */
export function CardTile({
  card,
  header,
  className,
}: {
  card: CardTileData
  /** Optional actions rendered in the tile header (e.g. remove-from-dashboard). */
  header?: React.ReactNode
  className?: string
}) {
  const t = useTranslations('insights')
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const mySeq = ++seq.current
    setResult(null)
    setError(null)
    fetch('/api/insights/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: card.query }),
    })
      .then(async (res) => {
        const data = await res.json()
        if (mySeq !== seq.current) return
        if (!res.ok) setError(data.error ?? t('errors.queryFailed'))
        else setResult(data as QueryResult)
      })
      .catch(() => {
        if (mySeq === seq.current) setError(t('cardTile.loadFailed'))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.query])

  return (
    <div
      className={
        'flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950 ' +
        (className ?? '')
      }
    >
      <div className="flex items-start justify-between gap-2 border-b border-slate-100 px-3.5 py-2.5 dark:border-slate-800/70">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{card.name}</h3>
          {card.description ? (
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{card.description}</p>
          ) : null}
        </div>
        {header ? <div className="shrink-0">{header}</div> : null}
      </div>
      <div className="min-h-0 flex-1 p-3">
        {error ? (
          <div className="flex h-full min-h-[6rem] items-center justify-center px-3 text-center text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        ) : !result ? (
          <div className="space-y-2 p-1">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="h-full">
            <InsightResultView result={result} vizType={card.vizType} settings={card.vizSettings} />
          </div>
        )}
      </div>
    </div>
  )
}
