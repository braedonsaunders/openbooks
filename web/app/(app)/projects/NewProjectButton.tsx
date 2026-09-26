'use client'

import { useTranslations } from 'next-intl'
import { UnsavedCreateButton } from '@/components/unsaved-create-button'

/**
 * Unsaved-create: opens a URL-controlled unsaved drawer (`?projectNew=1`).
 * Zero writes on open — the project is persisted only by the drawer's
 * explicit Save (one idempotent POST to /api/projects).
 */
export function NewProjectButton({ label }: { label?: string } = {}) {
  const t = useTranslations('projects')
  return (
    <UnsavedCreateButton
      base="/projects"
      param="projectNew"
      clear={['project']}
      label={label ?? t('list.newButton')}
    />
  )
}
