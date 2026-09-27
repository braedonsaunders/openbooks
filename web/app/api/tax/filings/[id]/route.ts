import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { TaxFilingError, markTaxFilingFiled } from '@openbooks/engine/src/tax-returns/filing.ts'
import { guardUnrestrictedScope } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { TAX_FILING_WRITE_PERMISSION } from '../../../../../lib/tax-filing-permission'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

const bodyObjectSchema = z.object({ filingReference: z.string().optional() }).strict();

/** Record the one-way prepared → filed transition and government reference. */
async function legacyPATCH(req: Request, { params }: { params: Promise<{ id: string }> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  // A tax filing snapshot is an organization-wide statutory position: the
  // engine recomputes every subsidiary's ledger before certifying it. That
  // makes this an org-wide write (canonical shape 2 in
  // engine/src/organization/subsidiary-scope.ts), so a
  // subsidiary-restricted caller gets the named 403 — settled before any
  // body parsing or engine call.
  const scope = guardUnrestrictedScope(gate)
  if (scope) return scope
  const parsedBody = await parseJsonBody(req, bodyObjectSchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { filingReference?: unknown }
  const filingReference = typeof body.filingReference === 'string' ? body.filingReference.trim() : ''
  if (filingReference.length > 200) return NextResponse.json({ error: 'reference is too long' }, { status: 422 })

  try {
    const updated = await markTaxFilingFiled(gate.user.orgId, id, gate.user.id, filingReference || null)
    return NextResponse.json({ id: updated.id, filed_at: updated.filedAt })
  } catch (error) {
    if (error instanceof TaxFilingError) {
      if (error.code === 'not-found') return notFound("record")
      // Every 409 carries its machine-readable code: the drawer localizes
      // the refusal (period-not-closed names the close-the-period remedy)
      // instead of swallowing it into a generic save failure (F-x5-001).
      if (error.code === 'already-filed') {
        return NextResponse.json({ code: error.code, error: 'filing is already filed' }, { status: 409 })
      }
      // Stale or ungoverned: the state conflicts with what would be certified.
      if (error.code === 'stale' || error.code === 'period-not-closed') {
        return apiErrorResponse(error, { safeStatus: 409, details: { code: error.code } })
      }
    }
    return NextResponse.json({ error: 'could not update filing' }, { status: 422 })
  }
}

export const PATCH = defineRoute({
  permission: TAX_FILING_WRITE_PERMISSION, feature: { none: "This route is governed by its permission and service authorization." },
  params: z.object({ "id": z.string() }),
  handler: ({ request, params, authz }) => legacyPATCH(request, { params: Promise.resolve(params) }, authz),
});
