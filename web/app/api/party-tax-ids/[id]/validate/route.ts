import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { validateStoredTaxId } from '@openbooks/engine/src/tax/cross-border-records.ts'
import { VatValidationError } from '@openbooks/engine/src/connectors/vat-validation.ts'

export const runtime = 'nodejs'

/**
 * Validate one stored customer tax ID against its authority now. A confirmed
 * verdict persists with the consultation reference; an authority outage
 * keeps the row unverified and answers 422 naming the retry — the drawer
 * shows the outage instead of a verdict nobody confirmed.
 */
export const POST = defineRoute({
  permission: 'parties.manage',
  feature: 'crossBorderTax',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ authz: routeAuthz, params }) => {
    const gate = routeAuthz;
    try {
      const result = await withOrgTransaction(gate.user.orgId, () =>
        validateStoredTaxId(gate.user.orgId, params.id, gate.user.id),
      )
      return NextResponse.json({ ok: true, ...result })
    } catch (e: unknown) {
      if (e instanceof VatValidationError) {
        return NextResponse.json({ error: e.message }, { status: 422 })
      }
      return apiErrorResponse(e, { safeStatus: 422 })
    }
  },
});
