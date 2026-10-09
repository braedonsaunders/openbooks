import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { saveWithholdingStanding } from '@openbooks/engine/contractor-withholding'
import { withholdingRefusal } from '@/lib/contractor-withholding'
import { standingBody } from './schema'
export const runtime = 'nodejs'
export const POST = defineRoute({
  permission: 'admin.setup.manage', feature: 'contractorWithholding', scope: 'unrestricted', body: standingBody, invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    try {
      const created = await withOrgTransaction(authz.user.orgId, () => saveWithholdingStanding(db, authz.user.orgId, body, authz.user.id))
      return NextResponse.json(created, { status: 201 })
    } catch (error) { return withholdingRefusal(error) }
  },
})
