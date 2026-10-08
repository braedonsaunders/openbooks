import { uuidId } from "@/lib/api/json-schema"
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { payrollPeriodOpeningForEmployee, savePayrollPeriodOpening, PayrollError } from '@openbooks/engine/payroll/period-openings'
import { canonicalDecimal } from '@/lib/exact-decimal'
import { moneyRefusal } from '@/lib/payroll-decimal-refusal'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const querySchema = z.strictObject({ employeePartyId: uuidId, taxYear: z.coerce.number().int().min(2000).max(2100) })
const amount = z.string().superRefine((value, context) => {
  if (canonicalDecimal(value, 4) === null) context.addIssue({ code: 'custom', message: moneyRefusal('Period-opening amount', value) })
})
const bodySchema = z.strictObject({
  employeePartyId: uuidId, taxYear: z.number().int().min(2000).max(2100),
  subsidiaryId: uuidId, payScheduleId: uuidId, country: z.string().regex(/^[A-Z]{2}$/), currency: z.string().regex(/^[A-Z]{3}$/),
  periodStart: z.string(), periodEnd: z.string(), paidThrough: z.string(),
  amounts: z.record(z.string(), amount), sourceReference: z.string().trim().min(1).max(2000), reason: z.string().trim().min(1).max(2000),
  expectedRevision: z.number().int().positive().nullable(), expectedAnnualUpdatedAt: z.string().min(1), dryRun: z.boolean(),
})

export const GET = defineRoute({ permission: 'payroll.read', feature: 'payroll', handler: async ({ request, authz }) => {
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!query.success) return NextResponse.json({ error: 'Choose a valid employee and tax year to review period payments' }, { status: 422 })
  try {
    return NextResponse.json(await payrollPeriodOpeningForEmployee({ ...query.data, orgId: authz.user.orgId, actorId: authz.user.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }))
  } catch (error) {
    return apiErrorResponse(error, { request, ...(error instanceof PayrollError ? { safeStatus: 422 } : {}) })
  }
} })

export const POST = defineRoute({ permission: 'payroll.manage', feature: 'payroll', body: bodySchema, invalidBodyStatus: 422, handler: async ({ request, authz, body }) => {
  try {
    return NextResponse.json(await savePayrollPeriodOpening({ ...body, orgId: authz.user.orgId, actorId: authz.user.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }))
  } catch (error) {
    return apiErrorResponse(error, { request, ...(error instanceof PayrollError ? { safeStatus: 422 } : {}) })
  }
} })
