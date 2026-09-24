'use client'

import type { ReactNode } from 'react'

/**
 * A labelled group of pressed buttons for drawer panels. These panels do not
 * implement the tablist/tabpanel and arrow-key contract, so keep native button
 * activation and expose the selected panel as pressed instead of claiming tab semantics.
 */
export function DrawerTabStrip<T extends string>({
  tabs,
  activeKey,
  onSelect,
  ariaLabel,
}: {
  tabs: { key: T; label: ReactNode }[]
  activeKey: T
  onSelect: (key: T) => void
  ariaLabel: string
}) {
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          aria-pressed={activeKey === tab.key}
          onClick={() => onSelect(tab.key)}
          className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
            activeKey === tab.key
              ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
              : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )
}
