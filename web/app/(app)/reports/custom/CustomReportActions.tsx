'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
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
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function clone() {
    setBusy(true)
    const res = await fetch(`/api/reports/definitions/${id}`)
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? 'Could not load report')
      setBusy(false)
      return
    }
    const def = data.definition
    const created = await fetch('/api/reports/definitions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${def.name} (copy)`,
        description: def.description,
        query: def.query,
        layout: def.layout,
      }),
    })
    const createdData = await created.json()
    if (!created.ok) {
      toast.error(createdData.error ?? 'Could not clone report')
      setBusy(false)
      return
    }
    toast.success('Report cloned')
    router.push(`/reports/custom/builder/${createdData.definition.id}`)
    router.refresh()
    setBusy(false)
  }

  async function remove() {
    const ok = await confirmDialog({
      message: 'Delete this report? Its schedules and run history are removed too.',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch(`/api/reports/definitions/${id}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) toast.error(data.error ?? 'Could not delete report')
    else toast.success('Report deleted')
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button variant="outline" size="sm" asChild>
        <Link href={`/reports/custom/run/${id}`}>Run</Link>
      </Button>
      {canCreate ? (
        <>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/reports/custom/builder/${id}`}>Edit</Link>
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={clone}>
            Clone
          </Button>
          {kind === 'custom' ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={remove}>
              Delete
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
