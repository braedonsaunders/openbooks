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
}: {
  invitationId: string
  respondLabel: string
  actionFailed: string
}) {
  const router = useRouter()

  async function respond() {
    const res = await fetch(`/api/hrm/surveys/invitations/${invitationId}/reissue`, { method: 'POST' })
    if (!res.ok) {
      toast.error(await readApiErrorMessage(res, actionFailed))
      return
    }
    const body = (await res.json()) as { token: string }
    router.push(`/survey/${body.token}`)
  }

  return (
    <Button variant="outline" onClick={respond}>
      {respondLabel}
    </Button>
  )
}
