import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { guardPermission } from '@/lib/authz'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { listOperatingProfileChoices } from '@openbooks/engine/src/organization/operating-profiles.ts'
export const GET = defineRoute({
  authorize: async ({ request }) => {
    const family = new URL(request.url).searchParams.get('family')
    if (family !== 'project' && family !== 'production') return NextResponse.json({ error: 'Choose project or production.' }, { status: 400 })
    return guardPermission(family === 'project' ? 'projects.read' : 'manufacturing.read')
  },
  feature: { none: 'Choices are filtered by the native work-family and capture features.' },
  params: z.object({}).strict(),
  handler: async ({ request, authz }) => {
    const query=z.strictObject({family:z.enum(['project','production']),departmentId:z.uuid().optional()}).safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) return NextResponse.json({error:'Invalid workflow filters.'},{status:422})
    const {family,departmentId}=query.data
    return withOrgTransaction(authz.user.orgId, async () => NextResponse.json({ choices: await listOperatingProfileChoices(db, authz.user.orgId, authz.user.id, family, departmentId ?? null) }))
  },
})
