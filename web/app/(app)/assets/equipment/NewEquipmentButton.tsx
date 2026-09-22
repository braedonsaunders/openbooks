'use client'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { mergeHref } from '../../../../lib/list-params'

/**
 * Unsaved create (exemplar: NewAccountButton): opening New allocates no
 * record, number, or audit row. It only navigates to the allocation-free
 * `?equipmentNew=1` drawer; the single validated insert happens on Save in
 * POST /api/equipment, which then routes to the persisted id.
 */
export function NewEquipmentButton({
  currentParams,
}: {
  currentParams?: Record<string, string | string[] | undefined>
}) {
  const t = useTranslations('assets.equipment')
  const router = useRouter()
  return (
    <Button
      onClick={() => router.push(mergeHref('/assets/equipment', currentParams ?? {}, {
        equipment: undefined,
        equipmentNew: '1',
      }) as never)}
    >
      <Plus size={15} />{t('new')}
    </Button>
  )
}
