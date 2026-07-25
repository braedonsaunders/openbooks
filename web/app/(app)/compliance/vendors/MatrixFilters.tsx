'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Select } from '@openbooks/ui'
import type { ComplianceClassRow } from '../../../../lib/compliance'

/**
 * Matrix filters. URL-state, not component-state: the filtered grid is a link
 * someone pastes into an email to a project manager.
 */
export function MatrixFilters({
  classes,
  classId,
  state,
}: {
  classes: ComplianceClassRow[]
  classId: string | null
  state: string | null
}) {
  const t = useTranslations('compliance')
  const router = useRouter()
  const params = useSearchParams()

  function set(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    // A filter change invalidates whichever vendor was open underneath it.
    next.delete('vendor')
    router.push(`/compliance/vendors${next.toString() ? `?${next}` : ''}`)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        aria-label={t('vendors.filters.class')}
        value={classId ?? ''}
        onChange={(event) => set('class', event.target.value)}
        className="w-48"
      >
        <option value="">{t('vendors.filters.allClasses')}</option>
        {classes.map((cls) => (
          <option key={cls.id} value={cls.id}>
            {cls.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label={t('vendors.filters.state')}
        value={state ?? ''}
        onChange={(event) => set('state', event.target.value)}
        className="w-48"
      >
        <option value="">{t('vendors.filters.allStates')}</option>
        <option value="attention">{t('vendors.filters.attention')}</option>
        <option value="expiring">{t('vendors.filters.expiring')}</option>
      </Select>
    </div>
  )
}
