'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@openbooks/ui'
import { mergeHref, pickString } from '../lib/list-params'

/**
 * Shared URL-backed control for master-data lists. Active records are the
 * default; checking this adds inactive rows without replacing other filters.
 */
export function ShowInactivesToggle({
  basePath,
  currentParams,
  paramKey = 'showInactive',
  pageParamKey = 'page',
}: {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  paramKey?: string
  pageParamKey?: string
}) {
  const t = useTranslations('common.filters')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const checked = pickString(currentParams[paramKey]) === 'true'

  function change(next: boolean) {
    const href = mergeHref(basePath, currentParams, {
      [paramKey]: next ? 'true' : undefined,
      [pageParamKey]: 1,
    })
    startTransition(() => router.push(href as never))
  }

  return (
    <label
      className={cn(
        'inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800/60',
        checked && 'border-teal-300 bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-300',
        pending && 'opacity-60',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={(event) => change(event.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-950"
      />
      <span>{t('showInactive')}</span>
    </label>
  )
}
