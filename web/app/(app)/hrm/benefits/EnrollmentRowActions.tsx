'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * Enrollment row actions inside the shared enrolments table: pending rows
 * carry the approve island for managers; every other status renders
 * nothing — the service owns the terminal set, this island only hosts it.
 * The list refreshes after the transition.
 */
export function EnrollmentRowActions({
  enrollmentId,
  enrollmentStatus,
  approveLabel,
  failedLabel,
  canManage,
}: {
  enrollmentId: string
  enrollmentStatus: string
  approveLabel: string
  failedLabel: string
  canManage: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  if (!canManage || enrollmentStatus !== 'pending_approval') return null

  async function approve() {
    // A transport failure (offline, reset connection) rejects the fetch,
    // so without a catch the row sits pending with no failure toast and
    // no sign the request never reached the server.
    if (pending) return
    setPending(true)
    try {
      const res = await fetch(`/api/hrm/enrollments/${enrollmentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, failedLabel))
        return
      }
      router.refresh()
    } catch {
      toast.error(failedLabel)
    } finally {
      setPending(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Button size="sm" variant="outline" disabled={pending} onClick={approve}>
        {approveLabel}
      </Button>
    </span>
  )
}
