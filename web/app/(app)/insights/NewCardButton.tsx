'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'

/**
 * Unsaved create: navigates to `?card=new`, which renders the card studio
 * over a blank card. Zero writes on open — POST /api/insights/cards runs
 * only on explicit Save, and Cancel/close writes nothing.
 */
export function NewCardButton() {
  const t = useTranslations('insights.cards')
  const router = useRouter()

  return (
    <Button onClick={() => router.push('/insights?card=new')}>
      <Plus size={15} /> {t('newButton')}
    </Button>
  )
}
