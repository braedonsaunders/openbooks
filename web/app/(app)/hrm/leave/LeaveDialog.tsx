'use client'

import { useRouter } from 'next/navigation'
import { LeaveDrawer } from './LeaveDrawer'

/**
 * Leave filing and detail entry point, opened from the page header or a row
 * through the `file`/`record`/`request` search params. Filing (requestId
 * null) opens the drawer blank; a request id opens the same drawer on the
 * detail with its TIME and VALUE balances. Closing navigates the params
 * away, which re-runs the server that owns the open state. Withdraw and
 * cancel ride the existing LeaveDrawer and API routes inside; approval
 * outcomes stay in native Approvals.
 */

export function LeaveDialog({
  requestId,
  closeHref,
}: {
  requestId: string | null
  closeHref: string
}) {
  const router = useRouter()
  return (
    <LeaveDrawer
      key={requestId ?? 'file'}
      requestId={requestId}
      onClose={() => {
        router.push(closeHref as never)
        router.refresh()
      }}
    />
  )
}
