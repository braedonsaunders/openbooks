'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { defaultRowsQuery, REPORT_ENTITY_MAP } from '@openbooks/reports'

/**
 * Instant-into-draft: create a real custom definition server-side (a sensible
 * default rows report over ledger lines) and open it in the builder. No
 * client-only draft that can be lost.
 */
export function NewReportButton() {
  const t = useTranslations('reports.custom.newButton')
  const tc = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function create() {
    setBusy(true)
    const query = defaultRowsQuery(REPORT_ENTITY_MAP.ledger_lines!)
    const res = await fetch('/api/reports/definitions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t('untitledName'), query }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('createFailed'))
      setBusy(false)
      return
    }
    router.push(`/reports/custom/builder/${data.definition.id}`)
    router.refresh()
    setBusy(false)
  }

  return (
    <Button onClick={create} disabled={busy}>
      <Plus size={15} /> {busy ? tc('actions.creating') : t('label')}
    </Button>
  )
}
