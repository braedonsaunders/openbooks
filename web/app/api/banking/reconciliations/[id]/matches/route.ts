import { apiErrorResponse } from '@/lib/api/error-response'
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { createMatch, unmatchStatementLine } from '@openbooks/engine/src/banking/banking.ts'
import { isUuid } from '../../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";
const POSTBodySchema1 = z.object({ statementLineIds: z.array(z.string().uuid()).min(1), journalLineIds: z.array(z.string().uuid()).min(1) });



export const runtime = 'nodejs'


/** Manual match: statement lines ↔ journal lines as one group when both sides sum alike. */
export const POST = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  body: POSTBodySchema1,
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const body = (routeBody) as { statementLineIds?: string[]; journalLineIds?: string[] }
    if (
        !Array.isArray(body.statementLineIds) ||
        body.statementLineIds.length === 0 ||
        !body.statementLineIds.every((s) => typeof s === 'string' && isUuid(s)) ||
        !Array.isArray(body.journalLineIds) ||
        body.journalLineIds.length === 0 ||
        !body.journalLineIds.every((j) => typeof j === 'string' && isUuid(j))
      ) {
        return NextResponse.json(
          { error: 'statementLineIds and journalLineIds are required, each with at least one entry' },
          { status: 400 },
        )
      }
    try {
        const totals = await createMatch(
          { reconciliationId: id, statementLineIds: body.statementLineIds, journalLineIds: body.journalLineIds },
          { orgId: user.orgId, userId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
        )
        return NextResponse.json({ ok: true, totals })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});

/** Unmatch a statement line (removes all its pairs in this session): ?statementLineId= */
export const DELETE = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    const statementLineId = new URL(req.url).searchParams.get('statementLineId')
    if (!isUuid(id) || !statementLineId || !isUuid(statementLineId)) {
        return NextResponse.json({ error: 'statementLineId required' }, { status: 400 })
      }
    try {
        const totals = await unmatchStatementLine(
          { reconciliationId: id, statementLineId },
          { orgId: user.orgId, userId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
        )
        return NextResponse.json({ ok: true, totals })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});
