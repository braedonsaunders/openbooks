'use client'
import { useTranslations } from 'next-intl'
import { UnsavedCreateButton } from '@/components/unsaved-create-button'

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
  return (
    <UnsavedCreateButton
      base="/assets/equipment"
      param="equipmentNew"
      clear={['equipment']}
      label={t('new')}
      currentParams={currentParams ?? {}}
    />
  )
}
