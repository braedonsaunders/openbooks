'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'

/**
 * Row actions for a report definition: run/view, edit in the builder, clone
 * (built-ins are clone-only), delete (custom only). Deletes are confirmed.
 */
export function CustomReportActions({
  id,
  kind,
  canCreate,
}: {
  id: string
  kind: 'built_in' | 'custom'
  canCreate: boolean
}) {
  const t = useTranslations('reports.custom.actions')
  const tc = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function clone() {
    setBusy(true)
    const res = await fetch(`/api/reports/definitions/${id}`)
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('loadFailed'))
      setBusy(false)
      return
    }
    const def = data.definition
    const created = await fetch('/api/reports/definitions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: t('copyName', { name: def.name }),
        description: def.description,
        query: def.query,
        layout: def.layout,
      }),
    })
    const createdData = await created.json()
    if (!created.ok) {
      toast.error(createdData.error ?? t('cloneFailed'))
      setBusy(false)
      return
    }
    toast.success(t('cloned'))
    router.push(`/reports/custom/builder/${createdData.definition.id}`)
    router.refresh()
    setBusy(false)
  }

  async function remove() {
    const ok = await confirmDialog({
      message: t('deleteConfirm'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch(`/api/reports/definitions/${id}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) toast.error(data.error ?? t('deleteFailed'))
    else toast.success(t('deleted'))
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button variant="outline" size="sm" asChild>
        <Link href={`/reports/custom/run/${id}`}>{t('run')}</Link>
      </Button>
      {canCreate ? (
        <>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/reports/custom/builder/${id}`}>{tc('actions.edit')}</Link>
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={clone}>
            {t('clone')}
          </Button>
          {kind === 'custom' ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={remove}>
              {tc('actions.delete')}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
