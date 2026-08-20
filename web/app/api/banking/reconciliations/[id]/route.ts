import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  BankingError,
  discardReconciliation,
  reconciliationTotals,
} from '@openbooks/engine/src/banking.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { bankingErrorResponse } from '../../util'
import { canonicalDecimal } from '../../../../../lib/exact-decimal'

export const runtime = 'nodejs'

type Params = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Params) {
  const gate = await guardPermission('banking.read')
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
        join accounts a on a.id = r.account_id
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
  const gate = await guardPermission('banking.reconcile')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json()) as { throughDate?: string; statementBalance?: string }
  try {
    if (body.throughDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.throughDate)) {
      throw new BankingError('Through date must be YYYY-MM-DD')
    }
    if (body.statementBalance !== undefined && canonicalDecimal(body.statementBalance, 4) === null) {
      throw new BankingError('Statement balance must be a number')
    }
    const updated = (await db.execute<{ id: string }>(sql`
      update reconciliations
         set through_date = coalesce(${body.throughDate ?? null}, through_date),
             statement_balance = coalesce(${body.statementBalance ?? null}, statement_balance),
             updated_at = now(), updated_by = ${user.id}
       where id = ${id} and org_id = ${user.orgId} and status <> 'signed_off'
      returning id
    `))
    if (!updated.rows[0]) {
      return NextResponse.json({ error: 'not found or already signed off' }, { status: 404 })
    }
    const totals = await reconciliationTotals(id, { orgId: user.orgId, userId: user.id })
    return NextResponse.json({ ok: true, totals })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}

/** Discard an unsigned session — releases its matched statement lines. */
export async function DELETE(_req: Request, { params }: Params) {
  const gate = await guardPermission('banking.reconcile')
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
