'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { ArrowUpRight, Settings2, Zap } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  DEFAULT_QUICK_ACTIONS,
  isExternalHref,
  quickActionLabel,
  toneOf,
  visibleQuickActions,
  type QuickAction,
  type SaveQuickActionsAction,
} from './_quick-actions-shared'
import { FALLBACK_ICON, QUICK_ACTION_ICONS } from './_quick-actions-icons'
import { QuickActionsEditor } from './_quick-actions-editor'

export function QuickActions({
  actions,
  saveAction,
  hiddenActionIds,
}: {
  actions?: QuickAction[] | null
  saveAction?: SaveQuickActionsAction
  hiddenActionIds?: readonly string[]
}) {
  const t = useTranslations('dashboard')
  const hidden = new Set(hiddenActionIds)
  const [items, setItems] = useState<QuickAction[]>(
    actions ?? visibleQuickActions(DEFAULT_QUICK_ACTIONS, hidden),
  )
  const [editorOpen, setEditorOpen] = useState(false)
  const visibleItems = visibleQuickActions(items, hidden)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const density = useTileDensity(bodyRef, visibleItems.length)

  return (
    <div className="@container flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100 ring-inset dark:bg-teal-950/50 dark:text-teal-300">
            <Zap size={14} />
          </span>
          <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('quickActions.title')}
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setEditorOpen(true)}
          className="no-drag inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-teal-700 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-teal-300"
        >
          <Settings2 size={13} />
          <span className="@max-[16rem]:sr-only">{t('quickActions.customize')}</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {visibleItems.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-6 text-center">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('quickActions.empty')}
            </p>
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-medium text-teal-700 transition hover:bg-teal-100 dark:border-teal-800/60 dark:bg-teal-950/40 dark:text-teal-300 dark:hover:bg-teal-900/40"
            >
              <Settings2 size={13} />
              {t('quickActions.addFirst')}
            </button>
          </div>
        ) : (
          <div
            ref={bodyRef}
            data-density={density}
            className="@container grid h-full min-h-0 content-start gap-2 overflow-y-auto p-2.5"
            // Container-driven, never viewport-driven. Before measurement the
            // CSS `auto-fit` packs ~11rem tiles across the card's width; once
            // useTileDensity has measured the box it pins the column count and
            // row height that fill the card best (see its doc). Rows scroll
            // rather than squash when the card is shorter than its actions.
            style={{
              gridTemplateColumns: 'repeat(var(--qa-cols, auto-fit), minmax(min(100%, var(--qa-min, 11rem)), 1fr))',
              gridAutoRows: 'var(--qa-row, 2.75rem)',
            }}
          >
            {visibleItems.map((a, i) => (
              <ActionTile key={a.id} action={a} index={i} density={density} />
            ))}
          </div>
        )}
      </div>

      <QuickActionsEditor
        open={editorOpen}
        value={items}
        hiddenActionIds={hiddenActionIds}
        onClose={() => setEditorOpen(false)}
        onSaved={(next) => setItems(next)}
        saveAction={saveAction}
      />
    </div>
  )
}

type TileDensity = 'compact' | 'comfortable' | 'card'

const ROW_MIN = 40 // compact list row
const ROW_MAX = 76 // comfortable row: icon beside label
const CARD_AT = 100 // from here the tile becomes a card: icon above label
const CARD_MAX = 128
const COMFORTABLE_AT = 64
const GAP = 8
const PAD = 20 // p-2.5 top + bottom
const TILE_MIN = 176 // 11rem — a full label beside its icon
const TILE_MIN_TIGHT = 136 // 8.5rem — only when the card is too short to show its actions
const TILE_WIDE = 320 // wider than this a tile reads as a bar, not a button

/**
 * Chooses how the tiles fill the card. The dashboard grid can make this card
 * any shape, so the layout is derived from the rendered box, not the
 * viewport: for every column count the width allows, the tiles get the row
 * height the card can spare (between a compact list row and a comfortable
 * card), and the arrangement that wastes the least height wins — a narrow
 * or tall card becomes a single list, a wide short card a single row, a
 * square card a small grid. Compact rows and over-wide tiles are penalised so
 * the widget prefers buttons that look like buttons. When even the compact
 * row cannot fit every action, the tightest grid the width allows shows as
 * many as possible and the rest scroll.
 */
function useTileDensity(ref: React.RefObject<HTMLDivElement | null>, count: number): TileDensity {
  const [density, setDensity] = useState<TileDensity>('compact')
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const { width, height } = el.getBoundingClientRect()
      if (width <= 0 || height <= 0 || count === 0) return
      const inner = width - PAD
      const available = height - PAD
      const maxCols = Math.max(1, Math.min(count, Math.floor((inner + GAP) / (TILE_MIN + GAP))))
      let best: { cols: number; row: number; score: number } | null = null
      for (let cols = 1; cols <= maxCols; cols++) {
        const rows = Math.ceil(count / cols)
        const row = Math.floor((available - GAP * (rows - 1)) / rows)
        if (row < ROW_MIN) continue
        const rowH = Math.min(row >= CARD_AT ? CARD_MAX : ROW_MAX, row)
        const tileW = (inner - GAP * (cols - 1)) / cols
        const waste = available - rows * rowH - GAP * (rows - 1)
        const emptyCells = rows * cols - count // a lonely last row reads as a mistake
        const score = waste + (rowH < COMFORTABLE_AT ? 32 : 0) + Math.max(0, tileW - TILE_WIDE) / 2 + emptyCells * 40
        if (!best || score < best.score) best = { cols, row: rowH, score }
      }
      if (best) {
        el.style.setProperty('--qa-cols', String(best.cols))
        el.style.setProperty('--qa-min', '0px')
        el.style.setProperty('--qa-row', `${best.row}px`)
        setDensity(best.row >= CARD_AT ? 'card' : best.row >= COMFORTABLE_AT ? 'comfortable' : 'compact')
        return
      }
      // Nothing fits: show as many compact tiles as the width allows and scroll.
      const tight = Math.max(1, Math.min(count, Math.floor((inner + GAP) / (TILE_MIN_TIGHT + GAP))))
      el.style.setProperty('--qa-cols', String(tight))
      el.style.setProperty('--qa-min', '0px')
      el.style.setProperty('--qa-row', `${ROW_MIN}px`)
      setDensity('compact')
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, count])
  return density
}

function ActionTile({ action, index, density }: { action: QuickAction; index: number; density: TileDensity }) {
  const t = useTranslations('dashboard')
  const tone = toneOf(action.tone)
  const Icon = QUICK_ACTION_ICONS[action.iconKey] ?? FALLBACK_ICON
  const external = isExternalHref(action.href)
  const comfortable = density === 'comfortable'
  const card = density === 'card'

  const inner = card ? (
    <>
      <span
        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors ${tone.chip}`}
      >
        <Icon size={19} />
      </span>
      <span
        className={`line-clamp-2 min-w-0 text-center text-[13px] leading-tight font-medium transition-colors ${tone.label}`}
      >
        {quickActionLabel(action, t)}
      </span>
      <ArrowUpRight
        size={14}
        className={`absolute top-2 right-2 translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 ${tone.arrow}`}
      />
    </>
  ) : (
    <>
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-lg transition-colors ${comfortable ? 'h-9 w-9' : 'h-7 w-7'} ${tone.chip}`}
      >
        <Icon size={comfortable ? 17 : 14} />
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-left leading-snug font-medium transition-colors ${comfortable ? 'text-sm' : 'text-[13px]'} ${tone.label}`}
      >
        {quickActionLabel(action, t)}
      </span>
      <ArrowUpRight
        size={14}
        className={`shrink-0 translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 ${tone.arrow}`}
      />
    </>
  )

  const shape = card
    ? 'relative flex-col items-center justify-center gap-2 px-3 py-3'
    : `items-center gap-2.5 ${comfortable ? 'px-3.5' : 'px-3'} py-1.5`
  const className = `group flex h-full min-h-0 w-full overflow-hidden rounded-xl border ${shape} shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none dark:focus-visible:ring-offset-slate-900 ${tone.tile}`

  return (
    <motion.div
      className="min-h-0"
      initial={{ y: 8 }}
      animate={{ y: 0 }}
      transition={{ delay: 0.04 + index * 0.035, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
    >
      {external ? (
        <a href={action.href} target="_blank" rel="noopener noreferrer" className={className}>
          {inner}
        </a>
      ) : (
        <Link href={(action.href)} className={className}>
          {inner}
        </Link>
      )}
    </motion.div>
  )
}
