'use client'

import { useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { Bookmark, BookmarkCheck } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'

export function SaveViewButton() {
  const t = useTranslations('reports.saveView')
  const tc = useTranslations('common')
  const [saved, setSaved] = useState(false)
  const pathname = usePathname()
  const searchParams = useSearchParams()

  async function save() {
    const name = prompt(t('namePrompt'))
    if (!name) return
    const params = Object.fromEntries(searchParams.entries())
    const res = await fetch('/api/saved-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: pathname, params }),
    })
    if (res.ok) {
      setSaved(true)
      toast.success(t('savedToast', { name }))
    } else {
      toast.error(t('saveFailed'))
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={save}>
      {saved ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
      {saved ? tc('feedback.saved') : t('save')}
    </Button>
  )
}
