'use client'

import { cn } from '@openbooks/ui'

/**
 * Shared presentational cells for /admin/apps, used by the native page and
 * the ViewSpec path alike so the two renders stay byte-identical.
 */

export function AppKeyCell({ appKey }: { appKey: string }) {
  return <code className="text-xs text-slate-500">{appKey}</code>
}

/** One tab strip for installed app workspaces and pending package review. */
export function AppWorkspaceTabs<T extends string>({ tabs, selected, onSelect, label }: {
  tabs: { key: T; label: string }[]; selected: T; onSelect: (key: T) => void; label: string
}) {
  return <div className="flex flex-wrap gap-2 border-b" role="tablist" aria-label={label}>
    {tabs.map(tab => <button key={tab.key} type="button" role="tab" aria-selected={selected === tab.key} onClick={() => onSelect(tab.key)}
      className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', selected === tab.key ? 'border-teal-500 text-teal-700 dark:text-teal-300' : 'border-transparent text-slate-500')}>
      {tab.label}
    </button>)}
  </div>
}
