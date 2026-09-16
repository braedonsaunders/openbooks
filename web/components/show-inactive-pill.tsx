'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'

/**
 * Controlled twin of ShowInactivesToggle with the same pill chrome, for
 * client-side islands that filter locally instead of through a URL param
 * (the shared toggle navigates; this one just flips state).
 */
export function ShowInactivePill({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}) {
  const t = useTranslations('common')
  return (
    <label
      className={cn(
        'inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800/60',
        checked && 'border-teal-300 bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-300',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-950"
      />
      <span>{label ?? t('filters.showInactive')}</span>
    </label>
  )
}
