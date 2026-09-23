'use client'

import { useTranslations } from 'next-intl'
import type { PageLayoutSaveState } from './use-page-layout'

/**
 * Saved/unsaved indicator for the per-user page-layout hook. Saving reads
 * "Saving…"; a failure keeps the unsaved changes pending and shows the
 * server's named refusal with an explicit retry — the layout never silently
 * rolls back to the last saved state. Saved renders nothing.
 */
export function LayoutSaveStatus({
  saveState,
  saveError,
  onRetry,
}: {
  saveState: PageLayoutSaveState
  saveError: string | null
  onRetry: () => void
}) {
  const t = useTranslations('common')
  if (saveState === 'saved') return null
  if (saveState === 'saving') {
    return (
      <span aria-live="polite" className="text-xs text-slate-400 dark:text-slate-500">
        {t('actions.saving')}
      </span>
    )
  }
  return (
    <span role="alert" className="inline-flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
      <span>
        {t('feedback.saveFailed')}
        {saveError ? `: ${saveError}` : ''}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="font-semibold underline underline-offset-2 hover:text-red-700 dark:hover:text-red-300"
      >
        {t('actions.retry')}
      </button>
    </span>
  )
}
