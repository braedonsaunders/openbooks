'use client'

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
  canManage,
}: {
  enrollmentId: string
  enrollmentStatus: string
  approveLabel: string
  canManage: boolean
}) {
  const router = useRouter()
  if (!canManage || enrollmentStatus !== 'pending_approval') return null

  async function approve() {
    const res = await fetch(`/api/hrm/enrollments/${enrollmentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    })
    if (!res.ok) {
      toast.error(await readApiErrorMessage(res, approveLabel))
      return
    }
    router.refresh()
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Button size="sm" variant="outline" onClick={approve}>
        {approveLabel}
      </Button>
    </span>
  )
}
