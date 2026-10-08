'use client'

import type { ReactNode } from 'react'
import { useOwnTabBaseline, useSwitchView } from '@openbooks/ui'

/**
 * A labelled group of pressed buttons for drawer panels. These panels do not
 * implement the tablist/tabpanel and arrow-key contract, so keep native button
 * activation and expose the selected panel as pressed instead of claiming tab semantics.
 * A selection is a view switch: the enclosing drawer's body animates like a
 * page change while the page and any drawer beneath it stay still.
 * Nested in a drawer body the strip draws its own baseline and spacing, so
 * the active underline never runs into the content below; the drawer's
 * header row and page layouts frame their strips themselves.
 */
export function DrawerTabStrip<T extends string>({
  tabs,
  activeKey,
  onSelect,
  ariaLabel,
}: {
  tabs: { key: T; label: ReactNode; count?: number; disabled?: boolean }[]
  activeKey: T
  onSelect: (key: T) => void
  ariaLabel: string
}) {
  const switchView = useSwitchView()
  const ownBaseline = useOwnTabBaseline()
  const strip = (
    <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          disabled={tab.disabled}
          aria-pressed={activeKey === tab.key}
          onClick={() => switchView(() => onSelect(tab.key))}
          className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            activeKey === tab.key
              ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
              : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200'
          }`}
        >
          {tab.label}
          {typeof tab.count === 'number' ? <span className="rounded-full bg-slate-100 px-1.5 text-xs tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400">{tab.count}</span> : null}
        </button>
      ))}
    </nav>
  )
  return ownBaseline ? <div className="mb-4 border-b border-slate-200 dark:border-slate-800">{strip}</div> : strip
}
