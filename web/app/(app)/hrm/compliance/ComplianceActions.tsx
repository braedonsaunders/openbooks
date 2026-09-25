'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '../../../../lib/prompt'

/**
 * Compliance row actions inside the shared tables: open findings carry
 * acknowledge/resolve, computed per-diem entries carry approve/void, and
 * generated runs carry submit — every other status renders nothing. The
 * service owns the terminal set; this island only hosts it. The list
 * refreshes after every transition.
 */
export function ComplianceActions({
  actionKind,
  rowId,
  rowStatus,
  entryKind,
  canManage,
  acknowledgeLabel,
  resolveLabel,
  approveLabel,
  voidLabel,
  submitLabel,
  failedLabel,
}: {
  actionKind: 'finding' | 'entry' | 'run'
  rowId: string
  rowStatus: string
  entryKind: string
  canManage: boolean
  acknowledgeLabel: string
  resolveLabel: string
  approveLabel: string
  voidLabel: string
  submitLabel: string
  failedLabel: string
}) {
  const router = useRouter()
  // A second click while the first transition POST is in flight would
  // acknowledge/approve/submit twice: the ref drops re-entrant calls in
  // the same tick as the click, and the buttons disable while it is set.
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  if (!canManage) return null

  async function call(url: string, init: RequestInit, failed: string) {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, failed))
        return
      }
      router.refresh()
    } catch {
      // Offline or another transport failure rejects instead of
      // resolving: the refusal toast is the only evidence.
      toast.error(failed)
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  async function acknowledge() {
    await call(
      '/api/hrm/compliance/compliance-findings',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge', findingId: rowId }),
      },
      acknowledgeLabel,
    )
  }

  async function resolve() {
    const reason = await promptDialog({ title: resolveLabel, label: resolveLabel, confirmLabel: resolveLabel })
    if (!reason) return
    await call(
      '/api/hrm/compliance/compliance-findings',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', findingId: rowId, reason }),
      },
      resolveLabel,
    )
  }

  async function approve() {
    await call(
      '/api/hrm/compliance/per-diem?action=entry',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', entryId: rowId, kind: entryKind }),
      },
      failedLabel,
    )
  }

  async function voidEntry() {
    const reason = await promptDialog({ title: voidLabel, label: voidLabel, confirmLabel: voidLabel })
    if (!reason) return
    await call(
      '/api/hrm/compliance/per-diem?action=entry',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'void', entryId: rowId, kind: entryKind, reason }),
      },
      voidLabel,
    )
  }

  async function submit() {
    await call(
      '/api/hrm/compliance/certified-payroll?action=1',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'submit', runId: rowId }),
      },
      submitLabel,
    )
  }

  // Buttons render inline with direct handler references: storing the
  // ref-guarded handlers in a render-built array trips
  // react-hooks/refs (a ref-capturing closure must not ride render
  // output), while a JSX onClick reference is the exempt shape every
  // sibling island uses.
  const showAcknowledge = actionKind === 'finding' && rowStatus === 'open'
  const showResolve = actionKind === 'finding' && (rowStatus === 'open' || rowStatus === 'acknowledged')
  const showEntry = actionKind === 'entry' && rowStatus === 'computed'
  const showSubmit = actionKind === 'run' && rowStatus === 'generated'
  if (!showAcknowledge && !showResolve && !showEntry && !showSubmit) return null

  return (
    <span className="inline-flex items-center gap-1.5">
      {showAcknowledge ? (
        <Button size="sm" variant="outline" onClick={acknowledge} disabled={pending}>
          {acknowledgeLabel}
        </Button>
      ) : null}
      {showResolve ? (
        <Button size="sm" variant="outline" onClick={resolve} disabled={pending}>
          {resolveLabel}
        </Button>
      ) : null}
      {showEntry ? (
        <Button size="sm" variant="outline" onClick={approve} disabled={pending}>
          {approveLabel}
        </Button>
      ) : null}
      {showEntry ? (
        <Button size="sm" variant="outline" onClick={voidEntry} disabled={pending}>
          {voidLabel}
        </Button>
      ) : null}
      {showSubmit ? (
        <Button size="sm" variant="outline" onClick={submit} disabled={pending}>
          {submitLabel}
        </Button>
      ) : null}
    </span>
  )
}
