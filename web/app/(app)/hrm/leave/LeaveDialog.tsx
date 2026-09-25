'use client'

import { useRouter } from 'next/navigation'
import { LeaveDrawer } from './LeaveDrawer'

/**
 * Leave filing and detail entry point, opened from the page header or a row
 * through the `file`/`record`/`request` search params. Filing (requestId
 * null) opens the drawer blank; `record` opens the absence-recording form,
 * which posts the absence route instead of filing a draft request; a
 * request id opens the same drawer on the detail with its TIME and VALUE
 * balances. Closing navigates the params away, which re-runs the server
 * that owns the open state. Withdraw and cancel ride the existing
 * LeaveDrawer and API routes inside; approval outcomes stay in native
 * Approvals.
 */

export function LeaveDialog({
  requestId,
  closeHref,
  canWithdrawCancel,
  recordOpen = false,
}: {
  requestId: string | null
  closeHref: string
  canWithdrawCancel: boolean
  recordOpen?: boolean
}) {
  const router = useRouter()
  return (
    <LeaveDrawer
      key={requestId ?? (recordOpen ? 'record' : 'file')}
      requestId={requestId}
      canWithdrawCancel={canWithdrawCancel}
      record={recordOpen && requestId === null}
      onClose={() => {
        router.push(closeHref as never)
        router.refresh()
      }}
    />
  )
}
