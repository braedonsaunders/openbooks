'use client'

/**
 * Subtab bar for the File Cabinet drawers — the same hand-rolled `role="tab"`
 * nav the transaction/document flyouts pass to UrlDrawer's `subtabs` prop, so
 * long drawers (preview + versions + sharing + activity) split into short,
 * scannable tabs instead of one runaway scroll.
 */
export interface DrawerTab {
  key: string
  label: string
}

export function DrawerTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: DrawerTab[]
  active: string
  onSelect: (key: string) => void
}) {
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Sections">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => onSelect(tab.key)}
          className={`shrink-0 border-b-2 px-3 py-3 text-sm font-medium transition-colors ${
            active === tab.key
              ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
              : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  )
}
