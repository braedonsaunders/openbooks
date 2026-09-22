'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { mergeHref } from '../../../lib/list-params'

/**
 * Unsaved-create: opens a URL-controlled unsaved drawer (`?entryNew=1`).
 * Zero writes on open — the journal is persisted only by the drawer's
 * explicit Save (one idempotent POST to /api/journals). No sequence or
 * document number is allocated until that Save commits.
 */
export function NewJournalButton() {
  const t = useTranslations('journal.newButton')
  const router = useRouter()
  const searchParams = useSearchParams()
  const current = Object.fromEntries(searchParams.entries())

  function open() {
    router.push(mergeHref('/journal', current, {
      entry: undefined,
      entryNew: '1',
      mode: 'edit',
    }) as never)
  }

  return (
    <Button onClick={open}>
      <Plus size={15} /> {t('label')}
    </Button>
  )
}
