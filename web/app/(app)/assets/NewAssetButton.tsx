'use client'

import { useTranslations } from 'next-intl'
import { UnsavedCreateButton } from '@/components/unsaved-create-button'

/**
 * Unsaved create (exemplar: NewAccountButton): opening New allocates no
 * record, number, category, or audit row. It only navigates to the
 * allocation-free `?assetNew=1` drawer; the single validated insert happens
 * on Save in POST /api/assets, which then routes to the persisted id.
 */
export function NewAssetButton({
  currentParams,
  label,
}: {
  currentParams: Record<string, string | string[] | undefined>
  label?: string
}) {
  const t = useTranslations('assets')
  return (
    <UnsavedCreateButton
      base="/assets"
      param="assetNew"
      clear={['asset']}
      label={label ?? t('list.newButton')}
      currentParams={currentParams}
    />
  )
}
