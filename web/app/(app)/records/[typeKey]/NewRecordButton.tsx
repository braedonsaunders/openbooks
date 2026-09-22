'use client'

import { buildListDrawerHref } from '@/lib/list-params'
import { readApiErrorMessage } from '@/lib/api-error'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/** Instant-into-draft: allocates the numbered draft record server-side, opens its flyout. */
export function NewRecordButton({ typeKey, typeName, basePath, currentParams = {} }: { typeKey: string; typeName: string; basePath?: string; currentParams?: Record<string, string | string[] | undefined> }) {
  const t = useTranslations('records.module')
  const tc = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    try {
      const res = await fetch(`/api/records/${typeKey}/draft`, { method: 'POST' })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('createFailed', { typeName: typeName.toLowerCase() })))
        return
      }
      const data = await res.json()
      router.push(buildListDrawerHref(basePath ?? `/records/${typeKey}`, currentParams, 'rec', data.id))
      router.refresh()
    } catch {
      toast.error(t('createFailed', { typeName: typeName.toLowerCase() }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} />{' '}
      {busy ? tc('actions.creating') : t('newButton', { typeName: typeName.toLowerCase() })}
    </Button>
  )
}
