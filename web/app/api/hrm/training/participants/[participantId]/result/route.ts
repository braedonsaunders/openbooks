import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { completeTrainingParticipant } from '@openbooks/engine/hrm/training'
import { participantParams, completionBody } from '../../../contracts'
import { requireFileAccess } from '@/app/api/file-cabinet/lib'
export const POST = defineRoute({
  permission: 'hrm.certifications.manage',
  feature: 'hrmTraining',
  params: participantParams,
  body: completionBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => {
    if (body.evidenceFileId) {
      const denied = await requireFileAccess(authz, body.evidenceFileId, 'viewer')
      if (denied)
        return NextResponse.json(
          {
            error:
              'The certificate is unavailable in your File Cabinet scope — select a readable certificate or ask its owner to grant access before recording this result.',
          },
          { status: denied.status },
        )
    }
    return NextResponse.json(
      await completeTrainingParticipant({ ...params, ...body, orgId: authz.user.orgId, actorId: authz.user.id }),
    )
  },
})
