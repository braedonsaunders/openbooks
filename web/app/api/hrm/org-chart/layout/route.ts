import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { saveOrgChartLayout } from '@openbooks/engine/hrm/org-chart'
import { saveOrgChartLayoutSchema } from '@openbooks/engine/hrm/org-chart/contracts'
import { hrmDocumentsErrorResponse } from '../../documents/_lib'

export const runtime = 'nodejs'

export const PUT = defineRoute({
  permission: 'hrm.employment.manage',
  feature: 'hrm',
  scope: 'unrestricted',
  body: saveOrgChartLayoutSchema,
  maxBodyBytes: 8 * 1024 * 1024,
  handler: async ({ body, authz }) => {
    try {
      const layout = await saveOrgChartLayout({ orgId: authz.user.orgId, actorId: authz.user.id, ...body })
      return NextResponse.json({ layout })
    } catch (error) { return hrmDocumentsErrorResponse(error) }
  },
})
