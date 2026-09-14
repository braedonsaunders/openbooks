'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Label, Textarea } from '@openbooks/ui'

/** Humans state the requirement; the existing assistant owns authoring and revision. */
export function ExtensionRequest() {
  const t = useTranslations('admin.modules.request')
  const router = useRouter()
  const [brief, setBrief] = useState('')
  return <form className="space-y-5" onSubmit={event => {
    event.preventDefault()
    if (!brief.trim()) return
    router.push(`/assistant?q=${encodeURIComponent(`${t('agentInstruction')}\n\n${brief.trim()}`)}`)
  }}>
    <p className="text-sm text-slate-500">{t('help')}</p>
    <Label className="block space-y-2">{t('brief')}<Textarea rows={7} maxLength={4000} value={brief} onChange={event => setBrief(event.target.value)} placeholder={t('placeholder')} /></Label>
    <p className="text-sm text-slate-500">{t('reviewHelp')}</p>
    <p><Link className="text-sm underline" href="/docs/extensions">{t('agentHelp')}</Link></p>
    <details><summary className="text-sm text-slate-500">{t('advanced')}</summary><Link className="text-sm underline" href="/admin/modules?import=1">{t('import')}</Link></details>
    <Button type="submit" disabled={!brief.trim()}>{t('start')}</Button>
  </form>
}
