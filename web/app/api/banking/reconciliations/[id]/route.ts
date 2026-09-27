import { apiErrorResponse } from '@/lib/api/error-response'
import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  BankingError,
  adjustReconciliation,
  discardReconciliation,
  reconciliationTotals,
} from '@openbooks/engine/src/banking/banking.ts'
import { isUuid } from '../../../../../lib/list-params'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'
import { guardSubsidiaryScope } from '../../../../../lib/authz'
import { notFound } from "@/lib/api/responses";
const PATCHBodySchema1 = z.object({ "throughDate": z.string().optional(), "statementBalance": z.string().optional() }).passthrough();



export const runtime = 'nodejs'

type Params = { params: Promise<{ id: string }> }

export const GET = defineRoute({
  permission: 'banking.read',
  feature: 'banking',
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    try {
        const rec = (await db.execute<Record<string, unknown>>(sql`
          select r.id, r.account_id, r.through_date, r.statement_balance, r.status,
                 r.signed_off_by, r.signed_off_at, r.created_at,
                 a.number as account_number, a.name as account_name,
                 a.subsidiary_id as account_subsidiary_id
            from reconciliations r
            join accounts a on a.id = r.account_id and a.org_id = r.org_id
           where r.id = ${id} and r.org_id = ${user.orgId}
        `))
        if (!rec.rows[0]) return notFound("record")
        // A session on another entity's account (or a shared account, for a
        // restricted caller) reads exactly like a missing session.
        const scoped = guardSubsidiaryScope(gate, rec.rows[0].account_subsidiary_id as string | null)
        if (scoped) return scoped
        const totals = await reconciliationTotals(id, {
          orgId: user.orgId,
          userId: user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        })
        // The ownership column gated the read; it is not part of the response shape.
        delete rec.rows[0].account_subsidiary_id
        return NextResponse.json({ reconciliation: rec.rows[0], totals })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});

/** Adjust an unsigned session's cutoff or statement balance. */
export const PATCH = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  body: PATCHBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const body = (routeBody) as { throughDate?: string; statementBalance?: string }
    try {
        if (body.throughDate !== undefined && (typeof body.throughDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.throughDate))) {
          throw new BankingError('Through date must be YYYY-MM-DD')
        }
        const statementBalance = body.statementBalance === undefined
          ? null
          : canonicalDecimal(body.statementBalance, 4)
        if (body.statementBalance !== undefined && statementBalance === null) {
          throw new BankingError('Statement balance must be a number')
        }
        const totals = await adjustReconciliation(id, {
          throughDate: body.throughDate,
          statementBalance: statementBalance ?? undefined,
        }, { orgId: user.orgId, userId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds })
        if (totals === null) {
          return notFound('record')
        }
        return NextResponse.json({ ok: true, totals })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});

/** Discard an unsigned session — releases its matched statement lines. */
export const DELETE = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  handler: async ({ request: _req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    try {
        await discardReconciliation(id, {
          orgId: user.orgId,
          userId: user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        })
        return NextResponse.json({ ok: true })
      } catch (e) {
        return apiErrorResponse(e)
      }
  },
});
