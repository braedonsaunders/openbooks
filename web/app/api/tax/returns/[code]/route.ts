import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { computeTaxReturn } from '@openbooks/engine/src/tax-returns/return.ts'
import { guardSubsidiaryScope } from '../../../../../lib/authz'
import { parseReturnScopeQuery, returnScopeOpts } from '@/lib/tax-return-scope'
import { AdjustmentParamError, parseAdjustments } from './tax-return-params'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** One filing entity's return, or the translated consolidated view: `subsidiary`
 *  (repeat or comma-separated) scopes to the entity's subsidiaries,
 *  `registration` pins the registration, and `presentationCurrency` (+ optional
 *  `rateType`/`rateDate`) declares the translation policy. Restricted callers
 *  keep the historical org-wide denial unless every requested subsidiary is
 *  inside their allowed set. */
async function legacyGET(req: Request, { params }: { params: Promise<{ code: string }> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const { code } = await params
  const p = new URL(req.url).searchParams
  const from = p.get('from')
  const to = p.get('to')
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from and to dates (YYYY-MM-DD) are required' }, { status: 422 })
  }
  // Scope + translation parse exactly as the prepare POST does (shared
  // parser): a scope the preview accepts but prepare rejects would strand
  // the filer between two disagreeing surfaces.
  const parsed = parseReturnScopeQuery(p)
  if (parsed.error || !parsed.scope) {
    return NextResponse.json({ error: parsed.error ?? 'invalid scope' }, { status: 422 })
  }
  const { subsidiaryIds } = parsed.scope
  if (subsidiaryIds.length > 0) {
    for (const id of subsidiaryIds) {
      const denied = guardSubsidiaryScope(gate, id)
      if (denied) return denied
    }
  } else {
    const scopeDenied = guardSubsidiaryScope(gate, null)
    if (scopeDenied) return scopeDenied
  }
  let adjustments: Record<string, string>
  try {
    adjustments = parseAdjustments(p)
  } catch (e: unknown) {
    if (e instanceof AdjustmentParamError) {
      return apiErrorResponse(e, { safeStatus: 400 })
    }
    throw e
  }
  try {
    const result = await computeTaxReturn(gate.user.orgId, code, from, to, adjustments, returnScopeOpts(parsed.scope))
    return NextResponse.json(result)
  } catch (e: unknown) {
    return apiErrorResponse(e, { safeStatus: 422 })
  }
}

export const GET = defineRoute({
  permission: 'reports.read', feature: { none: "This route is governed by its permission and service authorization." },
  params: z.object({ "code": z.string() }),
  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});
