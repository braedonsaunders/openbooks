'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { mergeHref } from '../../../lib/list-params'

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
  const router = useRouter()
  return (
    <Button
      onClick={() => router.push(mergeHref('/assets', currentParams, {
        asset: undefined,
        assetNew: '1',
      }) as never)}
    >
      <Plus size={15} /> {label ?? t('list.newButton')}
    </Button>
  )
}
