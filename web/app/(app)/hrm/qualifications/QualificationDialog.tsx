'use client'

import { useRouter } from 'next/navigation'
import { QualificationDrawer } from './QualificationDrawer'

/**
 * Qualification record and detail entry point, opened from the page
 * header or a row through the `record`/`qualification` search params.
 * Recording opens the drawer blank; a qualification id opens the same
 * drawer on the detail with its derived status, evidence, and events.
 * Closing navigates the params away, which re-runs the server that owns
 * the open state. Verify, renew, revoke and evidence ride the drawer
 * and API routes inside.
 */

export function QualificationDialog({
  qualificationId,
  recordOpen,
  closeHref,
  canManage,
}: {
  qualificationId: string | null
  recordOpen: boolean
  closeHref: string
  /** Loader-resolved manage grant (F3-37): Verify, Renew and Revoke render
   * only with it. */
  canManage: boolean
}) {
  const router = useRouter()
  return (
    <QualificationDrawer
      key={qualificationId ?? 'record'}
      qualificationId={qualificationId}
      recordOpen={recordOpen}
      canManage={canManage}
      onClose={() => {
        router.push(closeHref as never)
        router.refresh()
      }}
    />
  )
}
