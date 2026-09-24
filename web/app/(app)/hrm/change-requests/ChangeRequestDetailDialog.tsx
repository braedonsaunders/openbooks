'use client'

import { useRouter } from 'next/navigation'
import { ChangeRequestDetailDrawer, type ChangeRequestDetailSubject } from './ChangeRequestDetailDrawer'

/**
 * Request-detail entry point for the change-request queue, opened from a
 * row's open link or the shareable `?request=<id>` URL. The loader owns the
 * open state (dialogOpen) and the return href; closing navigates the param
 * away, which re-runs the server that owns the open state. The detail (and
 * any out-of-scope refusal) rides the existing detail drawer and the
 * single-request API route inside; approval outcomes stay in native
 * Approvals.
 */

export function ChangeRequestDetailDialog({
  requestId,
  closeHref,
  subject,
  departmentOptions,
  canManage,
}: {
  requestId: string | null
  closeHref: string
  subject: ChangeRequestDetailSubject | null
  departmentOptions: { value: string; label: string }[]
  /** Loader-resolved manage grant (F3-36): the drawer's lifecycle actions
   * render only with it. */
  canManage: boolean
}) {
  const router = useRouter()
  if (!requestId) return null
  return (
    <ChangeRequestDetailDrawer
      key={requestId}
      requestId={requestId}
      subject={subject}
      departmentOptions={departmentOptions}
      canManage={canManage}
      onClose={() => {
        router.push(closeHref as never)
        router.refresh()
      }}
    />
  )
}
