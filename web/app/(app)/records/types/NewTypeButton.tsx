'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'

/**
 * Unsaved create: navigates to `?type=new`, which renders the builder drawer
 * in create mode with a blank form. Zero writes on open — POST
 * /api/records/types runs only on explicit Save, and Cancel/close writes
 * nothing.
 */
export function NewTypeButton() {
  const t = useTranslations('records.types')
  const router = useRouter()

  return (
    <Button onClick={() => router.push('/records/types?type=new')}>
      <Plus size={15} /> {t('newButton')}
    </Button>
  )
}
