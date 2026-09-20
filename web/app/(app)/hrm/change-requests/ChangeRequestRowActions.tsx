'use client'

import { useRouter } from 'next/navigation'
import { ChangeRequestActions } from '../ChangeRequestActions'

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
  departmentOptions,
}: {
  requestId: string
  requestStatus: string
  employmentId: string
  departmentOptions: { value: string; label: string }[]
}) {
  const router = useRouter()
  return (
    <ChangeRequestActions
      request={{ id: requestId, status: requestStatus }}
      employmentId={employmentId}
      departmentOptions={departmentOptions}
      onChanged={() => router.refresh()}
    />
  )
}
