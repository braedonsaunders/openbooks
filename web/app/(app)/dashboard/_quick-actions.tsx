'use client'

import { useState } from 'react'
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

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
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
          {t('quickActions.customize')}
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
            className="grid h-full min-h-0 auto-rows-fr grid-cols-2 gap-2 p-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
          >
            {visibleItems.map((a, i) => (
              <ActionTile key={a.id} action={a} index={i} />
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

function ActionTile({ action, index }: { action: QuickAction; index: number }) {
  const t = useTranslations('dashboard')
  const tone = toneOf(action.tone)
  const Icon = QUICK_ACTION_ICONS[action.iconKey] ?? FALLBACK_ICON
  const external = isExternalHref(action.href)

  const inner = (
    <>
      <span
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${tone.chip}`}
      >
        <Icon size={14} />
      </span>
      <span
        className={`min-w-0 flex-1 text-left text-[13px] leading-snug font-medium transition-colors ${tone.label}`}
      >
        {quickActionLabel(action, t)}
      </span>
      <ArrowUpRight
        size={14}
        className={`shrink-0 translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100 ${tone.arrow}`}
      />
    </>
  )

  const className = `group flex h-full min-h-0 w-full items-center gap-2.5 overflow-hidden rounded-xl border px-3 py-1.5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md focus-visible:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none dark:focus-visible:ring-offset-slate-900 ${tone.tile}`

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
