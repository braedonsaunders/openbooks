import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { uuidId, isoDate } from '@/lib/api/json'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { createWithholdingDeposit, listWithholdingDeposits } from '@openbooks/engine/contractor-withholding'
import { withholdingRecordScope, withholdingRefusal } from '@/lib/contractor-withholding'
export const runtime = 'nodejs'
export const GET = defineRoute({
  permission: 'ap.read', feature: 'contractorWithholding',
  handler: async ({ authz, request }) => {
    const query = z.object({ enrollmentId: uuidId }).strict().safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) return NextResponse.json({ error: 'Choose a withholding enrollment.' }, { status: 422 })
    const denied = await withholdingRecordScope(authz, query.data.enrollmentId, 'enrollment')
    if (denied) return denied
    try { return NextResponse.json({ deposits: await listWithholdingDeposits(db, authz.user.orgId, query.data.enrollmentId) }) }
    catch (error) { return withholdingRefusal(error) }
  },
})
export const POST = defineRoute({
  permission: 'ap.pay', feature: 'contractorWithholding',
  body: z.object({ enrollmentId: uuidId, throughDate: isoDate(), amendsDocumentId: uuidId.optional() }).strict(), invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const denied = await withholdingRecordScope(authz, body.enrollmentId, 'enrollment')
    if (denied) return denied
    try { return NextResponse.json(await withOrgTransaction(authz.user.orgId, () => createWithholdingDeposit(db, authz.user.orgId, body, authz.user.id))) }
    catch (error) { return withholdingRefusal(error) }
  },
})
