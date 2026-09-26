'use client'

import { useTranslations } from 'next-intl'
import { UnsavedCreateButton } from '@/components/unsaved-create-button'

/**
 * Unsaved-create: opens a URL-controlled unsaved drawer (`?entryNew=1`).
 * Zero writes on open — the journal is persisted only by the drawer's
 * explicit Save (one idempotent POST to /api/journals). No sequence or
 * document number is allocated until that Save commits.
 */
export function NewJournalButton() {
  const t = useTranslations('journal.newButton')
  return (
    <UnsavedCreateButton
      base="/journal"
      param="entryNew"
      clear={['entry']}
      label={t('label')}
      extra={{ mode: 'edit' }}
    />
  )
}
