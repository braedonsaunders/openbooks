import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { runBillRun } from '../../../../lib/pre-billing'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const POSTBodySchema1 = z.object({
  periodStart: isoDate.nullable().optional(),
  periodEnd: isoDate,
  projectIds: z.array(z.string().uuid()).max(1000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const runtime = 'nodejs'

/**
 * Bill run: prepare a draft worksheet for every project with unbilled work
 * through a cutoff (or for the selected projects). Each project succeeds or
 * is skipped with its reason; the response lists both.
 */
export const POST = defineRoute({
  permission: 'projects.manage',
  feature: 'preBilling',
  body: POSTBodySchema1,
  handler: async ({ authz: gate, body }) => {
    try {
      const result = await runBillRun(gate.user.orgId, gate.user.id, {
        periodStart: body.periodStart ?? null,
        periodEnd: body.periodEnd,
        projectIds: body.projectIds ?? null,
        notes: body.notes ?? null,
      }, gate.allowedSubsidiaryIds)
      return NextResponse.json(result, { status: 201 })
    } catch (error) {
      return apiErrorResponse(error)
    }
  },
});
