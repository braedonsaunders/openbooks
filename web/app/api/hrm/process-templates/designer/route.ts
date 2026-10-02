import { z } from 'zod'
import { NextResponse } from 'next/server'
import { checklistDocumentSchema } from '@openbooks/forms-core'
import {
  getChecklistDesigner,
  getChecklistVersion,
  saveChecklistDraft,
  retireChecklistTemplate,
  publishChecklistDraft,
  previewChecklistCoverage,
} from '@openbooks/engine/hrm/processes'
import { civilDateInput } from '@/lib/api/civil-date'
import { defineRoute } from '@/lib/api/route'
import { guardPermission } from '@/lib/authz'
import { isFeatureEnabled } from '@/lib/features'
import { notFound } from '@/lib/api/responses'
import { processErrorResponse } from '../../processes/_lib'

export const runtime = 'nodejs'
const identity = { templateId: z.string().uuid(), revision: z.number().int().nonnegative() }
const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('load'), templateId: z.string().uuid() }),
  z.object({
    action: z.literal('version'),
    templateId: z.string().uuid(),
    version: z.number().int().positive(),
  }),
  z.object({ action: z.literal('save'), ...identity, document: checklistDocumentSchema }),
  z.object({
    action: z.literal('retire'),
    ...identity,
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({
    action: z.literal('publish'),
    ...identity,
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({
    action: z.literal('preview'),
    employmentId: z.string().uuid(),
    effectiveDate: civilDateInput(),
    document: checklistDocumentSchema,
  }),
])
export const POST = defineRoute({
  public: 'session',
  body: bodySchema,
  invalidBodyStatus: 400,
  handler: async ({ body }) => {
    const authz = await guardPermission('hrm.process.manage')
    if (authz instanceof NextResponse) return authz
    if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) return notFound('record')
    const context = { orgId: authz.user.orgId, actorId: authz.user.id }
    try {
      const result =
        body.action === 'save'
          ? await saveChecklistDraft({ ...context, ...body })
          : body.action === 'retire'
            ? await retireChecklistTemplate({ ...context, ...body })
            : body.action === 'publish'
              ? await publishChecklistDraft({ ...context, ...body })
              : body.action === 'load'
                ? await getChecklistDesigner({ ...context, ...body })
                : body.action === 'version'
                  ? await getChecklistVersion({ ...context, ...body })
                  : await previewChecklistCoverage({ ...context, ...body })
      return NextResponse.json(result)
    } catch (error) {
      return processErrorResponse(error)
    }
  },
})
