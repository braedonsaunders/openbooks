import { z } from 'zod';
import { NextResponse } from 'next/server';
import { db } from '@openbooks/engine/src/platform/db.ts';
import { PayrollError } from '@openbooks/engine/src/payroll/error.ts';
import { payrollPriorEarningsForEmployee, savePayrollPriorEarnings } from '@openbooks/engine/src/payroll/prior-earnings.ts';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response';
import { uuidId } from '@/lib/api/json-schema';
import { canonicalDecimal } from '@/lib/exact-decimal';
import { moneyRefusal } from '@/lib/payroll-decimal-refusal';
import { accessAtLeast, fileAccessLevel } from '@/lib/file-cabinet';
import { fileViewer } from '@/app/api/file-cabinet/lib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const query = z.strictObject({ employeePartyId: uuidId, subsidiaryId: uuidId });
const amount = z.string().superRefine((value, context) => {
  if (canonicalDecimal(value, 4) === null) context.addIssue({ code: 'custom', message: moneyRefusal('Prior earning amount', value) });
});
const body = z.strictObject({
  employeePartyId: uuidId, subsidiaryId: uuidId,
  country: z.string().regex(/^[A-Z]{2}$/), currency: z.string().regex(/^[A-Z]{3}$/),
  historyFrom: z.string(), historyThrough: z.string(),
  periods: z.array(z.strictObject({
    from: z.string(), through: z.string(), sourceReference: z.string().trim().min(1).max(2000),
    lines: z.array(z.strictObject({
      sourceKey: z.string().trim().min(1).max(300), sourceLabel: z.string().trim().min(1).max(160),
      earnedFrom: z.string(), earnedThrough: z.string(),
      bucket: z.enum(['regular', 'overtime', 'vacationPay', 'holidayPay']), amount,
    })).max(2000),
  })).min(1).max(367),
  sourceFileId: uuidId, sourceVersionId: uuidId, sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceReference: z.string().trim().min(1).max(2000), reason: z.string().trim().min(1).max(2000),
  expectedRevision: z.number().int().positive().nullable(), dryRun: z.boolean(),
});

export const GET = defineRoute({ permission: 'payroll.read', feature: 'payroll', handler: async ({ request, authz }) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Choose a valid employee and legal employer to review prior earnings' }, { status: 422 });
  try {
    return NextResponse.json({ record: await payrollPriorEarningsForEmployee({ ...parsed.data,
      orgId: authz.user.orgId, actorId: authz.user.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }) });
  } catch (error) {
    return apiErrorResponse(error, { request, ...(error instanceof PayrollError ? { safeStatus: 422 } : {}) });
  }
} });

export const POST = defineRoute({ permission: 'payroll.manage', feature: 'payroll', body, invalidBodyStatus: 422, handler: async ({ request, authz, body: input }) => {
  try {
    return NextResponse.json(await savePayrollPriorEarnings({ ...input,
      orgId: authz.user.orgId, actorId: authz.user.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      authorizeFile: async fileId => accessAtLeast(await fileAccessLevel(authz.user.orgId, fileViewer(authz), fileId, db), 'viewer'),
    }));
  } catch (error) {
    return apiErrorResponse(error, { request, ...(error instanceof PayrollError ? { safeStatus: 422 } : {}) });
  }
} });
