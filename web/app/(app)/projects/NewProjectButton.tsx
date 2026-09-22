'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { mergeHref } from '../../../lib/list-params'

/**
 * Unsaved-create: opens a URL-controlled unsaved drawer (`?projectNew=1`).
 * Zero writes on open — the project is persisted only by the drawer's
 * explicit Save (one idempotent POST to /api/projects).
 */
export function NewProjectButton({ label }: { label?: string } = {}) {
  const t = useTranslations('projects')
  const router = useRouter()
  const searchParams = useSearchParams()
  const current = Object.fromEntries(searchParams.entries())

  function open() {
    router.push(mergeHref('/projects', current, {
      project: undefined,
      projectNew: '1',
    }) as never)
  }

  return (
    <Button onClick={open}>
      <Plus size={15} /> {label ?? t('list.newButton')}
    </Button>
  )
}
