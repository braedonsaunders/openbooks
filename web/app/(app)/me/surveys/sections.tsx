'use client'

import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * Me open-surveys respond island (0230, HR-19): re-mints the open
 * invitation's token in-session and navigates to the public
 * /survey/[token] page. The old link dies with the reissue; an
 * answered or closed invitation meets the refusal by name.
 */
export function MeSurveyRespond({
  invitationId,
  respondLabel,
  actionFailed,
  reissueFailed,
}: {
  invitationId: string
  respondLabel: string
  actionFailed: string
  reissueFailed: string
}) {
  const router = useRouter()

  async function respond() {
    const res = await fetch(`/api/hrm/surveys/invitations/${invitationId}/reissue`, { method: 'POST' })
    if (!res.ok) {
      toast.error(await readApiErrorMessage(res, actionFailed))
      return
    }
    // A 200 without a usable token must never navigate: /survey/undefined
    // is a dead public page, not a survey. Refuse by name instead.
    const body = (await res.json().catch(() => null)) as { token?: unknown } | null
    const token = typeof body?.token === 'string' && body.token.length > 0 ? body.token : null
    if (!token) {
      toast.error(reissueFailed)
      return
    }
    router.push(`/survey/${token}`)
  }

  return (
    <Button variant="outline" onClick={respond}>
      {respondLabel}
    </Button>
  )
}
