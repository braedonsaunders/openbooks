'use client'

import { useTranslations } from 'next-intl'
import type { InsightQuery, VizSettings, VizType } from '@openbooks/analytics'
import { CardTile, type CardTileData } from './CardTile'

export type EmbedCard = {
  id: string
  name: string
  description: string | null
  query: unknown
  viz_type: VizType
  viz_settings: VizSettings
}
export type EmbedWidget = { cardId: string; x: number; y: number; w: number; h: number }

/**
 * Renders a dashboard's published cards on a responsive 12-column grid. Pure
 * presentation — the caller (dashboards page, or later the HOME surface) resolves
 * the cards + layout server-side via `loadDashboardEmbed`. Each card self-fetches
 * its data through <CardTile/>. On mobile the grid collapses to a single column.
 */
export function DashboardEmbed({
  cards,
  layout,
  emptyMessage,
}: {
  cards: EmbedCard[]
  layout: EmbedWidget[]
  emptyMessage?: string
}) {
  const t = useTranslations('insights')
  const byId = new Map(cards.map((c) => [c.id, c]))
  const placed = layout.filter((w) => byId.has(w.cardId)).sort((a, b) => a.y - b.y || a.x - b.x)

  if (placed.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 px-6 py-12 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        {emptyMessage ?? t('empty.dashboardNoCards')}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
      {placed.map((w, i) => {
        const card = byId.get(w.cardId)!
        const data: CardTileData = {
          id: card.id,
          name: card.name,
          description: card.description,
          query: card.query as InsightQuery,
          vizType: card.viz_type,
          vizSettings: card.viz_settings ?? {},
        }
        // Map the 12-col span to a responsive col-span; rows use a min-height.
        const span = Math.max(1, Math.min(12, w.w))
        return (
          <div
            key={`${w.cardId}-${i}`}
            className="md:[grid-column:span_var(--span)]"
            style={{ ['--span' as string]: String(span), minHeight: `${Math.max(2, w.h) * 3.25}rem` }}
          >
            <CardTile card={data} />
          </div>
        )
      })}
    </div>
  )
}
