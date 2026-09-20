'use client'

import type { ReactNode } from 'react'

/**
 * The drawer's tab strip — one level of `role="tab"` buttons in house style.
 * Extracted from TransactionDrawer so record panels can nest a second level
 * (the employee Payroll tab's General / Tax / Pay banks / Bank accounts)
 * without inventing a second tab look or behaviour.
 */
export function DrawerTabStrip({
  tabs,
  activeKey,
  onSelect,
  ariaLabel,
}: {
  tabs: { key: string; label: ReactNode }[]
  activeKey: string
  onSelect: (key: string) => void
  ariaLabel: string
}) {
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={activeKey === tab.key}
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
