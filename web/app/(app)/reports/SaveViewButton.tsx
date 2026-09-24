'use client'

import { useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { Bookmark, BookmarkCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'
import { promptDialog } from '../../../lib/prompt'

export function SaveViewButton() {
  const t = useTranslations('reports.saveView')
  const tc = useTranslations('common')
  const [saved, setSaved] = useState(false)
  const pathname = usePathname()
  const searchParams = useSearchParams()

  async function save() {
    const name = await promptDialog({ title: t('namePrompt') })
    if (!name) return
    const params = Object.fromEntries(searchParams.entries())
    const res = await fetch('/api/saved-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: pathname, params }),
    })
    // The status is checked before any body is trusted: the server's named
    // refusal wins over the generic fallback.
    if (!res.ok) {
      toast.error(await readApiErrorMessage(res, t('saveFailed')))
      return
    }
    setSaved(true)
    toast.success(t('savedToast', { name }))
  }

  return (
    <Button variant="outline" size="sm" onClick={save}>
      {saved ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
      {saved ? tc('feedback.saved') : t('save')}
    </Button>
  )
}
