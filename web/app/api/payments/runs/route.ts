import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { createPaymentRun } from '@openbooks/engine/src/payments.ts'
import { guardPermission } from '../../../../lib/authz'
import { paymentErrorResponse } from '../lib'

export const runtime = 'nodejs'

export async function GET() {
  const gate = await guardPermission('ap.pay')
  if (gate instanceof NextResponse) return gate

  const runs = (await db.execute(sql`
    select r.id, r.run_number, r.status, r.method, r.scheduled_for, r.exported_at, r.created_at,
           a.number as bank_number, a.name as bank_name,
           count(i.id) filter (where i.status <> 'cancelled') as instruction_count,
           coalesce(sum(i.amount) filter (where i.status <> 'cancelled'), 0) as total
      from payment_runs r
      left join accounts a on a.id = r.bank_account_id
      left join payment_instructions i on i.payment_run_id = r.id
     where r.org_id = ${gate.user.orgId}
     group by r.id, a.number, a.name
     order by r.created_at desc
     limit 200
  `)) as unknown as { rows: Record<string, unknown>[] }
  return NextResponse.json({ runs: runs.rows })
}

/** Create a payment run from selected posted, open vendor bills. */
export async function POST(req: Request) {
  const gate = await guardPermission('ap.pay')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const body = (await req.json()) as {
    bankAccountId?: string
    billDocumentIds?: string[]
    scheduledFor?: string | null
  }
  if (!body.bankAccountId) {
    return NextResponse.json({ error: 'bankAccountId is required' }, { status: 400 })
  }
  if (!Array.isArray(body.billDocumentIds) || body.billDocumentIds.length === 0) {
    return NextResponse.json({ error: 'select at least one bill' }, { status: 400 })
  }

  try {
    const run = await createPaymentRun({
      orgId: user.orgId,
      createdBy: user.id,
      bankAccountId: body.bankAccountId,
      billDocumentIds: body.billDocumentIds,
      scheduledFor: body.scheduledFor ?? null,
    })
    return NextResponse.json(run)
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
