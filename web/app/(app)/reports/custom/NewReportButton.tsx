'use client'

import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'

/**
 * Unsaved create: the existing builder renders local state for the `new`
 * sentinel. Opening or cancelling allocates no definition, audit event, or
 * identifier; the builder POSTs exactly once only when Save is explicit.
 */
export function NewReportButton() {
  const t = useTranslations('reports.custom.newButton')
  const router = useRouter()

  return (
    <Button onClick={() => router.push('/reports/custom/builder/new')}>
      <Plus size={15} /> {t('label')}
    </Button>
  )
}
