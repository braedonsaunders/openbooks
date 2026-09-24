'use client'

import { useRouter } from 'next/navigation'
import { Badge } from '@openbooks/ui'
import { ChangeRequestActions } from '../ChangeRequestActions'

/**
 * HR-16 (0227): the applied event's verb chip — renders only when the
 * loader resolved a non-apply verb; unclassified rows render nothing.
 */
export function HrmVerbChip({ label }: { label: string | null | undefined }) {
  if (!label) return null
  return <Badge variant="secondary">{label}</Badge>
}

/**
 * One row's lifecycle actions inside the shared queue table: the existing
 * ChangeRequestActions island, refreshing the loader-resolved list after
 * every transition. Terminal rows render nothing — the service owns the
 * terminal set, this island only hosts it.
 */

export function ChangeRequestRowActions({
  requestId,
  requestStatus,
  employmentId,
  appliedChangeId,
  departmentOptions,
  canManage,
}: {
  requestId: string
  requestStatus: string
  employmentId: string
  appliedChangeId?: string | null
  departmentOptions: { value: string; label: string }[]
  /** Loader-resolved manage grant — the queue table renders this island
   * only inside the gated actions column. */
  canManage: boolean
}) {
  const router = useRouter()
  return (
    <ChangeRequestActions
      request={{ id: requestId, status: requestStatus }}
      employmentId={employmentId}
      appliedChangeId={appliedChangeId ?? null}
      departmentOptions={departmentOptions}
      canManage={canManage}
      onChanged={() => router.refresh()}
    />
  )
}
