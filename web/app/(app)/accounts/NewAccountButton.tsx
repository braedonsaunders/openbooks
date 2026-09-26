'use client'

import { UnsavedCreateButton } from '@/components/unsaved-create-button'

export function NewAccountButton({
  currentParams,
  label,
}: {
  currentParams: Record<string, string | string[] | undefined>
  label: string
}) {
  return (
    <UnsavedCreateButton
      base="/accounts"
      param="accountNew"
      clear={['account']}
      label={label}
      currentParams={currentParams}
    />
  )
}
