import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { guardUnrestrictedScope } from '@/lib/authz'
import { saveOrgChartLayout } from '@openbooks/engine/src/hrm/org-chart-layout.ts'
import { saveOrgChartLayoutSchema } from '@openbooks/engine/src/hrm/org-chart-layout-schema.ts'
import { hrmDocumentsErrorResponse } from '../../documents/_lib'

export const PUT = defineRoute({
  permission: 'hrm.employment.manage',
  feature: 'hrm',
  body: saveOrgChartLayoutSchema,
  handler: async ({ body, authz }) => {
    const refusal = guardUnrestrictedScope(authz)
    if (refusal) return refusal
    try {
      const layout = await saveOrgChartLayout({ orgId: authz.user.orgId, actorId: authz.user.id, ...body })
      return NextResponse.json({ layout })
    } catch (error) { return hrmDocumentsErrorResponse(error) }
  },
})
