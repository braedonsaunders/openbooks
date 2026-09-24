'use client'

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
  if (!canManage) return null

  async function call(url: string, init: RequestInit, failed: string) {
    const res = await fetch(url, init)
    if (!res.ok) {
      toast.error(await readApiErrorMessage(res, failed))
      return
    }
    router.refresh()
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

  const buttons: Array<{ key: string; label: string; run: () => void }> = []
  if (actionKind === 'finding' && rowStatus === 'open') {
    buttons.push({ key: 'ack', label: acknowledgeLabel, run: acknowledge })
  }
  if (actionKind === 'finding' && (rowStatus === 'open' || rowStatus === 'acknowledged')) {
    buttons.push({ key: 'resolve', label: resolveLabel, run: resolve })
  }
  if (actionKind === 'entry' && rowStatus === 'computed') {
    buttons.push({ key: 'approve', label: approveLabel, run: approve })
    buttons.push({ key: 'void', label: voidLabel, run: voidEntry })
  }
  if (actionKind === 'run' && rowStatus === 'generated') {
    buttons.push({ key: 'submit', label: submitLabel, run: submit })
  }
  if (buttons.length === 0) return null

  return (
    <span className="inline-flex items-center gap-1.5">
      {buttons.map((button) => (
        <Button key={button.key} size="sm" variant="outline" onClick={button.run}>
          {button.label}
        </Button>
      ))}
    </span>
  )
}
