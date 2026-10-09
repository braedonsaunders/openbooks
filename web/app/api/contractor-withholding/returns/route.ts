import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { uuidId, isoDate } from '@/lib/api/json'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { prepareWithholdingReturn } from '@openbooks/engine/contractor-withholding'
import { withholdingRecordScope, withholdingRefusal } from '@/lib/contractor-withholding'
export const runtime = 'nodejs'
export const POST = defineRoute({
  permission: 'ap.pay', feature: 'contractorWithholding', body: z.object({ enrollmentId: uuidId, periodStart: isoDate() }).strict(), invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const denied = await withholdingRecordScope(authz, body.enrollmentId, 'enrollment')
    if (denied) return denied
    try {
      const today = await businessToday(authz.user.orgId)
      return NextResponse.json(await withOrgTransaction(authz.user.orgId, () => prepareWithholdingReturn(db, authz.user.orgId, { ...body, today }, authz.user.id)))
    } catch (error) { return withholdingRefusal(error) }
  },
})
