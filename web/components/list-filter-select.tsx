'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Select } from '@openbooks/ui'
import { mergeHref, pickString } from '../lib/list-params'

/**
 * Shared URL-backed enum filter for list pages: a small select bound to one
 * query param, blank = no filter. Changing it resets pagination, matching the
 * ShowInactivesToggle contract.
 */
export function ListFilterSelect({
  basePath,
  currentParams,
  paramKey,
  label,
  allLabel,
  options,
  pageParamKey = 'page',
}: {
  basePath: string
  currentParams: Record<string, string | string[] | undefined>
  paramKey: string
  label: string
  allLabel: string
  options: { value: string; label: string }[]
  pageParamKey?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const current = pickString(currentParams[paramKey]) ?? ''

  return (
    <label className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
      <span className="whitespace-nowrap">{label}</span>
      <Select
        value={current}
        disabled={pending}
        className="h-8 w-auto min-w-32"
        onChange={(event) => {
          const next = event.target.value
          const href = mergeHref(basePath, currentParams, {
            [paramKey]: next || undefined,
            [pageParamKey]: 1,
          })
          startTransition(() => router.push(href as never))
        }}
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  )
}
