'use client'

import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'

/**
 * Unsaved create: navigates to `?view=new`, which renders the view studio
 * over a blank view. Zero writes on open — POST /api/views runs only on
 * explicit Save, and Cancel/close writes nothing.
 */
export function NewViewButton() {
  const t = useTranslations('knowledge.views')
  const router = useRouter()

  return (
    <Button onClick={() => router.push('/knowledge/views?view=new')}>
      <Plus size={16} /> {t('new')}
    </Button>
  )
}
