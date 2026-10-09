import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { uuidId } from '@/lib/api/json'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { saveWithholdingStanding, revokeWithholdingStanding } from '@openbooks/engine/contractor-withholding'
import { withholdingRefusal } from '@/lib/contractor-withholding'
import { standingBody } from '../schema'
export const runtime = 'nodejs'
const params = z.object({ id: uuidId })
export const PATCH = defineRoute({
  permission: 'admin.setup.manage', feature: 'contractorWithholding', scope: 'unrestricted', params, body: standingBody, invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => {
    try { return NextResponse.json(await withOrgTransaction(authz.user.orgId, () => saveWithholdingStanding(db, authz.user.orgId, { ...body, id: params.id }, authz.user.id))) }
    catch (error) { return withholdingRefusal(error) }
  },
})
export const POST = defineRoute({
  permission: 'admin.setup.manage', feature: 'contractorWithholding', scope: 'unrestricted', params, body: z.object({ reason: z.string().trim().min(1).max(2000) }).strict(), invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => {
    try {
      await withOrgTransaction(authz.user.orgId, () => revokeWithholdingStanding(db, authz.user.orgId, { id: params.id, reason: body.reason }, authz.user.id))
      return NextResponse.json({ ok: true })
    } catch (error) { return withholdingRefusal(error) }
  },
})
