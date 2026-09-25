'use client'

import { cn } from '@openbooks/ui'

/**
 * Shared presentational cells for /admin/apps, used by the native page and
 * the ViewSpec path alike so the two renders stay byte-identical.
 */

export function AppKeyCell({ appKey }: { appKey: string }) {
  return <code className="text-xs text-slate-500">{appKey}</code>
}

/**
 * One tab strip for installed app workspaces and pending package review.
 * These switch drawer content without a tabpanel or arrow-key tab behavior,
 * so they are exposed as a named group of pressed buttons rather than tabs.
 */
export function AppWorkspaceTabs<T extends string>({ tabs, selected, onSelect, label }: {
  tabs: { key: T; label: string }[]; selected: T; onSelect: (key: T) => void; label: string
}) {
  return <div className="-mb-px flex gap-1 overflow-x-auto" role="group" aria-label={label}>
    {tabs.map(tab => <button key={tab.key} type="button" aria-pressed={selected === tab.key} onClick={() => onSelect(tab.key)}
      className={cn('flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm font-medium transition-colors',
        selected === tab.key
          ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
          : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200')}>
      {tab.label}
    </button>)}
  </div>
}
