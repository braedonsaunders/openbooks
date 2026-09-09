import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  BankingError,
  adjustReconciliation,
  discardReconciliation,
  reconciliationTotals,
} from '@openbooks/engine/src/banking.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { bankingErrorResponse } from '../../util'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'

export const runtime = 'nodejs'

type Params = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Params) {
  const gate = await guardFeaturePermission('banking.read', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    const rec = (await db.execute<Record<string, unknown>>(sql`
      select r.id, r.account_id, r.through_date, r.statement_balance, r.status,
             r.signed_off_by, r.signed_off_at, r.created_at,
             a.number as account_number, a.name as account_name
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${id} and r.org_id = ${user.orgId}
    `))
    if (!rec.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const totals = await reconciliationTotals(id, { orgId: user.orgId, userId: user.id })
    return NextResponse.json({ reconciliation: rec.rows[0], totals })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}

/** Adjust an unsigned session's cutoff or statement balance. */
export async function PATCH(req: Request, { params }: Params) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { throughDate?: string; statementBalance?: string }
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
    }, { orgId: user.orgId, userId: user.id })
    if (totals === null) {
      return NextResponse.json({ error: 'not found or already signed off' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, totals })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}

/** Discard an unsigned session — releases its matched statement lines. */
export async function DELETE(_req: Request, { params }: Params) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  try {
    await discardReconciliation(id, { orgId: user.orgId, userId: user.id })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
