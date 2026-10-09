import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { uuidId } from '@/lib/api/json'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { listWithholdingPeriods } from '@openbooks/engine/contractor-withholding'
import { withholdingEnrollments, withholdingRecordScope, withholdingRefusal } from '@/lib/contractor-withholding'
export const runtime = 'nodejs'
export const GET = defineRoute({
  permission: 'ap.read', feature: 'contractorWithholding',
  handler: async ({ authz, request }) => {
    const raw = new URL(request.url).searchParams.get('enrollmentId')
    if (!raw) return NextResponse.json({ enrollments: await withholdingEnrollments(authz) })
    const parsed = uuidId.safeParse(raw)
    if (!parsed.success) return NextResponse.json({ error: 'Invalid enrollment identifier.' }, { status: 422 })
    const denied = await withholdingRecordScope(authz, parsed.data, 'enrollment')
    if (denied) return denied
    try { return NextResponse.json({ periods: await withOrgTransaction(authz.user.orgId, () => listWithholdingPeriods(db, authz.user.orgId, parsed.data)) }) }
    catch (error) { return withholdingRefusal(error) }
  },
})
