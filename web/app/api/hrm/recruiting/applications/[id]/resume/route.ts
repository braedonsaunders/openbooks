import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { getApplicationWorkspace } from '@openbooks/engine/hrm/recruiting'
import { getFileBlob } from '@/lib/file-cabinet'
import { blobResponse } from '@/lib/blob-response'
import { isMaskedFileContentError } from '@/lib/file-storage'
import { apiErrorResponse } from '@/lib/api/error-response'
import { isUuid } from '@/lib/list-params'
import { recruitingErrorResponse } from '../../../_lib'
export const runtime = 'nodejs'
/** Access to resume evidence derives from this scoped application, then the file ACL. */
export const GET = defineRoute({
  permission: 'hrm.recruiting.read',
  feature: 'hrmRecruiting',
  params: z.object({ id: z.string().refine(isUuid) }),
  handler: async ({ authz, params, request }) => {
    try {
      const workspace = await getApplicationWorkspace({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        applicationId: params.id,
      })
      const fileId = workspace.candidate.resumeAttachmentId
      if (!fileId)
        return NextResponse.json(
          { error: 'The resume is not available for this application.' },
          { status: 404 },
        )
      const blob = await getFileBlob(authz.user.orgId, fileId, {
        userId: authz.user.id,
        isAdmin: false,
        baseline: 'viewer',
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      })
      if (!blob)
        return NextResponse.json(
          {
            error:
              'The resume is not available. Ask the recruiting administrator to check its file access.',
          },
          { status: 404 },
        )
      return blobResponse(request, blob)
    } catch (error) {
      if (isMaskedFileContentError(error))
        return apiErrorResponse(error, { safeStatus: 403 })
      return recruitingErrorResponse(error)
    }
  },
})
