'use client'

import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Drawer } from '@openbooks/ui'
import {
  WIDGETS,
  CATEGORY_LABELS,
  type WidgetCategory,
  type WidgetMeta,
} from './_widget-registry'
import type { RoleTier } from './_role-tier'
import { widgetsForRole } from './_widget-registry'

type LibraryCard = { id: string; name: string; description: string }

interface WidgetPaletteProps {
  role: RoleTier
  presentIds: string[] | Set<string>
  onAdd: (widget: WidgetMeta) => void
  libraryCards: LibraryCard[]
  onAddCard: (card: { id: string }) => void
  allowedWidgetIds: readonly string[] | Set<string> | undefined
  onClose: () => void
}

export function WidgetPalette({
  role,
  presentIds,
  onAdd,
  libraryCards,
  onAddCard,
  allowedWidgetIds,
  onClose,
}: WidgetPaletteProps) {
  const t = useTranslations('dashboard')
  const present = presentIds instanceof Set ? presentIds : new Set(presentIds)
  const allowed = allowedWidgetIds instanceof Set ? allowedWidgetIds : new Set(allowedWidgetIds ?? [])

  const available = widgetsForRole(role).filter(
    (w) => !present.has(w.id) && allowed.has(w.id),
  )

  const byCategory = new Map<WidgetCategory, WidgetMeta[]>()
  for (const w of available) {
    const arr = byCategory.get(w.category) ?? []
    arr.push(w)
    byCategory.set(w.category, arr)
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="sm"
      title={t('palette.title')}
      description={t('palette.subtitle')}
      bodyClassName="overflow-y-auto p-3"
    >
          {byCategory.size === 0 && libraryCards.length === 0 ? (
            <p className="px-2 py-4 text-sm text-slate-400">
              {t('palette.empty')}
            </p>
          ) : null}

          {[...byCategory.entries()].map(([cat, widgets]) => (
            <div key={cat} className="mb-4">
              <h3 className="mb-2 px-1 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                {CATEGORY_LABELS[cat]}
              </h3>
              <div className="space-y-1">
                {widgets.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => onAdd(w)}
                    className="flex w-full items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-left transition-colors hover:border-teal-300 hover:bg-teal-50/50 dark:border-slate-800 dark:hover:border-teal-700 dark:hover:bg-teal-950/30"
                  >
                    <Plus size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {w.label}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {w.description}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {libraryCards.length > 0 ? (
            <div className="mb-4">
              <h3 className="mb-2 px-1 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                {t('palette.libraryCards')}
              </h3>
              <div className="space-y-1">
                {libraryCards.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => onAddCard(c)}
                    className="flex w-full items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-left transition-colors hover:border-teal-300 hover:bg-teal-50/50 dark:border-slate-800 dark:hover:border-teal-700 dark:hover:bg-teal-950/30"
                  >
                    <Plus size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {c.name}
                      </p>
                      {c.description ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {c.description}
                        </p>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
    </Drawer>
  )
}
