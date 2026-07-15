'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { FolderPlus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'

export function NewFolderButton({ parentId }: { parentId?: string }) {
  const t = useTranslations('documents')
  const router = useRouter()
  const search = useSearchParams()

  function open() {
    const params = new URLSearchParams(search.toString())
    params.set('folder', 'new')
    params.delete('page')
    router.push(`/documents?${params.toString()}`)
  }

  return (
    <Button variant="outline" onClick={open}>
      <FolderPlus className="h-4 w-4" />
      {t('actions.newFolder')}
    </Button>
  )
}
