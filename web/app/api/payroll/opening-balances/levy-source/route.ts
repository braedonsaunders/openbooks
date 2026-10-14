import { z } from 'zod';
import { NextResponse } from 'next/server';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response';
import { uuidId } from '@/lib/api/json-schema';
import { PayrollError } from '@openbooks/engine/payroll/error';
import { qualifyOpeningLevySourceAuthority, readOpeningLevySourceContext } from '@openbooks/engine/payroll/opening-levy-source-authority';

export const dynamic = 'force-dynamic';
const query = z.strictObject({
  employeePartyId: uuidId,
  taxYear: z.string().regex(/^\d{4}$/).transform(Number),
});
const allocation = z.strictObject({
  programKey: z.enum(['ca_wcb','ca_eht','ca_cnt','us_futa','us_sui','us_pa_lst']),
  region: z.string().trim().min(2).max(2),
  subRegion: z.string().trim().max(32).optional(),
  filingAccountId: uuidId.nullable().optional(),
  amount: z.string().trim().min(1).max(40),
});
const body = z.strictObject({
  openingBalanceId: uuidId,
  expectedOpeningSha256: z.string().regex(/^[a-f0-9]{64}$/),
  allocations: z.array(allocation).min(1).max(1000),
  reason: z.string().trim().min(1).max(2000),
});

export const GET = defineRoute({ permission: 'payroll.read', feature: 'payroll', handler: async ({ request, authz }) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Choose a native employee and opening year' }, { status: 422 });
  try {
    return NextResponse.json(await readOpeningLevySourceContext({
      ...parsed.data, orgId: authz.user.orgId, actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    }));
  } catch (error) {
    return apiErrorResponse(error, { request, ...(error instanceof PayrollError ? { safeStatus: 422 } : {}) });
  }
} });

export const POST = defineRoute({ permission: 'payroll.run', feature: 'payroll', body, invalidBodyStatus: 422, handler: async ({ request, authz, body: input }) => {
  try {
    const record = await qualifyOpeningLevySourceAuthority({
      ...input, orgId: authz.user.orgId, actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    return NextResponse.json({ record });
  } catch (error) {
    return apiErrorResponse(error, { request, ...(error instanceof PayrollError ? { safeStatus: 422 } : {}) });
  }
} });
